//! Shared types between the window host, the render worker and the macOS
//! chrome. Platform-neutral: the worker is driven entirely through
//! `WorkerCommand` and reports back through `Host`.

use crate::server::{PlaybackSource, PlaybackTicket};
use std::sync::mpsc;

/// Actions from the player controls and the window's input events.
/// Some variants are only constructed on platforms that forward input to
/// mpv's on-screen controller (non-macOS).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub enum Control {
    /// A key press forwarded to mpv's default key bindings.
    Key(String),
    /// Mouse position in physical pixels, for the mpv on-screen controller.
    MouseMove {
        x: f64,
        y: f64,
    },
    /// A mouse button edge; `button` uses mpv numbering (0=left, 1=middle,
    /// 2=right). Needed for OSC dragging on platforms without native chrome.
    MouseButton {
        x: f64,
        y: f64,
        button: i32,
        pressed: bool,
    },
    /// Scroll wheel steps forwarded to mpv's key bindings.
    Wheel {
        lines: i32,
    },
    TogglePause,
    SeekBy(f64),
    SeekTo {
        seconds: f64,
        exact: bool,
    },
    SetVolume(f64),
    ToggleMute,
    SelectAudio(i64),
    SelectSubtitle(Option<i64>),
    SetSpeed(f64),
    ToggleFullscreen,
    /// Fraction of the view height covered by the control bar.
    SubtitleInset(f64),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Audio,
    Subtitle,
}

#[derive(Clone)]
pub struct Track {
    pub id: i64,
    pub kind: TrackKind,
    pub label: String,
    pub selected: bool,
}

/// What the player overlay shows in place of the video.
#[derive(Clone, PartialEq)]
pub enum Status {
    Loading(String),
    Error(String),
    Ready,
}

/// Snapshot of the playback state rendered by the native controls.
#[derive(Clone)]
pub struct UiState {
    pub status: Status,
    pub notice: Option<String>,
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub buffering: bool,
    pub volume: f64,
    pub muted: bool,
    pub speed: f64,
    pub fullscreen: bool,
    pub tracks: Vec<Track>,
}

/// Playback data fetched from the server before the stream is opened.
pub struct Media {
    pub title: String,
    pub resume_ticks: i64,
    pub user_id: Option<String>,
    pub play_session_id: String,
    pub sources: Vec<PlaybackSource>,
}

pub enum WorkerCommand {
    Control(Control),
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

pub type WorkerSender = mpsc::Sender<WorkerCommand>;
