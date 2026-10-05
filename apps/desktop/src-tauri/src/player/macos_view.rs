//! AppKit view that hosts the mpv OpenGL surface and forwards mouse and
//! keyboard input to mpv, so mpv's own on-screen controller (OSC) and default
//! key bindings drive playback.

use super::{Input, WorkerCommand};
use objc2::rc::Retained;
use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSEvent, NSEventModifierFlags, NSResponder, NSTrackingArea,
    NSTrackingAreaOptions, NSView, NSWindow,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSRect};
use std::cell::Cell;
use std::sync::mpsc;
use std::time::Duration;
use tauri::AppHandle;

/// Trackpads report pixel deltas; this many points equal one wheel notch.
const PRECISE_SCROLL_STEP: f64 = 24.0;

pub struct PlayerViewIvars {
    sender: mpsc::Sender<WorkerCommand>,
    scroll: Cell<f64>,
}

define_class!(
    // SAFETY: NSView has no subclassing requirements and PlayerView does not
    // implement Drop.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TJXYPlayerView"]
    #[ivars = PlayerViewIvars]
    pub struct PlayerView;

    unsafe impl NSObjectProtocol for PlayerView {}

    impl PlayerView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            true
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, event: &NSEvent) {
            self.send_position(event);
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            self.send_position(event);
        }

        #[unsafe(method(rightMouseDragged:))]
        fn right_mouse_dragged(&self, event: &NSEvent) {
            self.send_position(event);
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            self.send_button(event, "MBTN_LEFT", true);
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            self.send_button(event, "MBTN_LEFT", false);
        }

        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, event: &NSEvent) {
            self.send_button(event, "MBTN_RIGHT", true);
        }

        #[unsafe(method(rightMouseUp:))]
        fn right_mouse_up(&self, event: &NSEvent) {
            self.send_button(event, "MBTN_RIGHT", false);
        }

        #[unsafe(method(otherMouseDown:))]
        fn other_mouse_down(&self, event: &NSEvent) {
            self.send_button(event, "MBTN_MID", true);
        }

        #[unsafe(method(otherMouseUp:))]
        fn other_mouse_up(&self, event: &NSEvent) {
            self.send_button(event, "MBTN_MID", false);
        }

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            let step = if event.hasPreciseScrollingDeltas() { PRECISE_SCROLL_STEP } else { 1.0 };
            let total = self.ivars().scroll.get() + event.scrollingDeltaY();
            let notches = (total / step).trunc();
            self.ivars().scroll.set(total - notches * step);
            let key = if notches > 0.0 { "WHEEL_UP" } else { "WHEEL_DOWN" };
            for _ in 0..(notches.abs() as usize).min(8) {
                self.send(Input::Key(key.into()));
            }
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            if let Some(key) = mpv_key(event) {
                self.send(Input::Key(key));
            }
        }
    }
);

impl PlayerView {
    fn new(mtm: MainThreadMarker, frame: NSRect, sender: mpsc::Sender<WorkerCommand>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(PlayerViewIvars {
            sender,
            scroll: Cell::new(0.0),
        });
        // SAFETY: initWithFrame: is NSView's designated initializer.
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }

    fn send(&self, input: Input) {
        // The worker is gone once playback shuts down; dropping input then is fine.
        let _ = self.ivars().sender.send(WorkerCommand::Input(input));
    }

    fn send_position(&self, event: &NSEvent) {
        let point = self.convertPoint_fromView(event.locationInWindow(), None);
        let scale = self.window().map_or(1.0, |window| window.backingScaleFactor());
        self.send(Input::Mouse {
            x: (point.x * scale).round() as i64,
            y: (point.y * scale).round() as i64,
        });
    }

    fn send_button(&self, event: &NSEvent, button: &'static str, down: bool) {
        self.send_position(event);
        self.send(Input::Button { name: button, down });
    }
}

