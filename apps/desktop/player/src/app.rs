//! Window host: owns the winit event loop, creates the player window, feeds
//! window events to the render worker and applies the worker's host requests
//! (title, fullscreen). Replaces the Tauri window/AppHandle glue.

#[cfg(target_os = "macos")]
use crate::chrome;
use crate::protocol;
use crate::server::Session;
#[cfg(not(target_os = "macos"))]
use crate::types::Control;
use crate::types::{WorkerCommand, WorkerSender};
use crate::worker;
#[cfg(target_os = "macos")]
use raw_window_handle::{AppKitWindowHandle, RawWindowHandle};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use std::num::NonZeroU32;
#[cfg(target_os = "macos")]
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
#[cfg(not(target_os = "macos"))]
use winit::event::{ElementState, KeyEvent, MouseButton, MouseScrollDelta};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::window::{Fullscreen, Theme, Window, WindowAttributes, WindowId};

/// Requests the worker sends to the main thread.
#[derive(Debug)]
pub enum HostEvent {
    SetTitle(String),
    SetFullscreen(bool),
    /// stdin `shutdown` or a closed parent pipe.
    RequestClose,
    /// The render worker exited; safe to quit.
    WorkerFinished,
}

/// Main-thread window operations offered to the worker.
#[derive(Clone)]
pub struct Host {
    proxy: EventLoopProxy<HostEvent>,
    /// OS-level fullscreen state, kept by the main thread (on macOS the
    /// native transition is observed through NSWindow notifications).
    fullscreen: Arc<AtomicBool>,
}

impl Host {
    pub fn set_title(&self, title: &str) {
        let _ = self
            .proxy
            .send_event(HostEvent::SetTitle(title.to_string()));
    }

    pub fn set_fullscreen(&self, fullscreen: bool) {
        let _ = self.proxy.send_event(HostEvent::SetFullscreen(fullscreen));
    }

    pub fn is_fullscreen(&self) -> bool {
        self.fullscreen.load(Ordering::Relaxed)
    }

    pub fn fullscreen_flag(&self) -> Arc<AtomicBool> {
        self.fullscreen.clone()
    }
}

struct App {
    host: Host,
    session: Option<Session>,
    item_id: String,
    window: Option<Window>,
    sender: Option<WorkerSender>,
    join: Option<JoinHandle<()>>,
    closing: bool,
    #[cfg(not(target_os = "macos"))]
    modifiers: winit::keyboard::ModifiersState,
    /// Last cursor position in physical pixels (button events need it).
    #[cfg(not(target_os = "macos"))]
    cursor: (f64, f64),
    /// Chrome registry id (macOS only).
    #[cfg(target_os = "macos")]
    view_id: String,
}

impl App {
    fn begin_close(&mut self) {
        if self.closing {
            return;
        }
        self.closing = true;
        if let Some(window) = &self.window {
            window.set_visible(false);
        }
        if let Some(sender) = &self.sender {
            let _ = sender.send(WorkerCommand::Shutdown);
        }
    }

