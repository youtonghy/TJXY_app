//! Native AppKit player chrome: a full-size video view that hosts the mpv
//! OpenGL surface, a QuickTime-style translucent control bar and a centered
//! loading/error overlay. Controls send `Control` actions to the worker; the
//! worker pushes `UiState` snapshots back through `update`.

use crate::gcd;
use crate::types::{Control, Status, Track, TrackKind, UiState, WorkerCommand};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Sel};
use objc2::{
    define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApplication, NSAutoresizingMaskOptions, NSButton, NSColor, NSControlSize, NSCursor, NSEvent,
    NSEventModifierFlags, NSEventType, NSFont, NSFontWeightRegular, NSFontWeightSemibold, NSImage,
    NSImageScaling, NSImageSymbolConfiguration, NSMenu, NSMenuItem, NSProgressIndicator,
    NSProgressIndicatorStyle, NSResponder, NSSlider, NSTextAlignment, NSTextField, NSTrackingArea,
    NSTrackingAreaOptions, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView, NSWindowDidEnterFullScreenNotification,
    NSWindowDidExitFullScreenNotification, NSWindowStyleMask,
};
use objc2_foundation::{
    NSInteger, NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSPoint, NSRect,
    NSSize, NSString,
};
use std::cell::{Cell, OnceCell, RefCell};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

const SEEK_STEP: f64 = 15.0;
const HIDE_AFTER: Duration = Duration::from_secs(3);
const BAR_HEIGHT: f64 = 76.0;
const BAR_MARGIN: f64 = 24.0;
const BAR_MIN_WIDTH: f64 = 360.0;
const BAR_MAX_WIDTH: f64 = 640.0;
const AUDIO_TAG: NSInteger = 1_000_000;
const SUBTITLE_TAG: NSInteger = 2_000_000;
const SUBTITLE_OFF_TAG: NSInteger = 2_999_999;
const SPEED_TAG: NSInteger = 3_000_000;
const SPEEDS: [f64; 6] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

thread_local! {
    /// Player views by player id. Only touched on the main thread; holding
    /// strong references keeps queued UI updates safe after the window closes.
    static VIEWS: RefCell<HashMap<String, Retained<PlayerView>>> = RefCell::new(HashMap::new());
}

struct Widgets {
    video: Retained<NSView>,
    bar: Retained<NSVisualEffectView>,
    mute: Retained<NSButton>,
    volume: Retained<NSSlider>,
    back: Retained<NSButton>,
    play: Retained<NSButton>,
    forward: Retained<NSButton>,
    tracks: Retained<NSButton>,
    fullscreen: Retained<NSButton>,
    seek: Retained<NSSlider>,
    elapsed: Retained<NSTextField>,
    remaining: Retained<NSTextField>,
    spinner: Retained<NSProgressIndicator>,
    message: Retained<NSTextField>,
}

pub struct PlayerViewIvars {
    sender: mpsc::Sender<WorkerCommand>,
    widgets: OnceCell<Widgets>,
    state: RefCell<Option<UiState>>,
    scrubbing: Cell<bool>,
    last_activity: Cell<Instant>,
    chrome_visible: Cell<bool>,
    /// Shared with `Host`: NSWindow fullscreen notifications keep it fresh
    /// so the worker can reconcile mpv's `fullscreen` property.
    fullscreen: Arc<AtomicBool>,
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

