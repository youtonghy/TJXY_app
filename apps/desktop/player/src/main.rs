//! tjxy-player: standalone mpv playback helper for the TJXY Electron desktop
//! app. The parent writes the open request as the first stdin line
//! (`{"serverOrigin","accessToken","itemId"}`) and may send
//! `{"type":"shutdown"}` later; the helper emits
//! `{"type":"ready"|"error"|"closed"}` JSON lines on stdout and exits after
//! the playback window closes.

mod app;
#[cfg(target_os = "macos")]
mod chrome;
#[cfg(target_os = "macos")]
mod gcd;
mod protocol;
mod server;
mod types;
mod worker;

use server::Session;

fn main() {
    let code = run();
    if code != 0 {
        std::process::exit(code);
    }
}

fn run() -> i32 {
    let request = match protocol::read_open_request() {
        Ok(request) => request,
        Err(message) => {
            protocol::emit_error(&message);
            return 2;
        }
    };
    let session = match Session::new(&request.server_origin, &request.access_token) {
        Ok(session) => session,
        Err(message) => {
            protocol::emit_error(&message);
            return 2;
        }
    };
    match app::run(session, request.item_id) {
        Ok(()) => {
            protocol::emit_closed();
            0
        }
        Err(message) => {
            protocol::emit_error(&message);
            protocol::emit_closed();
            eprintln!("tjxy-player: {message}");
            1
        }
    }
}
