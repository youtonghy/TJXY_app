use tauri::AppHandle;

mod player;

#[tauri::command]
async fn desktop_player_open(
    app: AppHandle,
    request: player::OpenRequest,
    viewport: player::Viewport,
) -> Result<player::PlayerSnapshot, String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || player::open(&worker, request, viewport))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn desktop_player_command(
    app: AppHandle,
    load_id: String,
    command: player::PlayerCommand,
) -> Result<(), String> {
    player::command(&app, &load_id, command)
}

#[tauri::command]
fn desktop_player_set_viewport(
    app: AppHandle,
    load_id: String,
    viewport: player::Viewport,
) -> Result<(), String> {
    player::set_viewport(&app, &load_id, viewport)
}

#[tauri::command]
async fn desktop_player_close(app: AppHandle, load_id: Option<String>) -> Result<(), String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || player::close(&worker, load_id.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(player::PlayerCell::new())
        .invoke_handler(tauri::generate_handler![
            desktop_player_open,
            desktop_player_command,
            desktop_player_set_viewport,
            desktop_player_close
        ])
        .build(tauri::generate_context!())
        .expect("error while running TJXY desktop");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let _ = player::close(app, None);
        }
    });
}