        #[unsafe(method(setFrameSize:))]
        fn set_frame_size(&self, size: NSSize) {
            let _: () = unsafe { msg_send![super(self), setFrameSize: size] };
            self.layout_widgets();
            self.send_subtitle_inset();
        }

        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, _event: &NSEvent) {
            self.touch();
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            self.touch();
            if event.clickCount() == 2 && !self.over_bar(event) {
                self.send(Control::ToggleFullscreen);
            }
        }

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, _event: &NSEvent) {
            self.touch();
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            self.touch();
            if let Some(key) = mpv_key(event) {
                self.send(Control::Key(key));
            }
        }

        #[unsafe(method(togglePlay:))]
        fn toggle_play(&self, _sender: Option<&AnyObject>) {
            self.touch();
            self.send(Control::TogglePause);
        }

        #[unsafe(method(seekBack:))]
        fn seek_back(&self, _sender: Option<&AnyObject>) {
            self.touch();
            self.send(Control::SeekBy(-SEEK_STEP));
        }

        #[unsafe(method(seekForward:))]
        fn seek_forward(&self, _sender: Option<&AnyObject>) {
            self.touch();
            self.send(Control::SeekBy(SEEK_STEP));
        }

        #[unsafe(method(toggleMute:))]
        fn toggle_mute(&self, _sender: Option<&AnyObject>) {
            self.touch();
            self.send(Control::ToggleMute);
        }

        #[unsafe(method(toggleFullscreen:))]
        fn toggle_fullscreen(&self, _sender: Option<&AnyObject>) {
            self.touch();
            self.send(Control::ToggleFullscreen);
        }

        #[unsafe(method(volumeChanged:))]
        fn volume_changed(&self, sender: &NSSlider) {
            self.touch();
            self.send(Control::SetVolume(sender.doubleValue()));
        }

        #[unsafe(method(seekChanged:))]
        fn seek_changed(&self, sender: &NSSlider) {
            self.touch();
            let finished = NSApplication::sharedApplication(self.mtm())
                .currentEvent()
                .is_some_and(|event| event.r#type() == NSEventType::LeftMouseUp);
            self.ivars().scrubbing.set(!finished);
            let seconds = sender.doubleValue();
            if let Some(widgets) = self.ivars().widgets.get() {
                widgets.elapsed.setStringValue(&NSString::from_str(&format_time(seconds)));
            }
            self.send(Control::SeekTo { seconds, exact: finished });
        }

        #[unsafe(method(showTracks:))]
        fn show_tracks(&self, sender: &NSButton) {
            self.touch();
            let menu = self.tracks_menu();
            let origin = NSPoint::new(0.0, sender.bounds().size.height + 4.0);
            menu.popUpMenuPositioningItem_atLocation_inView(None, origin, Some(sender));
        }

        #[unsafe(method(selectMenuItem:))]
        fn select_menu_item(&self, sender: &NSMenuItem) {
            let tag = sender.tag();
            let control = if tag == SUBTITLE_OFF_TAG {
                Control::SelectSubtitle(None)
            } else if tag >= SPEED_TAG {
                Control::SetSpeed((tag - SPEED_TAG) as f64 / 100.0)
            } else if tag >= SUBTITLE_TAG {
                Control::SelectSubtitle(Some((tag - SUBTITLE_TAG) as i64))
            } else {
                Control::SelectAudio((tag - AUDIO_TAG) as i64)
            };
            self.send(control);
        }

        #[unsafe(method(playerWindowEnteredFullscreen:))]
        fn window_entered_fullscreen(&self, _note: &NSNotification) {
            self.ivars().fullscreen.store(true, Ordering::Relaxed);
        }

        #[unsafe(method(playerWindowExitedFullscreen:))]
        fn window_exited_fullscreen(&self, _note: &NSNotification) {
            self.ivars().fullscreen.store(false, Ordering::Relaxed);
        }
    }
);

impl PlayerView {
    fn new(
        mtm: MainThreadMarker,
        frame: NSRect,
        sender: mpsc::Sender<WorkerCommand>,
        fullscreen: Arc<AtomicBool>,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(PlayerViewIvars {
            sender,
            widgets: OnceCell::new(),
            state: RefCell::new(None),
            scrubbing: Cell::new(false),
            last_activity: Cell::new(Instant::now()),
            chrome_visible: Cell::new(true),
            fullscreen,
        });
        // SAFETY: initWithFrame: is NSView's designated initializer.
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        view.build_widgets(mtm);
        view
    }

    fn send(&self, control: Control) {
        // The worker is gone once playback shuts down; dropping input then is fine.
        let _ = self.ivars().sender.send(WorkerCommand::Control(control));
    }

    fn touch(&self) {
        self.ivars().last_activity.set(Instant::now());
        self.set_chrome_visible(true);
    }

    fn over_bar(&self, event: &NSEvent) -> bool {
        let Some(widgets) = self.ivars().widgets.get() else {
            return false;
        };
        let point = self.convertPoint_fromView(event.locationInWindow(), None);
        contains(widgets.bar.frame(), point)
    }

