//! macOS player worker: owns the OpenGL surface and libmpv, drives the
//! load → ticket → play state machine and reports playback to the server.

use super::{macos_view, Control, Media, Status, Track, TrackKind, UiState, WorkerCommand};
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
const NOTICE_DURATION: Duration = Duration::from_secs(4);
const DEFAULT_SUB_MARGIN: f64 = 22.0;

pub struct Context {
    pub app: tauri::AppHandle,
    pub id: String,
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
        app,
        id,
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
    // glutin's CGL surface reads its size through a synchronous hop to the
    // main thread, so the render size is tracked here from resize events.
    let mut render_size = (non_zero(size.width), non_zero(size.height));
    let gl_context = not_current
        .make_current(&surface)
        .map_err(|error| format!("OpenGL make current: {error}"))?;

    let mpv = Mpv::with_initializer(|init| {
        init.set_option("vo", "libmpv")?;
        init.set_option("idle", "yes")?;
        init.set_option("force-window", "yes")?;
        init.set_option("keep-open", "no")?;
        // Native AppKit controls replace mpv's on-screen controller and bars.
        init.set_option("osc", false)?;
        init.set_option("osd-bar", false)?;
        init.set_option("osd-on-seek", "no")?;
        init.set_option("load-scripts", true)?;
        init.set_option("ytdl", false)?;
        init.set_option("hwdec", "auto-safe")?;
        init.set_option("input-default-bindings", "yes")?;
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

    let mut controller = Controller::new(session, item_id, sender, window.clone(), app, id);
    controller.status = Status::Loading("正在加载…".into());
    controller.load_media();
    controller.push(&mpv);

    let mut last_poll = Instant::now();
    let mut ended = false;
    let mut failure = None;
    'player: loop {
        match receiver.recv_timeout(Duration::from_millis(8)) {
            Ok(WorkerCommand::Control(control)) => controller.on_control(&mpv, control),
            Ok(WorkerCommand::Resize { width, height }) => {
                render_size = (non_zero(width), non_zero(height));
                surface.resize(&gl_context, render_size.0, render_size.1);
                redraw.store(true, Ordering::Release);
                controller.sync_window_fullscreen(&mpv);
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
                    let width = render_size.0.get() as i32;
                    let height = render_size.1.get() as i32;
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
            controller.sync_mpv_fullscreen(&mpv);
            controller.push(&mpv);
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
    app: tauri::AppHandle,
    id: String,
    status: Status,
    notice: Option<(String, Instant)>,
    fullscreen: bool,
}

impl Controller {
    fn new(
        session: Session,
        item_id: String,
        sender: mpsc::Sender<WorkerCommand>,
        window: tauri::Window,
        app: tauri::AppHandle,
        id: String,
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
            app,
            id,
            status: Status::Loading(String::new()),
            notice: None,
            fullscreen: false,
        }
    }

    fn notify(&mut self, message: String) {
        eprintln!("player: {message}");
        self.notice = Some((message, Instant::now()));
    }

    fn fail(&mut self, message: &str) {
        eprintln!("player: {message}");
        self.status = Status::Error(message.to_string());
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
            Err(error) => return self.fail(&error),
        };
        let _ = self.window.set_title(&media.title);
        let _ = mpv.set_property("force-media-title", media.title.as_str());
        self.position_ticks = media.resume_ticks;
        let play_session_id = media.play_session_id.clone();
        let has_sources = !media.sources.is_empty();
        self.media = Some(media);
        if has_sources {
            self.begin_source(0, play_session_id);
        } else {
            self.fail("此影片没有可直接播放的视频源。");
        }
    }

    fn begin_source(&mut self, index: usize, play_session_id: String) {
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
        self.status = Status::Loading("正在连接视频源…".into());
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
            Ok(()) => {}
            Err(error) => self.on_playback_error(mpv, format!("无法打开视频流：{error}")),
        }
    }

    fn on_file_loaded(&mut self) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        active.loaded = true;
        self.status = Status::Ready;
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
        &mut self,
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
            self.notify(error);
        }
    }

    /// A source failed before or during playback: fall back to the next
    /// direct-play source at the current position, or surface the error.
    fn on_playback_error(&mut self, mpv: &libmpv2::Mpv, message: String) {
        let Some(active) = self.active.take() else {
            return self.fail(&message);
        };
        let media_source_id = active.media_source(self);
        self.end_source(active.ticket, active.started, &media_source_id, active.play_session_id);
        let next = active.index + 1;
        if self.source(next).is_some() {
            self.begin_source(next, uuid::Uuid::new_v4().to_string());
            self.status = Status::Loading(format!("{message}\n正在尝试下一个视频源…"));
        } else {
            let _ = mpv.command("stop", &[]);
            self.fail(&message);
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

    fn on_control(&mut self, mpv: &libmpv2::Mpv, control: Control) {
        if let Control::SubtitleInset(fraction) = control {
            // sub-margin-y is in pixels of a 720-line reference frame.
            let margin = (fraction.clamp(0.0, 0.5) * 720.0).round().max(DEFAULT_SUB_MARGIN);
            if let Err(error) = mpv.set_property("sub-margin-y", margin as i64) {
                eprintln!("player subtitle margin failed: {error}");
            }
            return;
        }
        let loaded = self.active.as_ref().is_some_and(|active| active.loaded);
        let result = match control {
            // Unknown keys are rejected by mpv and are not actionable.
            Control::Key(key) => {
                let _ = mpv.command("keypress", &[&key]);
                Ok(())
            }
            Control::ToggleFullscreen => {
                self.set_fullscreen(mpv, !self.fullscreen);
                Ok(())
            }
            _ if !loaded => Ok(()),
            Control::TogglePause => mpv.command("cycle", &["pause"]),
            Control::SeekBy(seconds) => mpv.command("seek", &[&seconds.to_string(), "relative+exact"]),
            Control::SeekTo { seconds, exact } => mpv.command(
                "seek",
                &[
                    &seconds.max(0.0).to_string(),
                    if exact { "absolute+exact" } else { "absolute+keyframes" },
                ],
            ),
            Control::SetVolume(volume) => mpv
                .set_property("volume", volume.clamp(0.0, 100.0))
                .and_then(|_| mpv.set_property("mute", false)),
            Control::ToggleMute => mpv.command("cycle", &["mute"]),
            Control::SelectAudio(id) => mpv.set_property("aid", id),
            Control::SelectSubtitle(Some(id)) => mpv.set_property("sid", id),
            Control::SelectSubtitle(None) => mpv.set_property("sid", "no"),
            Control::SetSpeed(speed) => mpv.set_property("speed", speed.clamp(0.25, 4.0)),
            Control::SubtitleInset(_) => Ok(()),
        };
        if let Err(error) = result {
            eprintln!("player control failed: {error}");
        }
        self.push(mpv);
    }

    fn set_fullscreen(&mut self, mpv: &libmpv2::Mpv, fullscreen: bool) {
        self.fullscreen = fullscreen;
        let _ = mpv.set_property("fullscreen", fullscreen);
        if let Err(error) = self.window.set_fullscreen(fullscreen) {
            eprintln!("player fullscreen failed: {error}");
        }
    }

    /// The window was resized, possibly by the green button or Esc.
    fn sync_window_fullscreen(&mut self, mpv: &libmpv2::Mpv) {
        if let Ok(fullscreen) = self.window.is_fullscreen() {
            if fullscreen != self.fullscreen {
                self.fullscreen = fullscreen;
                let _ = mpv.set_property("fullscreen", fullscreen);
            }
        }
    }

    /// mpv key bindings (`f`, Esc) toggle mpv's own fullscreen property.
    fn sync_mpv_fullscreen(&mut self, mpv: &libmpv2::Mpv) {
        let fullscreen = mpv.get_property::<bool>("fullscreen").unwrap_or(false);
        if fullscreen != self.fullscreen {
            self.set_fullscreen(mpv, fullscreen);
        }
    }

    fn push(&mut self, mpv: &libmpv2::Mpv) {
        if self
            .notice
            .as_ref()
            .is_some_and(|(_, shown)| shown.elapsed() >= NOTICE_DURATION)
        {
            self.notice = None;
        }
        let loaded = self.active.as_ref().is_some_and(|active| active.loaded);
        let number = |name: &str, fallback: f64| {
            mpv.get_property::<f64>(name)
                .ok()
                .filter(|value| value.is_finite())
                .unwrap_or(fallback)
        };
        let flag = |name: &str| mpv.get_property::<bool>(name).unwrap_or(false);
        let state = UiState {
            status: self.status.clone(),
            notice: self.notice.as_ref().map(|(text, _)| text.clone()),
            position: if loaded {
                number("time-pos", 0.0).max(0.0)
            } else {
                self.position_ticks as f64 / TICKS_PER_SECOND
            },
            duration: if loaded { number("duration", 0.0).max(0.0) } else { 0.0 },
            paused: !loaded || flag("pause"),
            buffering: loaded && flag("paused-for-cache"),
            volume: number("volume", 100.0),
            muted: flag("mute"),
            speed: number("speed", 1.0),
            fullscreen: self.fullscreen,
            tracks: if loaded { read_tracks(mpv) } else { Vec::new() },
        };
        macos_view::update(&self.app, &self.id, state);
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

fn read_tracks(mpv: &libmpv2::Mpv) -> Vec<Track> {
    let count = mpv.get_property::<i64>("track-list/count").unwrap_or(0);
    (0..count)
        .filter_map(|index| {
            let property = |name: &str| format!("track-list/{index}/{name}");
            let text = |name: &str| {
                mpv.get_property::<String>(&property(name))
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            };
            let kind = match text("type")?.as_str() {
                "audio" => TrackKind::Audio,
                "sub" => TrackKind::Subtitle,
                _ => return None,
            };
            let id = mpv.get_property::<i64>(&property("id")).ok()?;
            let title = text("title");
            let language = text("lang");
            let codec = text("codec").map(|codec| codec.to_uppercase());
            let mut label = match (title, language) {
                (Some(title), Some(language)) if !title.contains(&language) => format!("{title}（{language}）"),
                (Some(title), _) => title,
                (None, Some(language)) => language,
                (None, None) => format!("轨道 {id}"),
            };
            if let Some(codec) = codec {
                label.push_str(&format!(" · {codec}"));
            }
            Some(Track {
                id,
                kind,
                label,
                selected: mpv.get_property::<bool>(&property("selected")).unwrap_or(false),
            })
        })
        .collect()
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
