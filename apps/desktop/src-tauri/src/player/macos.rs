//! macOS player worker: owns the OpenGL surface and libmpv, drives the
//! load → ticket → play state machine and reports playback to the server.

use super::{Input, Media, WorkerCommand};
use crate::server::{
    playable_sources, PlaybackReport, PlaybackSource, PlaybackState, PlaybackTicket, Session,
};
use std::ffi::{c_void, CString};
use std::num::NonZeroU32;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const TICKS_PER_SECOND: f64 = 10_000_000.0;
const PROGRESS_INTERVAL: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const MESSAGE_MS: u32 = 4_000;
const PERSISTENT_MS: u32 = 3_600_000;

pub struct Context {
    pub window: tauri::Window,
    pub session: Session,
    pub item_id: String,
    pub view: usize,
    pub receiver: mpsc::Receiver<WorkerCommand>,
    pub sender: mpsc::Sender<WorkerCommand>,
}

pub fn run(context: Context) -> Result<(), String> {
    use glutin::config::ConfigTemplateBuilder;
    use glutin::context::{ContextApi, ContextAttributesBuilder, NotCurrentGlContext, Version};
    use glutin::display::{Display, DisplayApiPreference, GlDisplay};
    use glutin::prelude::*;
    use glutin::surface::{GlSurface, SurfaceAttributesBuilder, WindowSurface};
    use libmpv2::events::Event;
    use libmpv2::mpv_end_file_reason;
    use libmpv2::render::{mpv_render_update, OpenGLInitParams, RenderParam, RenderParamApiType};
    use libmpv2::Mpv;
    use raw_window_handle::{
        AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle,
    };

    fn get_proc_address(display: &Display, name: &str) -> *mut c_void {
        CString::new(name)
            .ok()
            .map(|name| display.get_proc_address(&name) as *mut c_void)
            .unwrap_or(std::ptr::null_mut())
    }

    let Context {
        window,
        session,
        item_id,
        view,
        receiver,
        sender,
    } = context;

    let view = NonNull::new(view as *mut c_void)
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
    let size = window
        .inner_size()
        .map_err(|error| format!("player window size: {error}"))?;
    let attributes = SurfaceAttributesBuilder::<WindowSurface>::new().build(
        raw_window,
        non_zero(size.width),
        non_zero(size.height),
    );
    let surface = unsafe { display.create_window_surface(&config, &attributes) }
        .map_err(|error| format!("OpenGL surface: {error}"))?;
    let gl_context = not_current
        .make_current(&surface)
        .map_err(|error| format!("OpenGL make current: {error}"))?;

    // The render API cannot report the display's HiDPI scale to scripts, so
    // the OSC is scaled explicitly.
    let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
    let mpv = Mpv::with_initializer(|init| {
        init.set_option("vo", "libmpv")?;
        init.set_option("idle", "yes")?;
        init.set_option("force-window", "yes")?;
        init.set_option("keep-open", "no")?;
        init.set_option("osc", true)?;
        init.set_option("load-scripts", true)?;
        init.set_option("ytdl", false)?;
        init.set_option("hwdec", "auto-safe")?;
        init.set_option("input-default-bindings", "yes")?;
        init.set_option(
            "script-opts",
            format!("osc-scalewindowed={scale},osc-scalefullscreen={scale}").as_str(),
        )?;
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

    let mut controller = Controller::new(session, item_id, sender, window.clone());
    controller.show(&mpv, "正在加载…", PERSISTENT_MS);
    controller.load_media();

    let mut last_poll = Instant::now();
    let mut mpv_fullscreen = false;
    let mut ended = false;
    let mut failure = None;
    'player: loop {
        match receiver.recv_timeout(Duration::from_millis(8)) {
            Ok(WorkerCommand::Input(input)) => apply_input(&mpv, input),
            Ok(WorkerCommand::Resize { width, height }) => {
                surface.resize(&gl_context, non_zero(width), non_zero(height));
                redraw.store(true, Ordering::Release);
                if let Ok(fullscreen) = window.is_fullscreen() {
                    if fullscreen != mpv_fullscreen {
                        mpv_fullscreen = fullscreen;
                        let _ = mpv.set_property("fullscreen", fullscreen);
                    }
                }
            }
            Ok(WorkerCommand::Loaded(result)) => controller.on_loaded(&mpv, result),
            Ok(WorkerCommand::Ticket { generation, result }) => {
                controller.on_ticket(&mpv, generation, result)
            }
            Ok(WorkerCommand::Subtitle {
                generation,
                title,
                language,
                select,
                result,
            }) => controller.on_subtitle(&mpv, generation, &title, language.as_deref(), select, result),
            Ok(WorkerCommand::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        while let Some(event) = event_client.wait_event(0.0) {
            match event {
                Ok(Event::FileLoaded) => controller.on_file_loaded(),
                Ok(Event::EndFile(reason)) if reason == mpv_end_file_reason::Eof => {
                    ended = true;
                    break 'player;
                }
                Ok(Event::Shutdown) => break 'player,
                Ok(_) => {}
                Err(error) => controller.on_playback_error(&mpv, format!("播放出错：{error}")),
            }
        }

        if redraw.swap(false, Ordering::AcqRel) {
            let rendered = (|| {
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
                        .swap_buffers(&gl_context)
                        .map_err(|error| format!("OpenGL swap buffers: {error}"))?;
                    render_context.report_swap();
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = rendered {
                failure = Some(error);
                break;
            }
        }

        if last_poll.elapsed() >= POLL_INTERVAL {
            last_poll = Instant::now();
            controller.poll(&mpv);
            let fullscreen = mpv.get_property::<bool>("fullscreen").unwrap_or(false);
            if fullscreen != mpv_fullscreen {
                mpv_fullscreen = fullscreen;
                if let Err(error) = window.set_fullscreen(fullscreen) {
                    eprintln!("player fullscreen failed: {error}");
                }
            }
        }
    }

    controller.finish(ended);
    let _ = mpv.command("stop", &[]);
    drop(event_client);
    drop(render_context);
    drop(mpv);
    let _ = gl_context.make_not_current();
    failure.map_or(Ok(()), Err)
}

fn apply_input(mpv: &libmpv2::Mpv, input: Input) {
    // Unknown keys or coordinates outside the video are rejected by mpv;
    // neither is actionable, so the result is intentionally ignored.
    let _ = match input {
        Input::Mouse { x, y } => mpv.command("mouse", &[&x.to_string(), &y.to_string()]),
        Input::Button { name, down } => {
            mpv.command(if down { "keydown" } else { "keyup" }, &[name])
        }
        Input::Key(key) => mpv.command("keypress", &[&key]),
    };
}

fn non_zero(value: u32) -> NonZeroU32 {
    NonZeroU32::new(value.max(1)).expect("value is at least one")
}

/// The source currently being played and its server-side playback session.
struct ActiveSource {
    generation: u64,
    index: usize,
    play_session_id: String,
    ticket: Option<PlaybackTicket>,
    loaded: bool,
    started: bool,
}

struct Controller {
    session: Session,
    item_id: String,
    sender: mpsc::Sender<WorkerCommand>,
    window: tauri::Window,
    reporter: Reporter,
    media: Option<Media>,
    active: Option<ActiveSource>,
    generation: u64,
    position_ticks: i64,
    paused: bool,
    last_progress: Instant,
}

impl Controller {
    fn new(
        session: Session,
        item_id: String,
        sender: mpsc::Sender<WorkerCommand>,
        window: tauri::Window,
    ) -> Self {
        Self {
            reporter: Reporter::new(session.clone()),
            session,
            item_id,
            sender,
            window,
            media: None,
            active: None,
            generation: 0,
            position_ticks: 0,
            paused: false,
            last_progress: Instant::now(),
        }
    }

    fn show(&self, mpv: &libmpv2::Mpv, text: &str, duration_ms: u32) {
        if let Err(error) = mpv.command("show-text", &[text, &duration_ms.to_string()]) {
            eprintln!("player message failed: {error}");
        }
    }

    fn fail(&self, mpv: &libmpv2::Mpv, message: &str) {
        eprintln!("player: {message}");
        self.show(mpv, message, PERSISTENT_MS);
        let _ = self.window.set_title(&format!("播放失败 · {message}"));
    }

    fn load_media(&self) {
        let session = self.session.clone();
        let item_id = self.item_id.clone();
        self.background(move || WorkerCommand::Loaded(load_media(&session, &item_id)));
    }

    fn on_loaded(&mut self, mpv: &libmpv2::Mpv, result: Result<Media, String>) {
        let media = match result {
            Ok(media) => media,
            Err(error) => return self.fail(mpv, &error),
        };
        let _ = self.window.set_title(&media.title);
        let _ = mpv.set_property("force-media-title", media.title.as_str());
        self.position_ticks = media.resume_ticks;
        let play_session_id = media.play_session_id.clone();
        let has_sources = !media.sources.is_empty();
        self.media = Some(media);
        if has_sources {
            self.begin_source(mpv, 0, play_session_id);
        } else {
            self.fail(mpv, "此影片没有可直接播放的视频源。");
        }
    }

    fn begin_source(&mut self, mpv: &libmpv2::Mpv, index: usize, play_session_id: String) {
        let Some(source) = self.source(index).cloned() else {
            return;
        };
        self.generation += 1;
        self.active = Some(ActiveSource {
            generation: self.generation,
            index,
            play_session_id: play_session_id.clone(),
            ticket: None,
            loaded: false,
            started: false,
        });
        self.show(mpv, "正在连接视频源…", PERSISTENT_MS);
        let generation = self.generation;
        let session = self.session.clone();
        let item_id = self.item_id.clone();
        self.background(move || WorkerCommand::Ticket {
            generation,
            result: session.issue_ticket(&item_id, &source.id, &play_session_id),
        });
    }

    fn on_ticket(
        &mut self,
        mpv: &libmpv2::Mpv,
        generation: u64,
        result: Result<PlaybackTicket, String>,
    ) {
        let current = self
            .active
            .as_ref()
            .is_some_and(|active| active.generation == generation);
        if !current {
            if let Ok(ticket) = result {
                self.reporter.send(Job::Revoke(ticket.id));
            }
            return;
        }
        let ticket = match result {
            Ok(ticket) => ticket,
            Err(error) => return self.on_playback_error(mpv, error),
        };
        let url = match self.session.resolve_same_origin(&ticket.stream_url) {
            Ok(url) => url,
            Err(error) => {
                self.reporter.send(Job::Revoke(ticket.id));
                return self.on_playback_error(mpv, error);
            }
        };
        if let Some(active) = self.active.as_mut() {
            active.ticket = Some(ticket);
        }
        let start = (self.position_ticks.max(0) as f64 / TICKS_PER_SECOND).to_string();
        let loaded = mpv
            .set_property("start", start.as_str())
            .and_then(|_| mpv.command("loadfile", &[url.as_str(), "replace"]));
        match loaded {
            Ok(()) => self.show(mpv, "", 1),
            Err(error) => self.on_playback_error(mpv, format!("无法打开视频流：{error}")),
        }
    }

    fn on_file_loaded(&mut self) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        active.loaded = true;
        let (generation, index) = (active.generation, active.index);
        let Some(source) = self.source(index).cloned() else {
            return;
        };
        let external = source.media_streams.into_iter().filter(|stream| {
            stream.kind.as_deref() == Some("Subtitle") && stream.is_external == Some(true)
        });
        for stream in external {
            let Some(delivery_url) = stream.delivery_url else {
                continue;
            };
            let session = self.session.clone();
            let title = stream
                .display_title
                .or_else(|| stream.language.clone())
                .unwrap_or_else(|| "外挂字幕".into());
            let language = stream.language;
            let select = stream.is_default == Some(true);
            self.background(move || WorkerCommand::Subtitle {
                generation,
                title,
                language,
                select,
                result: session.subtitle_text(&delivery_url),
            });
        }
    }

    fn on_subtitle(
        &self,
        mpv: &libmpv2::Mpv,
        generation: u64,
        title: &str,
        language: Option<&str>,
        select: bool,
        result: Result<String, String>,
    ) {
        if self.active.as_ref().map(|active| active.generation) != Some(generation) {
            return;
        }
        let added = result.and_then(|text| {
            mpv.command(
                "sub-add",
                &[
                    &format!("memory://{text}"),
                    if select { "select" } else { "auto" },
                    title,
                    language.unwrap_or(""),
                ],
            )
            .map_err(|error| format!("字幕加载失败：{error}"))
        });
        if let Err(error) = added {
            eprintln!("player subtitle: {error}");
            self.show(mpv, &error, MESSAGE_MS);
        }
    }

    /// A source failed before or during playback: fall back to the next
    /// direct-play source at the current position, or surface the error.
    fn on_playback_error(&mut self, mpv: &libmpv2::Mpv, message: String) {
        let Some(active) = self.active.take() else {
            return self.fail(mpv, &message);
        };
        let media_source_id = active.media_source(self);
        self.end_source(active.ticket, active.started, &media_source_id, active.play_session_id);
        let next = active.index + 1;
        if self.source(next).is_some() {
            self.show(mpv, &format!("{message}\n正在尝试下一个视频源…"), MESSAGE_MS);
            self.begin_source(mpv, next, uuid::Uuid::new_v4().to_string());
        } else {
            let _ = mpv.command("stop", &[]);
            self.fail(mpv, &message);
        }
    }

    fn poll(&mut self, mpv: &libmpv2::Mpv) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        if !active.loaded {
            return;
        }
        if let Ok(seconds) = mpv.get_property::<f64>("time-pos") {
            if seconds.is_finite() && seconds >= 0.0 {
                self.position_ticks = (seconds * TICKS_PER_SECOND).round() as i64;
            }
        }
        let paused = mpv.get_property::<bool>("pause").unwrap_or(false);
        let started = active.started;
        if !started && !paused {
            self.report(PlaybackReport::Start);
            if let Some(active) = self.active.as_mut() {
                active.started = true;
            }
            self.last_progress = Instant::now();
        } else if started && paused != self.paused {
            if paused {
                self.report(PlaybackReport::Progress);
            }
            self.last_progress = Instant::now();
        } else if started && !paused && self.last_progress.elapsed() >= PROGRESS_INTERVAL {
            self.report(PlaybackReport::Progress);
            self.last_progress = Instant::now();
        }
        self.paused = paused;
    }

    fn finish(mut self, ended: bool) {
        if let Some(active) = self.active.take() {
            let media_source_id = active.media_source(&self);
            self.end_source(active.ticket, active.started, &media_source_id, active.play_session_id);
        }
        if ended {
            if let Some(user_id) = self.media.as_ref().and_then(|media| media.user_id.clone()) {
                self.reporter.send(Job::Played {
                    user_id,
                    item_id: self.item_id.clone(),
                });
            }
        }
        self.reporter.finish();
    }

    fn end_source(
        &self,
        ticket: Option<PlaybackTicket>,
        started: bool,
        media_source_id: &str,
        play_session_id: String,
    ) {
        if started {
            self.reporter.send(Job::Report(
                PlaybackReport::Stop,
                PlaybackState {
                    item_id: self.item_id.clone(),
                    media_source_id: media_source_id.to_string(),
                    play_session_id,
                    position_ticks: self.position_ticks,
                },
            ));
        }
        if let Some(ticket) = ticket {
            self.reporter.send(Job::Revoke(ticket.id));
        }
    }

    fn report(&self, kind: PlaybackReport) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        self.reporter.send(Job::Report(
            kind,
            PlaybackState {
                item_id: self.item_id.clone(),
                media_source_id: active.media_source(self),
                play_session_id: active.play_session_id.clone(),
                position_ticks: self.position_ticks,
            },
        ));
    }

    fn source(&self, index: usize) -> Option<&PlaybackSource> {
        self.media.as_ref()?.sources.get(index)
    }

    /// Runs a blocking server request off the render thread and posts its
    /// result back to the worker.
    fn background(&self, job: impl FnOnce() -> WorkerCommand + Send + 'static) {
        let sender = self.sender.clone();
        let spawned = thread::Builder::new()
            .name("tjxy-player-request".into())
            .spawn(move || {
                let _ = sender.send(job());
            });
        if let Err(error) = spawned {
            eprintln!("player request thread failed: {error}");
        }
    }
}

impl ActiveSource {
    fn media_source(&self, controller: &Controller) -> String {
        controller
            .source(self.index)
            .map(|source| source.id.clone())
            .unwrap_or_default()
    }
}

fn load_media(session: &Session, item_id: &str) -> Result<Media, String> {
    let item = session.item(item_id)?;
    let info = session.playback_info(item_id)?;
    let play_session_id = info
        .play_session_id
        .ok_or_else(|| "服务器没有返回播放会话。".to_string())?;
    let user_id = match session.current_user_id() {
        Ok(id) => Some(id),
        Err(error) => {
            eprintln!("player: current user unavailable, watched state will not be set: {error}");
            None
        }
    };
    Ok(Media {
        title: item.name.unwrap_or_else(|| "TJXY".into()),
        resume_ticks: item
            .user_data
            .and_then(|data| data.playback_position_ticks)
            .unwrap_or(0)
            .max(0),
        user_id,
        play_session_id,
        sources: playable_sources(&info.media_sources),
    })
}

enum Job {
    Report(PlaybackReport, PlaybackState),
    Played { user_id: String, item_id: String },
    Revoke(String),
}

/// Sends playback reports in order on a dedicated thread so slow requests
/// never stall rendering.
struct Reporter {
    sender: Option<mpsc::Sender<Job>>,
    thread: Option<JoinHandle<()>>,
}

impl Reporter {
    fn new(session: Session) -> Self {
        let (sender, receiver) = mpsc::channel::<Job>();
        let thread = thread::Builder::new()
            .name("tjxy-player-report".into())
            .spawn(move || {
                for job in receiver {
                    let result = match &job {
                        Job::Report(kind, state) => session.report(*kind, state),
                        Job::Played { user_id, item_id } => session.mark_played(user_id, item_id),
                        Job::Revoke(ticket_id) => session.revoke_ticket(ticket_id),
                    };
                    if let Err(error) = result {
                        eprintln!("player report failed: {error}");
                    }
                }
            });
        match thread {
            Ok(thread) => Self {
                sender: Some(sender),
                thread: Some(thread),
            },
            Err(error) => {
                eprintln!("player report thread failed: {error}");
                Self {
                    sender: None,
                    thread: None,
                }
            }
        }
    }

    fn send(&self, job: Job) {
        if let Some(sender) = &self.sender {
            let _ = sender.send(job);
        }
    }

    /// Flushes queued reports; each request is bounded by the HTTP timeout.
    fn finish(mut self) {
        drop(self.sender.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