    fn build_widgets(&self, mtm: MainThreadMarker) {
        let bounds = self.bounds();
        let video = NSView::initWithFrame(NSView::alloc(mtm), bounds);
        video.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        self.addSubview(&video);

        let bar = NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), NSRect::ZERO);
        bar.setMaterial(NSVisualEffectMaterial::HUDWindow);
        bar.setBlendingMode(NSVisualEffectBlendingMode::WithinWindow);
        bar.setState(NSVisualEffectState::Active);
        bar.setWantsLayer(true);
        // SAFETY: a layer-backed view always has a CALayer.
        unsafe {
            let layer: *mut AnyObject = msg_send![&*bar, layer];
            let _: () = msg_send![layer, setCornerRadius: 14.0f64];
            let _: () = msg_send![layer, setMasksToBounds: true];
        }
        self.addSubview(&bar);

        let target: &AnyObject = self.as_ref();
        let mute = symbol_button(
            mtm,
            "speaker.wave.2.fill",
            "静音",
            13.0,
            target,
            sel!(toggleMute:),
        );
        let back = symbol_button(
            mtm,
            "gobackward.15",
            "后退 15 秒",
            17.0,
            target,
            sel!(seekBack:),
        );
        let play = symbol_button(mtm, "play.fill", "播放", 24.0, target, sel!(togglePlay:));
        let forward = symbol_button(
            mtm,
            "goforward.15",
            "前进 15 秒",
            17.0,
            target,
            sel!(seekForward:),
        );
        let tracks = symbol_button(
            mtm,
            "captions.bubble",
            "音轨与字幕",
            15.0,
            target,
            sel!(showTracks:),
        );
        let fullscreen = symbol_button(
            mtm,
            "arrow.up.left.and.arrow.down.right",
            "全屏",
            13.0,
            target,
            sel!(toggleFullscreen:),
        );
        // SAFETY: the target outlives the slider; the action matches the selector.
        let volume = unsafe {
            NSSlider::sliderWithValue_minValue_maxValue_target_action(
                100.0,
                0.0,
                100.0,
                Some(target),
                Some(sel!(volumeChanged:)),
                mtm,
            )
        };
        volume.setControlSize(NSControlSize::Small);
        let seek = unsafe {
            NSSlider::sliderWithValue_minValue_maxValue_target_action(
                0.0,
                0.0,
                1.0,
                Some(target),
                Some(sel!(seekChanged:)),
                mtm,
            )
        };
        seek.setControlSize(NSControlSize::Small);
        seek.setContinuous(true);
        seek.setEnabled(false);
        let white = NSColor::whiteColor();
        volume.setTrackFillColor(Some(&white));
        seek.setTrackFillColor(Some(&white));
        let elapsed = time_label(mtm, NSTextAlignment::Left);
        let remaining = time_label(mtm, NSTextAlignment::Right);
        for view in [&*mute, &*back, &*play, &*forward, &*tracks, &*fullscreen] {
            bar.addSubview(view);
        }
        for view in [&**volume, &**seek, &**elapsed, &**remaining] {
            bar.addSubview(view);
        }

        let spinner =
            NSProgressIndicator::initWithFrame(NSProgressIndicator::alloc(mtm), NSRect::ZERO);
        spinner.setStyle(NSProgressIndicatorStyle::Spinning);
        spinner.setControlSize(NSControlSize::Regular);
        spinner.setDisplayedWhenStopped(false);
        self.addSubview(&spinner);
        let message = NSTextField::wrappingLabelWithString(&NSString::from_str(""), mtm);
        message.setAlignment(NSTextAlignment::Center);
        message.setTextColor(Some(&NSColor::colorWithWhite_alpha(1.0, 0.9)));
        message.setFont(Some(&NSFont::systemFontOfSize_weight(14.0, unsafe {
            NSFontWeightSemibold
        })));
        self.addSubview(&message);

        let _ = self.ivars().widgets.set(Widgets {
            video,
            bar,
            mute,
            volume,
            back,
            play,
            forward,
            tracks,
            fullscreen,
            seek,
            elapsed,
            remaining,
            spinner,
            message,
        });
        self.layout_widgets();
        self.send_subtitle_inset();
    }

    fn layout_widgets(&self) {
        let Some(w) = self.ivars().widgets.get() else {
            return;
        };
        let bounds = self.bounds().size;
        let width =
            (bounds.width - BAR_MARGIN * 2.0).clamp(BAR_MIN_WIDTH.min(bounds.width), BAR_MAX_WIDTH);
        w.bar.setFrame(rect(
            (bounds.width - width) / 2.0,
            bounds.height - BAR_HEIGHT - BAR_MARGIN,
            width,
            BAR_HEIGHT,
        ));
        // The bar is not flipped: y grows upwards from its bottom edge.
        let center = width / 2.0;
        w.mute.setFrame(rect(12.0, 38.0, 26.0, 26.0));
        w.volume.setFrame(rect(40.0, 40.0, 76.0, 22.0));
        w.back.setFrame(rect(center - 76.0, 36.0, 34.0, 30.0));
        w.play.setFrame(rect(center - 20.0, 34.0, 40.0, 34.0));
        w.forward.setFrame(rect(center + 42.0, 36.0, 34.0, 30.0));
        w.tracks.setFrame(rect(width - 72.0, 38.0, 28.0, 26.0));
        w.fullscreen.setFrame(rect(width - 40.0, 38.0, 28.0, 26.0));
        w.elapsed.setFrame(rect(12.0, 10.0, 64.0, 16.0));
        w.remaining.setFrame(rect(width - 76.0, 10.0, 64.0, 16.0));
        w.seek
            .setFrame(rect(80.0, 7.0, (width - 160.0).max(40.0), 22.0));

        w.spinner.setFrame(rect(
            bounds.width / 2.0 - 16.0,
            bounds.height / 2.0 - 16.0,
            32.0,
            32.0,
        ));
        let message_width = (bounds.width - 80.0).clamp(160.0, 520.0);
        w.message.setFrame(rect(
            (bounds.width - message_width) / 2.0,
            bounds.height / 2.0 + 24.0,
            message_width,
            60.0,
        ));
    }

    fn set_chrome_visible(&self, visible: bool) {
        if self.ivars().chrome_visible.replace(visible) == visible {
            return;
        }
        let Some(widgets) = self.ivars().widgets.get() else {
            return;
        };
        widgets.bar.setHidden(!visible);
        if !visible {
            NSCursor::setHiddenUntilMouseMoves(true);
        }
        self.send_subtitle_inset();
    }

    /// Keeps subtitles above the control bar while it is shown.
    fn send_subtitle_inset(&self) {
        let height = self.bounds().size.height;
        let fraction = if self.ivars().chrome_visible.get() && height > 0.0 {
            (BAR_HEIGHT + BAR_MARGIN + 8.0) / height
        } else {
            0.0
        };
        self.send(Control::SubtitleInset(fraction));
    }

    fn apply(&self, state: UiState) {
        let Some(w) = self.ivars().widgets.get() else {
            return;
        };
        let ready = state.status == Status::Ready;
        let loading = matches!(state.status, Status::Loading(_)) || (ready && state.buffering);
        // SAFETY: plain start/stop of an indeterminate indicator.
        unsafe {
            if loading {
                w.spinner.startAnimation(None);
            } else {
                w.spinner.stopAnimation(None);
            }
        }
        let message = match &state.status {
            Status::Loading(text) | Status::Error(text) => Some(text.as_str()),
            Status::Ready => state.notice.as_deref(),
        };
        w.message
            .setStringValue(&NSString::from_str(message.unwrap_or("")));
        w.message.setHidden(message.is_none());

        set_symbol(
            &w.play,
            if state.paused {
                "play.fill"
            } else {
                "pause.fill"
            },
            24.0,
        );
        set_symbol(
            &w.mute,
            if state.muted || state.volume <= 0.0 {
                "speaker.slash.fill"
            } else {
                "speaker.wave.2.fill"
            },
            13.0,
        );
        set_symbol(
            &w.fullscreen,
            if state.fullscreen {
                "arrow.down.right.and.arrow.up.left"
            } else {
                "arrow.up.left.and.arrow.down.right"
            },
            13.0,
        );
        w.volume.setDoubleValue(state.volume);
        let seekable = ready && state.duration > 0.0;
        w.seek.setEnabled(seekable);
        for button in [&w.back, &w.forward, &w.play] {
            button.setEnabled(ready);
        }
        w.tracks.setEnabled(ready);
        if !self.ivars().scrubbing.get() {
            w.seek.setMaxValue(state.duration.max(1.0));
            w.seek.setDoubleValue(state.position);
            w.elapsed
                .setStringValue(&NSString::from_str(&format_time(state.position)));
        }
        let remaining = if state.duration > 0.0 {
            format!(
                "-{}",
                format_time((state.duration - state.position).max(0.0))
            )
        } else {
            String::new()
        };
        w.remaining.setStringValue(&NSString::from_str(&remaining));

        let idle = self.ivars().last_activity.get().elapsed() >= HIDE_AFTER;
        let pointer_over_bar = self
            .window()
            .map(|window| {
                self.convertPoint_fromView(window.mouseLocationOutsideOfEventStream(), None)
            })
            .is_some_and(|point| contains(w.bar.frame(), point));
        let hide =
            ready && !state.paused && idle && !pointer_over_bar && !self.ivars().scrubbing.get();
        self.set_chrome_visible(!hide);
        *self.ivars().state.borrow_mut() = Some(state);
    }

    fn tracks_menu(&self) -> Retained<NSMenu> {
        let mtm = self.mtm();
        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);
        let state = self.ivars().state.borrow();
        let tracks: &[Track] = state.as_ref().map_or(&[], |state| state.tracks.as_slice());
        let speed = state.as_ref().map_or(1.0, |state| state.speed);

        let audio: Vec<&Track> = tracks
            .iter()
            .filter(|track| track.kind == TrackKind::Audio)
            .collect();
        self.add_header(&menu, "音频");
        if audio.is_empty() {
            self.add_item(&menu, "无", 0, false, false);
        }
        for track in audio {
            self.add_item(
                &menu,
                &track.label,
                AUDIO_TAG + track.id as NSInteger,
                track.selected,
                true,
            );
        }
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        self.add_header(&menu, "字幕");
        let subtitles: Vec<&Track> = tracks
            .iter()
            .filter(|track| track.kind == TrackKind::Subtitle)
            .collect();
        let any_selected = subtitles.iter().any(|track| track.selected);
        self.add_item(&menu, "关闭", SUBTITLE_OFF_TAG, !any_selected, true);
        for track in subtitles {
            self.add_item(
                &menu,
                &track.label,
                SUBTITLE_TAG + track.id as NSInteger,
                track.selected,
                true,
            );
        }
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        self.add_header(&menu, "播放速度");
        for value in SPEEDS {
            let label = if value == 1.0 {
                "正常".to_string()
            } else {
                format!("{value}×")
            };
            let tag = SPEED_TAG + (value * 100.0).round() as NSInteger;
            self.add_item(&menu, &label, tag, (speed - value).abs() < 0.01, true);
        }
        menu
    }

    fn add_header(&self, menu: &NSMenu, title: &str) {
        self.add_item(menu, title, 0, false, false);
    }

    fn add_item(&self, menu: &NSMenu, title: &str, tag: NSInteger, checked: bool, enabled: bool) {
        let mtm = self.mtm();
        // SAFETY: selectMenuItem: is implemented by self, which outlives the menu.
        let item = unsafe {
            let item = NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(title),
                if enabled {
                    Some(sel!(selectMenuItem:))
                } else {
                    None
                },
                &NSString::from_str(""),
            );
            item.setTarget(Some(self.as_ref()));
            item
        };
        item.setTag(tag);
        item.setEnabled(enabled);
        item.setState(if checked { 1 } else { 0 });
        menu.addItem(&item);
    }
}