    fn create_player_window(&mut self, event_loop: &ActiveEventLoop) -> Result<(), String> {
        let attributes = window_attributes();
        let window = event_loop
            .create_window(attributes)
            .map_err(|error| format!("无法创建播放窗口：{error}"))?;
        let size = window.inner_size();
        let raw_display = window
            .display_handle()
            .map_err(|error| format!("无法创建播放窗口：{error}"))?
            .as_raw();
        let raw_window = window
            .window_handle()
            .map_err(|error| format!("无法创建播放窗口：{error}"))?
            .as_raw();

        let (sender, receiver) = mpsc::channel::<WorkerCommand>();

        // On macOS the video renders into a dedicated subview so the AppKit
        // chrome can overlay it; elsewhere the window surface is used.
        #[cfg(target_os = "macos")]
        let video_handle = {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let RawWindowHandle::AppKit(appkit) = raw_window else {
                return Err("播放窗口句柄无效。".into());
            };
            let video = chrome::attach(
                appkit.ns_view.as_ptr() as usize,
                &id,
                sender.clone(),
                self.host.fullscreen_flag(),
            )?;
            (
                id,
                RawWindowHandle::AppKit(AppKitWindowHandle::new(
                    NonNull::new(video as *mut std::ffi::c_void)
                        .ok_or_else(|| "native player view is invalid".to_string())?,
                )),
            )
        };
        #[cfg(not(target_os = "macos"))]
        let video_handle = (String::new(), raw_window);

        let session = self
            .session
            .take()
            .ok_or_else(|| "播放会话已使用。".to_string())?;
        let context = worker::Context {
            window_handle: video_handle.1,
            display_handle: raw_display,
            width: NonZeroU32::new(size.width.max(1)).expect("width"),
            height: NonZeroU32::new(size.height.max(1)).expect("height"),
            session,
            item_id: self.item_id.clone(),
            host: self.host.clone(),
            view_id: video_handle.0.clone(),
            receiver,
            sender: sender.clone(),
        };
        let host = self.host.clone();
        let join = std::thread::Builder::new()
            .name("tjxy-player".into())
            .spawn(move || {
                if let Err(message) = worker::run(context) {
                    eprintln!("player failed: {message}");
                    protocol::emit_error(&message);
                    host.set_title(&format!("播放失败：{message}"));
                }
                let _ = host.proxy.send_event(HostEvent::WorkerFinished);
            })
            .map_err(|error| error.to_string())?;
        #[cfg(target_os = "macos")]
        {
            self.view_id = video_handle.0;
        }
        #[cfg(not(target_os = "macos"))]
        let _ = video_handle.0;
        self.window = Some(window);
        self.sender = Some(sender);
        self.join = Some(join);
        Ok(())
    }
}

fn window_attributes() -> WindowAttributes {
    let attributes = Window::default_attributes()
        .with_title("正在加载…")
        .with_theme(Some(Theme::Dark))
        .with_inner_size(winit::dpi::LogicalSize::new(1280.0, 720.0))
        .with_min_inner_size(winit::dpi::LogicalSize::new(480.0, 270.0));
    #[cfg(target_os = "macos")]
    let attributes = {
        use winit::platform::macos::WindowAttributesExtMacOS;
        attributes
            .with_titlebar_transparent(true)
            .with_fullsize_content_view(true)
    };
    attributes
}

