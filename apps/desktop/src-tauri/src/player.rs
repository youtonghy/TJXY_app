use serde::{Deserialize, Serialize};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const EVENT_NAME: &str = "tjxy-desktop-player-event";
const TICKS_PER_SECOND: f64 = 10_000_000.0;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub load_id: String,
    pub url: String,
    pub server_origin: String,
    pub start_position_ticks: i64,
    pub autoplay: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlayerCommand {
    Play,
    Pause,
    Seek {
        #[serde(rename = "positionTicks", alias = "position_ticks")]
        position_ticks: i64,
    },
    SetVolume {
        volume: f64,
    },
    SetMuted {
        muted: bool,
    },
    SetPlaybackRate {
        #[serde(rename = "playbackRate", alias = "playback_rate")]
        playback_rate: f64,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    load_id: String,
    phase: PlayerPhase,
    position_ticks: i64,
    duration_ticks: Option<i64>,
    seekable: bool,
    volume: f64,
    muted: bool,
    playback_rate: f64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PlayerPhase {
    Loading,
    Playing,
    Paused,
    Buffering,
    Ended,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum PlayerEvent {
    State {
        snapshot: PlayerSnapshot,
    },
    Ended {
        load_id: String,
        position_ticks: i64,
    },
    Error {
        load_id: String,
        code: String,
        message: String,
    },
}

enum WorkerCommand {
    Player(PlayerCommand),
    Viewport(Viewport),
    Shutdown,
}

struct PlayerWorker {
    load_id: String,
    sender: mpsc::Sender<WorkerCommand>,
    thread: Option<JoinHandle<()>>,
    native_view: usize,
}

impl PlayerWorker {
    fn stop(mut self, app: &AppHandle) {
        let _ = self.sender.send(WorkerCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        remove_native_view(app, self.native_view);
    }
}

pub struct PlayerCell(Arc<Mutex<Option<PlayerWorker>>>);

impl PlayerCell {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

pub fn open(
    app: &AppHandle,
    request: OpenRequest,
    viewport: Viewport,
) -> Result<PlayerSnapshot, String> {
    let url = validate_source_url(&request.url, &request.server_origin)?;
    let cell = player_cell(app)?;
    let previous = cell
        .lock()
        .map_err(|_| "player state is unavailable".to_string())?
        .take();
    if let Some(worker) = previous {
        worker.stop(app);
    }

    #[cfg(target_os = "macos")]
    {
        let native_view = create_native_view(app, viewport)?;
        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let worker_app = app.clone();
        let worker_request = request.clone();
        let event_load_id = request.load_id.clone();
        let ready_for_error = ready_sender.clone();
        let thread = thread::Builder::new()
            .name("tjxy-libmpv".into())
            .spawn(move || {
                if let Err(message) = run_macos_player(
                    &worker_app,
                    worker_request,
                    url,
                    native_view,
                    receiver,
                    ready_sender,
                ) {
                    let _ = ready_for_error.send(Err(message.clone()));
                    emit_error(&worker_app, &event_load_id, "player-failed", message);
                }
            })
            .map_err(|error| {
                remove_native_view(app, native_view);
                error.to_string()
            })?;

        match ready_receiver.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(snapshot)) => {
                *cell
                    .lock()
                    .map_err(|_| "player state is unavailable".to_string())? = Some(PlayerWorker {
                    load_id: request.load_id,
                    sender,
                    thread: Some(thread),
                    native_view,
                });
                Ok(snapshot)
            }
            Ok(Err(error)) => {
                let _ = thread.join();
                remove_native_view(app, native_view);
                Err(error)
            }
            Err(_) => {
                let _ = sender.send(WorkerCommand::Shutdown);
                let _ = thread.join();
                remove_native_view(app, native_view);
                Err("Timed out while starting the embedded player.".into())
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (request, viewport, url);
        Err("The bundled mpv renderer is not available for this desktop platform yet.".into())
    }
}

pub fn command(app: &AppHandle, load_id: &str, command: PlayerCommand) -> Result<(), String> {
    send_to_worker(app, load_id, WorkerCommand::Player(command))
}

pub fn set_viewport(app: &AppHandle, load_id: &str, viewport: Viewport) -> Result<(), String> {
    send_to_worker(app, load_id, WorkerCommand::Viewport(viewport))
}

pub fn close(app: &AppHandle, load_id: Option<&str>) -> Result<(), String> {
    let cell = player_cell(app)?;
    let worker = {
        let mut slot = cell
            .lock()
            .map_err(|_| "player state is unavailable".to_string())?;
        if load_id.is_some_and(|id| slot.as_ref().is_some_and(|worker| worker.load_id != id)) {
            return Ok(());
        }
        slot.take()
    };
    if let Some(worker) = worker {
        worker.stop(app);
    }
    Ok(())
}

fn send_to_worker(app: &AppHandle, load_id: &str, command: WorkerCommand) -> Result<(), String> {
    let cell = player_cell(app)?;
    let slot = cell
        .lock()
        .map_err(|_| "player state is unavailable".to_string())?;
    let worker = slot
        .as_ref()
        .ok_or_else(|| "player is not open".to_string())?;
    if worker.load_id != load_id {
        return Ok(());
    }
    worker
        .sender
        .send(command)
        .map_err(|_| "player stopped unexpectedly".to_string())
}

fn player_cell(app: &AppHandle) -> Result<Arc<Mutex<Option<PlayerWorker>>>, String> {
    app.try_state::<PlayerCell>()
        .map(|cell| cell.0.clone())
        .ok_or_else(|| "player state missing".to_string())
}

fn validate_source_url(source: &str, server_origin: &str) -> Result<String, String> {
    let source =
        reqwest::Url::parse(source).map_err(|_| "Playback source URL is invalid.".to_string())?;
    let server =
        reqwest::Url::parse(server_origin).map_err(|_| "Server origin is invalid.".to_string())?;
    if !matches!(source.scheme(), "http" | "https")
        || !matches!(server.scheme(), "http" | "https")
        || source.host_str().is_none()
        || server.host_str().is_none()
        || !source.username().is_empty()
        || source.password().is_some()
        || source.fragment().is_some()
        || !server.username().is_empty()
        || server.password().is_some()
    {
        return Err("Playback source URL is not allowed.".into());
    }
    let same_origin = source.scheme() == server.scheme()
        && source.host_str() == server.host_str()
        && source.port_or_known_default() == server.port_or_known_default();
    if !same_origin {
        return Err("Playback source must use the connected server origin.".into());
    }
    Ok(source.to_string())
}

fn emit_error(app: &AppHandle, load_id: &str, code: &str, message: String) {
    let _ = app.emit(
        EVENT_NAME,
        PlayerEvent::Error {
            load_id: load_id.to_string(),
            code: code.to_string(),
            message,
        },
    );
}

#[cfg(target_os = "macos")]
fn create_native_view(app: &AppHandle, viewport: Viewport) -> Result<usize, String> {
    use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSView, NSWindow};

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let ns_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    let (sender, receiver) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = (|| {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "player view must be created on the main thread".to_string())?;
            let window = unsafe { Retained::retain(ns_window as *mut NSWindow) }
                .ok_or_else(|| "main NSWindow is unavailable".to_string())?;
            let content = window
                .contentView()
                .ok_or_else(|| "main content view is unavailable".to_string())?;
            let view = NSView::initWithFrame(
                NSView::alloc(mtm),
                ns_frame(viewport, content.bounds().size.height),
            );
            content.addSubview(&view);
            view.setHidden(!viewport.visible);
            Ok(Retained::as_ptr(&view) as usize)
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out while creating the player view.".to_string())?
}

#[cfg(target_os = "macos")]
fn update_native_view(app: &AppHandle, native_view: usize, viewport: Viewport) {
    use objc2::rc::Retained;
    use objc2_app_kit::NSView;
    let _ = app.run_on_main_thread(move || {
        if let Some(view) = unsafe { Retained::retain(native_view as *mut NSView) } {
            if let Some(superview) = unsafe { view.superview() } {
                view.setFrame(ns_frame(viewport, superview.bounds().size.height));
            }
            view.setHidden(!viewport.visible);
        }
    });
}

#[cfg(target_os = "macos")]
fn remove_native_view(app: &AppHandle, native_view: usize) {
    use objc2::rc::Retained;
    use objc2_app_kit::NSView;
    let _ = app.run_on_main_thread(move || {
        if let Some(view) = unsafe { Retained::retain(native_view as *mut NSView) } {
            view.removeFromSuperview();
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn remove_native_view(_app: &AppHandle, _native_view: usize) {}

#[cfg(target_os = "macos")]
fn ns_frame(viewport: Viewport, content_height: f64) -> objc2_foundation::NSRect {
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    NSRect::new(
        NSPoint::new(
            viewport.x.max(0.0),
            (content_height - viewport.y - viewport.height).max(0.0),
        ),
        NSSize::new(viewport.width.max(1.0), viewport.height.max(1.0)),
    )
}

#[cfg(target_os = "macos")]
fn run_macos_player(
    app: &AppHandle,
    request: OpenRequest,
    url: String,
    native_view: usize,
    receiver: mpsc::Receiver<WorkerCommand>,
    ready: mpsc::SyncSender<Result<PlayerSnapshot, String>>,
) -> Result<(), String> {
    use glutin::config::ConfigTemplateBuilder;
    use glutin::context::{ContextApi, ContextAttributesBuilder, NotCurrentGlContext, Version};
    use glutin::display::{Display, DisplayApiPreference, GlDisplay};
    use glutin::prelude::*;
    use glutin::surface::{GlSurface, SurfaceAttributesBuilder, WindowSurface};
    use libmpv2::events::Event;
    use libmpv2::render::{mpv_render_update, OpenGLInitParams, RenderParam, RenderParamApiType};
    use libmpv2::Mpv;
    use raw_window_handle::{
        AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle,
    };
    use std::ffi::{c_void, CString};
    use std::num::NonZeroU32;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;

    fn get_proc_address(display: &Display, name: &str) -> *mut c_void {
        CString::new(name)
            .ok()
            .map(|name| display.get_proc_address(&name) as *mut c_void)
            .unwrap_or(std::ptr::null_mut())
    }

    let view = NonNull::new(native_view as *mut c_void)
        .ok_or_else(|| "native player view is invalid".to_string())?;
    let raw_window = RawWindowHandle::AppKit(AppKitWindowHandle::new(view));
    let raw_display = RawDisplayHandle::AppKit(AppKitDisplayHandle::new());
    let display = unsafe { Display::new(raw_display, DisplayApiPreference::Cgl) }
        .map_err(|error| format!("OpenGL display: {error}"))?;
    let template = ConfigTemplateBuilder::new().with_alpha_size(8).build();
    let config = unsafe { display.find_configs(template) }
        .map_err(|error| format!("OpenGL config: {error}"))?
        .next()
        .ok_or_else(|| "No compatible OpenGL configuration was found.".to_string())?;
    let context_attributes = ContextAttributesBuilder::new()
        .with_context_api(ContextApi::OpenGl(Some(Version::new(3, 2))))
        .build(Some(raw_window));
    let not_current = unsafe { display.create_context(&config, &context_attributes) }
        .map_err(|error| format!("OpenGL context: {error}"))?;
    let one = NonZeroU32::new(1).unwrap();
    let attributes = SurfaceAttributesBuilder::<WindowSurface>::new().build(raw_window, one, one);
    let surface = unsafe { display.create_window_surface(&config, &attributes) }
        .map_err(|error| format!("OpenGL surface: {error}"))?;
    let context = not_current
        .make_current(&surface)
        .map_err(|error| format!("OpenGL make current: {error}"))?;

    let mpv = Mpv::with_initializer(|init| {
        init.set_option("vo", "libmpv")?;
        init.set_option("load-scripts", true)?;
        init.set_option("osc", true)?;
        init.set_option("ytdl", false)?;
        init.set_option("hwdec", "auto-safe")?;
        Ok(())
    })
    .map_err(|error| format!("mpv initialize: {error}"))?;
    let mut render_context = mpv
        .create_render_context(vec![
            RenderParam::ApiType(RenderParamApiType::OpenGl),
            RenderParam::InitParams(OpenGLInitParams {
                get_proc_address,
                ctx: display.clone(),
            }),
        ])
        .map_err(|error| format!("mpv render context: {error}"))?;
    let redraw = Arc::new(AtomicBool::new(true));
    let redraw_signal = redraw.clone();
    render_context.set_update_callback(move || redraw_signal.store(true, Ordering::Release));

    let event_client = mpv
        .create_client(Some("tjxy_events"))
        .map_err(|error| format!("mpv event client: {error}"))?;
    event_client
        .disable_deprecated_events()
        .map_err(|error| format!("mpv event setup: {error}"))?;
    mpv.set_property("pause", !request.autoplay)
        .map_err(|error| format!("mpv pause property: {error}"))?;
    mpv.command("loadfile", &[&url, "replace"])
        .map_err(|error| format!("mpv loadfile: {error}"))?;

    let initial = snapshot(&mpv, &request.load_id, PlayerPhase::Loading);
    ready
        .send(Ok(initial.clone()))
        .map_err(|_| "player start was cancelled".to_string())?;
    let _ = app.emit(EVENT_NAME, PlayerEvent::State { snapshot: initial });

    let mut last_snapshot = Instant::now();
    let mut running = true;
    let mut resume_pending = request.start_position_ticks > 0;
    while running {
        match receiver.recv_timeout(Duration::from_millis(8)) {
            Ok(WorkerCommand::Player(command)) => apply_command(&mpv, command)?,
            Ok(WorkerCommand::Viewport(viewport)) => {
                update_native_view(app, native_view, viewport);
                let width = NonZeroU32::new(viewport.width.max(1.0).round() as u32).unwrap();
                let height = NonZeroU32::new(viewport.height.max(1.0).round() as u32).unwrap();
                surface.resize(&context, width, height);
                redraw.store(true, Ordering::Release);
            }
            Ok(WorkerCommand::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                running = false
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        while let Some(event) = event_client.wait_event(0.0) {
            match event {
                Ok(Event::FileLoaded) if resume_pending => {
                    let start_seconds =
                        (request.start_position_ticks.max(0) as f64 / TICKS_PER_SECOND).to_string();
                    mpv.command("seek", &[&start_seconds, "absolute+exact"])
                        .map_err(|error| format!("mpv resume seek: {error}"))?;
                    resume_pending = false;
                }
                Ok(Event::EndFile(_)) if running => {
                    let ended = snapshot(&mpv, &request.load_id, PlayerPhase::Ended);
                    let _ = app.emit(
                        EVENT_NAME,
                        PlayerEvent::Ended {
                            load_id: request.load_id.clone(),
                            position_ticks: ended.position_ticks,
                        },
                    );
                }
                Ok(_) => {}
                Err(error) => emit_error(app, &request.load_id, "mpv-event", error.to_string()),
            }
        }

        if redraw.swap(false, Ordering::AcqRel) {
            let flags = render_context
                .update()
                .map_err(|error| format!("mpv render update: {error}"))?;
            if flags & mpv_render_update::Frame != 0 {
                let width = surface.width().unwrap_or(1).max(1) as i32;
                let height = surface.height().unwrap_or(1).max(1) as i32;
                render_context
                    .render::<Display>(0, width, height, true)
                    .map_err(|error| format!("mpv render frame: {error}"))?;
                surface
                    .swap_buffers(&context)
                    .map_err(|error| format!("OpenGL swap buffers: {error}"))?;
                render_context.report_swap();
            }
        }

        if last_snapshot.elapsed() >= Duration::from_millis(250) {
            let phase = if mpv
                .get_property::<bool>("paused-for-cache")
                .unwrap_or(false)
            {
                PlayerPhase::Buffering
            } else if mpv.get_property::<bool>("pause").unwrap_or(false) {
                PlayerPhase::Paused
            } else {
                PlayerPhase::Playing
            };
            let _ = app.emit(
                EVENT_NAME,
                PlayerEvent::State {
                    snapshot: snapshot(&mpv, &request.load_id, phase),
                },
            );
            last_snapshot = Instant::now();
        }
    }

    let _ = mpv.command("stop", &[]);
    drop(event_client);
    drop(render_context);
    let _ = context.make_not_current();
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_command(mpv: &libmpv2::Mpv, command: PlayerCommand) -> Result<(), String> {
    match command {
        PlayerCommand::Play => mpv.set_property("pause", false),
        PlayerCommand::Pause => mpv.set_property("pause", true),
        PlayerCommand::Seek { position_ticks } => {
            let seconds = (position_ticks.max(0) as f64 / TICKS_PER_SECOND).to_string();
            mpv.command("seek", &[&seconds, "absolute+exact"])
        }
        PlayerCommand::SetVolume { volume } => mpv.set_property("volume", volume.clamp(0.0, 100.0)),
        PlayerCommand::SetMuted { muted } => mpv.set_property("mute", muted),
        PlayerCommand::SetPlaybackRate { playback_rate } => {
            mpv.set_property("speed", playback_rate.clamp(0.25, 4.0))
        }
    }
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn snapshot(mpv: &libmpv2::Mpv, load_id: &str, phase: PlayerPhase) -> PlayerSnapshot {
    let seconds = mpv.get_property::<f64>("time-pos").unwrap_or(0.0).max(0.0);
    let duration = mpv
        .get_property::<f64>("duration")
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0);
    PlayerSnapshot {
        load_id: load_id.to_string(),
        phase,
        position_ticks: (seconds * TICKS_PER_SECOND).round() as i64,
        duration_ticks: duration.map(|value| (value * TICKS_PER_SECOND).round() as i64),
        seekable: mpv.get_property::<bool>("seekable").unwrap_or(false),
        volume: mpv.get_property::<f64>("volume").unwrap_or(100.0),
        muted: mpv.get_property::<bool>("mute").unwrap_or(false),
        playback_rate: mpv.get_property::<f64>("speed").unwrap_or(1.0),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_source_url;

    #[test]
    fn accepts_same_origin_http_source() {
        assert!(validate_source_url(
            "https://example.test/Videos/1/stream?PlaybackTicket=secret",
            "https://example.test/",
        )
        .is_ok());
    }

    #[test]
    fn rejects_cross_origin_source() {
        assert!(
            validate_source_url("https://cdn.example.test/video", "https://example.test").is_err()
        );
    }

    #[test]
    fn rejects_credentials_and_fragments() {
        assert!(
            validate_source_url("https://user@example.test/video", "https://example.test").is_err()
        );
        assert!(validate_source_url(
            "https://example.test/video#fragment",
            "https://example.test"
        )
        .is_err());
    }
}
