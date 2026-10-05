//! Dedicated native player window. The web `/app` client only hands over the
//! item id and session; this module fetches playback data from the server,
//! plays the stream with libmpv and reports progress on its own.

use crate::server::{PlaybackSource, PlaybackTicket, Session};
use serde::Deserialize;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod macos_view;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub server_origin: String,
    pub access_token: String,
    pub item_id: String,
}

/// Input forwarded from the native view to mpv's input system.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Input {
    Mouse { x: i64, y: i64 },
    Button { name: &'static str, down: bool },
    Key(String),
}

/// Playback data fetched from the server before the stream is opened.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Media {
    pub title: String,
    pub resume_ticks: i64,
    pub user_id: Option<String>,
    pub play_session_id: String,
    pub sources: Vec<PlaybackSource>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum WorkerCommand {
    Input(Input),
    Resize {
        width: u32,
        height: u32,
    },
    Loaded(Result<Media, String>),
    /// Results of background requests carry the source generation they were
    /// started for, so answers for a replaced source are discarded.
    Ticket {
        generation: u64,
        result: Result<PlaybackTicket, String>,
    },
    Subtitle {
        generation: u64,
        title: String,
        language: Option<String>,
        select: bool,
        result: Result<String, String>,
    },
    Shutdown,
}

struct PlayerWorker {
    id: String,
    sender: mpsc::Sender<WorkerCommand>,
    thread: Option<JoinHandle<()>>,
    window: tauri::Window,
}

impl PlayerWorker {
    fn stop(mut self) {
        let _ = self.window.hide();
        let _ = self.sender.send(WorkerCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Err(error) = self.window.destroy() {
            eprintln!("player window destroy failed: {error}");
        }
    }
}

pub struct PlayerCell(Arc<Mutex<Option<PlayerWorker>>>);

impl PlayerCell {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

pub fn open(app: &AppHandle, request: OpenRequest) -> Result<(), String> {
    if request.item_id.trim().is_empty() {
        return Err("缺少要播放的条目。".into());
    }
    let session = Session::new(&request.server_origin, &request.access_token)?;
    close(app, None)?;
    start(app, session, request.item_id)
}

#[cfg(target_os = "macos")]
fn start(app: &AppHandle, session: Session, item_id: String) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let window = tauri::window::WindowBuilder::new(app, format!("player-{id}"))
        .title("正在加载…")
        .inner_size(1280.0, 720.0)
        .min_inner_size(480.0, 270.0)
        .center()
        .focused(true)
        .build()
        .map_err(|error| format!("无法创建播放窗口：{error}"))?;
    let (sender, receiver) = mpsc::channel();
    let view = match macos_view::attach(app, &window, sender.clone()) {
        Ok(view) => view,
        Err(error) => {
            let _ = window.destroy();
            return Err(error);
        }
    };

    let events = sender.clone();
    let close_app = app.clone();
    let close_id = id.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(size) => {
            let _ = events.send(WorkerCommand::Resize {
                width: size.width,
                height: size.height,
            });
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            request_close(&close_app, &close_id);
        }
        _ => {}
    });

    let worker_app = app.clone();
    let worker_window = window.clone();
    let worker_id = id.clone();
    let worker_sender = sender.clone();
    let thread = thread::Builder::new()
        .name("tjxy-player".into())
        .spawn(move || {
            if let Err(message) = macos::run(macos::Context {
                window: worker_window.clone(),
                session,
                item_id,
                view,
                receiver,
                sender: worker_sender,
            }) {
                eprintln!("player failed: {message}");
                let _ = worker_window.set_title(&format!("播放失败：{message}"));
                return;
            }
            request_close(&worker_app, &worker_id);
        })
        .map_err(|error| {
            let _ = window.destroy();
            error.to_string()
        })?;

    let cell = player_cell(app)?;
    let mut slot = cell
        .lock()
        .map_err(|_| "player state is unavailable".to_string())?;
    *slot = Some(PlayerWorker {
        id,
        sender,
        thread: Some(thread),
        window,
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn start(_app: &AppHandle, _session: Session, _item_id: String) -> Result<(), String> {
    Err("当前桌面平台暂不支持内置播放器。".into())
}

/// Stops the active player (or only the one with `id`) and closes its window.
/// Blocks until the worker has reported the final position, so it must not
/// run on the main thread.
pub fn close(app: &AppHandle, id: Option<&str>) -> Result<(), String> {
    let cell = player_cell(app)?;
    let worker = {
        let mut slot = cell
            .lock()
            .map_err(|_| "player state is unavailable".to_string())?;
        if id.is_some_and(|id| slot.as_ref().is_some_and(|worker| worker.id != id)) {
            return Ok(());
        }
        slot.take()
    };
    if let Some(worker) = worker {
        worker.stop();
    }
    Ok(())
}

pub fn is_active(app: &AppHandle) -> bool {
    player_cell(app)
        .ok()
        .and_then(|cell| cell.lock().ok().map(|slot| slot.is_some()))
        .unwrap_or(false)
}

/// Closes the player from callbacks that may run on the main thread or on the
/// worker itself, where joining the worker inline would deadlock.
fn request_close(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    let spawned = thread::Builder::new()
        .name("tjxy-player-close".into())
        .spawn(move || {
            if let Err(error) = close(&app, Some(&id)) {
                eprintln!("player close failed: {error}");
            }
        });
    if let Err(error) = spawned {
        eprintln!("player close thread failed: {error}");
    }
}

fn player_cell(app: &AppHandle) -> Result<Arc<Mutex<Option<PlayerWorker>>>, String> {
    app.try_state::<PlayerCell>()
        .map(|cell| cell.0.clone())
        .ok_or_else(|| "player state missing".to_string())
}
