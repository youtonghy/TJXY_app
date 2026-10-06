//! stdio JSON-lines protocol between the Electron main process and this
//! helper. The parent writes the open request as the first stdin line and
//! may send `{"type":"shutdown"}` later; the helper emits
//! `{"type":"ready"|"error"|"closed"}` lines on stdout.

use serde::Deserialize;
use std::io::{BufRead, Write};
use winit::event_loop::EventLoopProxy;

use crate::app::HostEvent;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub server_origin: String,
    #[serde(default)]
    pub access_token: String,
    pub item_id: String,
}

/// Blocks until the parent sends the open request (the first stdin line).
pub fn read_open_request() -> Result<OpenRequest, String> {
    let stdin = std::io::stdin();
    let mut line = String::new();
    match stdin.lock().read_line(&mut line) {
        Ok(0) => Err("播放请求缺失。".into()),
        Ok(_) => {
            serde_json::from_str(line.trim()).map_err(|error| format!("播放请求无效：{error}"))
        }
        Err(error) => Err(format!("无法读取播放请求：{error}")),
    }
}

/// Watches stdin for `shutdown` lines or EOF (parent died) and asks the event
/// loop to close the player gracefully.
pub fn spawn_stdin_watch(proxy: EventLoopProxy<HostEvent>) {
    let spawned = std::thread::Builder::new()
        .name("tjxy-player-stdin".into())
        .spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                let wants_shutdown = serde_json::from_str::<serde_json::Value>(line.trim())
                    .ok()
                    .and_then(|value| {
                        value
                            .get("type")
                            .and_then(|t| t.as_str())
                            .map(str::to_string)
                    })
                    .is_some_and(|kind| kind == "shutdown");
                if wants_shutdown {
                    let _ = proxy.send_event(HostEvent::RequestClose);
                    return;
                }
            }
            // stdin closed: the parent is gone, shut down rather than linger.
            let _ = proxy.send_event(HostEvent::RequestClose);
        });
    if let Err(error) = spawned {
        eprintln!("player stdin watch failed: {error}");
    }
}

pub fn emit(event: serde_json::Value) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = serde_json::to_writer(&mut out, &event);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

pub fn emit_ready() {
    emit(serde_json::json!({ "type": "ready" }));
}

pub fn emit_error(message: &str) {
    emit(serde_json::json!({ "type": "error", "message": message }));
}

pub fn emit_closed() {
    emit(serde_json::json!({ "type": "closed" }));
}
