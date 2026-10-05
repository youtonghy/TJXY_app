use tauri::AppHandle;

mod player;
mod server;

const PLAYER_INTERCEPT_SCRIPT: &str = include_str!("player_intercept.js");

#[tauri::command]
async fn desktop_player_open(app: AppHandle, request: player::OpenRequest) -> Result<(), String> {
    let worker = app.clone();
    let item_id = request.item_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || player::open(&worker, request))
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    match &result {
        Ok(()) => eprintln!("player: opened item {item_id}"),
        Err(error) => eprintln!("player: failed to open item {item_id}: {error}"),
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("tjxy-player")
                .js_init_script(PLAYER_INTERCEPT_SCRIPT.to_string())
                .build(),
        )
        .manage(player::PlayerCell::new())
        .invoke_handler(tauri::generate_handler![desktop_player_open])
        .build(tauri::generate_context!())
        .expect("error while running TJXY desktop");
    app.run(|app, event| {
        // Closing the player joins its worker and flushes the final playback
        // report, which must not block the main thread the worker relies on.
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if player::is_active(app) {
                api.prevent_exit();
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Err(error) = player::close(&app, None) {
                        eprintln!("player shutdown failed: {error}");
                    }
                    app.exit(0);
                });
            }
        }
    });
}