/// winit key → mpv key name, mirroring `mpv_key` in chrome.rs. Only used on
/// platforms where mpv's OSC receives input through commands.
#[cfg(not(target_os = "macos"))]
fn mpv_key(event: &KeyEvent, modifiers: winit::keyboard::ModifiersState) -> Option<String> {
    use winit::keyboard::{KeyCode, PhysicalKey};
    let named = match event.physical_key {
        PhysicalKey::Code(KeyCode::Enter | KeyCode::NumpadEnter) => Some("ENTER"),
        PhysicalKey::Code(KeyCode::Tab) => Some("TAB"),
        PhysicalKey::Code(KeyCode::Space) => Some("SPACE"),
        PhysicalKey::Code(KeyCode::Backspace) => Some("BS"),
        PhysicalKey::Code(KeyCode::Escape) => Some("ESC"),
        PhysicalKey::Code(KeyCode::Home) => Some("HOME"),
        PhysicalKey::Code(KeyCode::PageUp) => Some("PGUP"),
        PhysicalKey::Code(KeyCode::Delete) => Some("DEL"),
        PhysicalKey::Code(KeyCode::End) => Some("END"),
        PhysicalKey::Code(KeyCode::PageDown) => Some("PGDWN"),
        PhysicalKey::Code(KeyCode::ArrowLeft) => Some("LEFT"),
        PhysicalKey::Code(KeyCode::ArrowRight) => Some("RIGHT"),
        PhysicalKey::Code(KeyCode::ArrowDown) => Some("DOWN"),
        PhysicalKey::Code(KeyCode::ArrowUp) => Some("UP"),
        _ => None,
    };
    let base = match named {
        Some(name) => name.to_string(),
        None => {
            // Shift is already applied to the produced text.
            let text = event.text.as_ref()?;
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
    if modifiers.control_key() {
        key.push_str("Ctrl+");
    }
    if modifiers.alt_key() {
        key.push_str("Alt+");
    }
    if modifiers.super_key() {
        key.push_str("Meta+");
    }
    if named.is_some() && modifiers.shift_key() {
        key.push_str("Shift+");
    }
    key.push_str(&base);
    Some(key)
}

#[cfg(not(target_os = "macos"))]
fn mpv_mouse_button(button: MouseButton) -> Option<i32> {
    match button {
        MouseButton::Left => Some(0),
        MouseButton::Middle => Some(1),
        MouseButton::Right => Some(2),
        MouseButton::Back => Some(3),
        MouseButton::Forward => Some(4),
        MouseButton::Other(_) => None,
    }
}

impl ApplicationHandler<HostEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        match self.create_player_window(event_loop) {
            Ok(()) => protocol::emit_ready(),
            Err(error) => {
                protocol::emit_error(&error);
                event_loop.exit();
            }
        }
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        if self.window.as_ref().is_none_or(|w| w.id() != window_id) {
            return;
        }
        let sender = match &self.sender {
            Some(sender) => sender,
            None => return,
        };
        match event {
            WindowEvent::CloseRequested => self.begin_close(),
            WindowEvent::Resized(size) => {
                let _ = sender.send(WorkerCommand::Resize {
                    width: size.width,
                    height: size.height,
                });
            }
            #[cfg(not(target_os = "macos"))]
            WindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
            }
            #[cfg(not(target_os = "macos"))]
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                if let Some(key) = mpv_key(&event, self.modifiers) {
                    let _ = sender.send(WorkerCommand::Control(Control::Key(key)));
                }
            }
            #[cfg(not(target_os = "macos"))]
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = (position.x, position.y);
                let _ = sender.send(WorkerCommand::Control(Control::MouseMove {
                    x: position.x,
                    y: position.y,
                }));
            }
            #[cfg(not(target_os = "macos"))]
            WindowEvent::MouseInput { state, button, .. } => {
                if let Some(button) = mpv_mouse_button(button) {
                    let position = self.cursor;
                    let _ = sender.send(WorkerCommand::Control(Control::MouseButton {
                        x: position.0,
                        y: position.1,
                        button,
                        pressed: state == ElementState::Pressed,
                    }));
                }
            }
            #[cfg(not(target_os = "macos"))]
            WindowEvent::MouseWheel { delta, .. } => {
                let lines = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y.round() as i32,
                    MouseScrollDelta::PixelDelta(pos) => (pos.y / 40.0).round() as i32,
                };
                if lines != 0 {
                    let _ = sender.send(WorkerCommand::Control(Control::Wheel { lines }));
                }
            }
            _ => {}
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: HostEvent) {
        match event {
            HostEvent::SetTitle(title) => {
                if let Some(window) = &self.window {
                    window.set_title(&title);
                }
            }
            HostEvent::SetFullscreen(fullscreen) => {
                self.host.fullscreen.store(fullscreen, Ordering::Relaxed);
                #[cfg(target_os = "macos")]
                if let Some(window) = &self.window {
                    // Prefer the native transition over winit's own mode.
                    if !chrome::toggle_fullscreen(window, fullscreen) {
                        window.set_fullscreen(fullscreen.then(|| Fullscreen::Borderless(None)));
                    }
                }
                #[cfg(not(target_os = "macos"))]
                if let Some(window) = &self.window {
                    window.set_fullscreen(fullscreen.then(|| Fullscreen::Borderless(None)));
                }
            }
            HostEvent::RequestClose => self.begin_close(),
            HostEvent::WorkerFinished => event_loop.exit(),
        }
    }

    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        #[cfg(target_os = "macos")]
        chrome::detach(&self.view_id);
        self.window.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Entry point: owns the event loop and returns after the window closes.
pub fn run(session: Session, item_id: String) -> Result<(), String> {
    let event_loop = EventLoop::<HostEvent>::with_user_event()
        .build()
        .map_err(|error| format!("无法创建播放窗口：{error}"))?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy = event_loop.create_proxy();
    let host = Host {
        proxy,
        fullscreen: Arc::new(AtomicBool::new(false)),
    };
    protocol::spawn_stdin_watch(host.proxy.clone());
    let mut app = App {
        host,
        session: Some(session),
        item_id,
        window: None,
        sender: None,
        join: None,
        closing: false,
        #[cfg(not(target_os = "macos"))]
        modifiers: winit::keyboard::ModifiersState::empty(),
        #[cfg(not(target_os = "macos"))]
        cursor: (0.0, 0.0),
        #[cfg(target_os = "macos")]
        view_id: String::new(),
    };
    event_loop
        .run_app(&mut app)
        .map_err(|error| format!("播放窗口事件循环失败：{error}"))
}