/// Adds the player view to the window's content view and returns the video
/// view pointer for the OpenGL surface. Called on the main thread during
/// window setup; the view is retained by the view hierarchy and the registry
/// until `detach`.
pub fn attach(
    parent: usize,
    id: &str,
    sender: mpsc::Sender<WorkerCommand>,
    fullscreen: Arc<AtomicBool>,
) -> Result<usize, String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "player view must be created on the main thread".to_string())?;
    // SAFETY: `parent` is the winit window's content NSView, alive on the
    // main thread for the duration of this call.
    let parent_view = unsafe { Retained::retain(parent as *mut NSView) }
        .ok_or_else(|| "player content view is unavailable".to_string())?;
    let window = parent_view
        .window()
        .ok_or_else(|| "player NSWindow is unavailable".to_string())?;
    let content = window
        .contentView()
        .ok_or_else(|| "player content view is unavailable".to_string())?;
    let view = PlayerView::new(mtm, content.bounds(), sender, fullscreen);
    view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    // SAFETY: the owner outlives the tracking area, which the view retains.
    let tracking = unsafe {
        NSTrackingArea::initWithRect_options_owner_userInfo(
            NSTrackingArea::alloc(),
            NSRect::ZERO,
            NSTrackingAreaOptions::MouseMoved
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
    // Track native (green-button / toggleFullScreen) transitions.
    unsafe {
        let center = NSNotificationCenter::defaultCenter();
        center.addObserver_selector_name_object(
            view.as_ref(),
            sel!(playerWindowEnteredFullscreen:),
            Some(NSWindowDidEnterFullScreenNotification),
            Some(&window),
        );
        center.addObserver_selector_name_object(
            view.as_ref(),
            sel!(playerWindowExitedFullscreen:),
            Some(NSWindowDidExitFullScreenNotification),
            Some(&window),
        );
    }
    let video = view
        .ivars()
        .widgets
        .get()
        .map(|widgets| Retained::as_ptr(&widgets.video) as usize)
        .ok_or_else(|| "player video view is unavailable".to_string())?;
    VIEWS.with(|views| views.borrow_mut().insert(id.to_string(), view));
    Ok(video)
}

/// Pushes a playback snapshot to the controls of player `id`.
pub fn update(id: &str, state: UiState) {
    let id = id.to_string();
    gcd::on_main(move || {
        let view = VIEWS.with(|views| views.borrow().get(&id).cloned());
        if let Some(view) = view {
            view.apply(state);
        }
    });
}

/// Releases the registry's reference to player `id`'s view. Must run on the
/// main thread (the registry is thread-local); called during app teardown.
pub fn detach(id: &str) {
    VIEWS.with(|views| views.borrow_mut().remove(id));
}

/// Drives the native fullscreen transition for `window` (a winit window).
/// Returns false if the window handle could not be resolved so the caller
/// can fall back to winit's own borderless mode.
pub fn toggle_fullscreen(window: &winit::window::Window, fullscreen: bool) -> bool {
    use raw_window_handle::HasWindowHandle;
    let Ok(handle) = window.window_handle() else {
        return false;
    };
    let raw_window_handle::RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        return false;
    };
    // SAFETY: the view belongs to a live window on the main thread.
    let view = unsafe { Retained::retain(appkit.ns_view.as_ptr() as *mut NSView) };
    let Some(view) = view else { return false };
    let Some(ns_window) = view.window() else {
        return false;
    };
    if ns_window
        .styleMask()
        .contains(NSWindowStyleMask::FullScreen)
        != fullscreen
    {
        ns_window.toggleFullScreen(None);
    }
    true
}