/// Adds a full-size player view to the window's content view and returns its
/// pointer for the OpenGL surface. The view is retained by its superview and
/// lives as long as the window.
pub fn attach(
    app: &AppHandle,
    window: &tauri::Window,
    sender: mpsc::Sender<WorkerCommand>,
) -> Result<usize, String> {
    let ns_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    let (result_sender, result) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let outcome = (|| {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "player view must be created on the main thread".to_string())?;
            // SAFETY: the pointer comes from a live Tauri window on the main thread.
            let window = unsafe { Retained::retain(ns_window as *mut NSWindow) }
                .ok_or_else(|| "player NSWindow is unavailable".to_string())?;
            let content = window
                .contentView()
                .ok_or_else(|| "player content view is unavailable".to_string())?;
            let view = PlayerView::new(mtm, content.bounds(), sender);
            view.setAutoresizingMask(
                NSAutoresizingMaskOptions::ViewWidthSizable
                    | NSAutoresizingMaskOptions::ViewHeightSizable,
            );
            // SAFETY: the owner outlives the tracking area, which the view retains.
            let tracking = unsafe {
                NSTrackingArea::initWithRect_options_owner_userInfo(
                    NSTrackingArea::alloc(),
                    NSRect::ZERO,
                    NSTrackingAreaOptions::MouseMoved
                        | NSTrackingAreaOptions::MouseEnteredAndExited
                        | NSTrackingAreaOptions::ActiveInKeyWindow
                        | NSTrackingAreaOptions::InVisibleRect,
                    Some(&view),
                    None,
                )
            };
            view.addTrackingArea(&tracking);
            content.addSubview(&view);
            window.setAcceptsMouseMovedEvents(true);
            window.makeFirstResponder(Some(&view));
            Ok(Retained::as_ptr(&view) as usize)
        })();
        let _ = result_sender.send(outcome);
    })
    .map_err(|error| error.to_string())?;
    result
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out while creating the player view.".to_string())?
}

fn mpv_key(event: &NSEvent) -> Option<String> {
    let flags = event.modifierFlags();
    let named = match event.keyCode() {
        36 | 76 => Some("ENTER"),
        48 => Some("TAB"),
        49 => Some("SPACE"),
        51 => Some("BS"),
        53 => Some("ESC"),
        115 => Some("HOME"),
        116 => Some("PGUP"),
        117 => Some("DEL"),
        119 => Some("END"),
        121 => Some("PGDWN"),
        123 => Some("LEFT"),
        124 => Some("RIGHT"),
        125 => Some("DOWN"),
        126 => Some("UP"),
        122 => Some("F1"),
        120 => Some("F2"),
        99 => Some("F3"),
        118 => Some("F4"),
        96 => Some("F5"),
        97 => Some("F6"),
        98 => Some("F7"),
        100 => Some("F8"),
        101 => Some("F9"),
        109 => Some("F10"),
        103 => Some("F11"),
        111 => Some("F12"),
        _ => None,
    };
    let base = match named {
        Some(name) => name.to_string(),
        None => {
            // Shift is already applied to these characters.
            let text = event.charactersIgnoringModifiers()?.to_string();
            let mut chars = text.chars();
            let character = chars.next()?;
            if chars.next().is_some() || character.is_control() {
                return None;
            }
            match character {
                '#' => "SHARP".to_string(),
                other => other.to_string(),
            }
        }
    };
    let mut key = String::new();
    if flags.contains(NSEventModifierFlags::Control) {
        key.push_str("Ctrl+");
    }
    if flags.contains(NSEventModifierFlags::Option) {
        key.push_str("Alt+");
    }
    if flags.contains(NSEventModifierFlags::Command) {
        key.push_str("Meta+");
    }
    if named.is_some() && flags.contains(NSEventModifierFlags::Shift) {
        key.push_str("Shift+");
    }
    key.push_str(&base);
    Some(key)
}
