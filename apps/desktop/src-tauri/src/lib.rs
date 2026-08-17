use tauri::AppHandle;

mod player;

#[tauri::command]
async fn start_stream_proxy(
    app: AppHandle,
    url: String,
    server_origin: String,
    start_position_seconds: f64,
) -> Result<String, String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        player::start_proxy(&worker, url, server_origin, start_position_seconds)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn stop_stream_proxy(app: AppHandle) -> Result<(), String> {
    player::stop_proxy(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(player::ProxyCell(std::sync::Arc::new(
            std::sync::Mutex::new(None),
        )))
        .invoke_handler(tauri::generate_handler![
            start_stream_proxy,
            stop_stream_proxy
        ])
        .build(tauri::generate_context!())
        .expect("error while running TJXY desktop");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let _ = player::stop_proxy(app);
        }
    });
}