fn symbol_image(name: &str, point_size: f64) -> Option<Retained<NSImage>> {
    let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
        &NSString::from_str(name),
        None,
    )?;
    let configuration =
        NSImageSymbolConfiguration::configurationWithPointSize_weight(point_size, unsafe {
            NSFontWeightRegular
        });
    image.imageWithSymbolConfiguration(&configuration)
}

fn set_symbol(button: &NSButton, name: &str, point_size: f64) {
    if let Some(image) = symbol_image(name, point_size) {
        button.setImage(Some(&image));
    }
}

fn symbol_button(
    mtm: MainThreadMarker,
    name: &str,
    tooltip: &str,
    point_size: f64,
    target: &AnyObject,
    action: Sel,
) -> Retained<NSButton> {
    let image = symbol_image(name, point_size).unwrap_or_default();
    // SAFETY: the target outlives the button; the action matches the selector.
    let button =
        unsafe { NSButton::buttonWithImage_target_action(&image, Some(target), Some(action), mtm) };
    button.setBordered(false);
    button.setImageScaling(NSImageScaling::ScaleNone);
    button.setContentTintColor(Some(&NSColor::whiteColor()));
    button.setToolTip(Some(&NSString::from_str(tooltip)));
    button.setRefusesFirstResponder(true);
    button
}

fn time_label(mtm: MainThreadMarker, alignment: NSTextAlignment) -> Retained<NSTextField> {
    let label = NSTextField::labelWithString(&NSString::from_str(""), mtm);
    label.setAlignment(alignment);
    label.setTextColor(Some(&NSColor::colorWithWhite_alpha(1.0, 0.8)));
    label.setFont(Some(&NSFont::monospacedDigitSystemFontOfSize_weight(
        11.0,
        unsafe { NSFontWeightRegular },
    )));
    label
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
    NSRect::new(
        NSPoint::new(x, y),
        NSSize::new(width.max(0.0), height.max(0.0)),
    )
}

fn contains(frame: NSRect, point: NSPoint) -> bool {
    point.x >= frame.origin.x
        && point.x <= frame.origin.x + frame.size.width
        && point.y >= frame.origin.y
        && point.y <= frame.origin.y + frame.size.height
}

fn format_time(seconds: f64) -> String {
    let total = if seconds.is_finite() {
        seconds.max(0.0) as u64
    } else {
        0
    };
    let (hours, minutes, secs) = (total / 3600, total / 60 % 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
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

#[cfg(test)]
mod tests {
    use super::format_time;

    #[test]
    fn formats_playback_times() {
        assert_eq!(format_time(0.0), "0:00");
        assert_eq!(format_time(65.9), "1:05");
        assert_eq!(format_time(3723.0), "1:02:03");
        assert_eq!(format_time(f64::NAN), "0:00");
    }
}
