use std::fs::{self, File};
use std::io::{copy, Cursor, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const USER_AGENT: &str = "TJXY-desktop (https://github.com/youtonghy/TJXY)";
const MAX_PROXY_CONNECTIONS: usize = 8;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(8);

pub struct StreamProxy {
    _port: u16,
    workdir: PathBuf,
    shutdown: Arc<AtomicBool>,
    ffmpeg: Arc<Mutex<Option<Child>>>,
    thread: Option<JoinHandle<()>>,
}

impl StreamProxy {
    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        kill_child(&self.ffmpeg);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
        let _ = fs::remove_dir_all(&self.workdir);
    }
}

pub fn start_proxy(
    app: &AppHandle,
    source_url: String,
    server_origin: String,
    start_position_seconds: f64,
) -> Result<String, String> {
    let source_url = validate_source_url(&source_url, &server_origin)?;
    if !start_position_seconds.is_finite() || start_position_seconds < 0.0 {
        return Err("Playback start position is invalid.".into());
    }
    let slot = proxy_slot(app)?;
    let mut current = slot
        .lock()
        .map_err(|_| "player state is unavailable".to_string())?;
    if let Some(mut proxy) = current.take() {
        proxy.stop();
    }
    let ffmpeg = ensure_ffmpeg(app)?;
    let workdir = std::env::temp_dir().join(format!(
        "tjxy-stream-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&workdir);
    fs::create_dir_all(&workdir).map_err(|error| error.to_string())?;
    let playlist = workdir.join("index.m3u8");
    let child = start_hls(
        &ffmpeg,
        &source_url,
        &workdir,
        &playlist,
        start_position_seconds,
    )?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let shutdown = Arc::new(AtomicBool::new(false));
    let child_slot = Arc::new(Mutex::new(Some(child)));
    let thread_shutdown = shutdown.clone();
    let files = workdir.clone();
    let request_token = token.clone();
    let active_connections = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let thread = thread::spawn(move || loop {
        if thread_shutdown.load(Ordering::SeqCst) {
            break;
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let active = active_connections.clone();
                if active.fetch_add(1, Ordering::SeqCst) >= MAX_PROXY_CONNECTIONS {
                    active.fetch_sub(1, Ordering::SeqCst);
                    let _ = stream.write_all(
                        b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
                    );
                    continue;
                }
                let root = files.clone();
                let token = request_token.clone();
                thread::spawn(move || {
                    let _guard = ConnectionGuard(active);
                    let _ = stream.set_read_timeout(Some(SOCKET_TIMEOUT));
                    let _ = stream.set_write_timeout(Some(SOCKET_TIMEOUT));
                    serve_request(&mut stream, &root, &token);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break,
        }
    });
    *current = Some(StreamProxy {
        _port: port,
        workdir,
        shutdown,
        ffmpeg: child_slot,
        thread: Some(thread),
    });
    Ok(format!("http://127.0.0.1:{port}/{token}/index.m3u8"))
}

pub fn stop_proxy(app: &AppHandle) -> Result<(), String> {
    if let Some(mut proxy) = proxy_slot(app)?
        .lock()
        .map_err(|_| "player state is unavailable".to_string())?
        .take()
    {
        proxy.stop();
    }
    Ok(())
}

struct ConnectionGuard(Arc<std::sync::atomic::AtomicUsize>);

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
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

pub fn proxy_slot(app: &AppHandle) -> Result<Arc<Mutex<Option<StreamProxy>>>, String> {
    app.try_state::<ProxyCell>()
        .map(|cell| cell.0.clone())
        .ok_or_else(|| "player state missing".to_string())
}

pub struct ProxyCell(pub Arc<Mutex<Option<StreamProxy>>>);

fn start_hls(
    ffmpeg: &Path,
    source_url: &str,
    workdir: &Path,
    playlist: &Path,
    start_position_seconds: f64,
) -> Result<Child, String> {
    let attempts: [&[&str]; 3] = [
        &["-c", "copy"],
        &["-c:v", "copy", "-c:a", "aac", "-ac", "2"],
        &[
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-ac", "2",
        ],
    ];
    let mut last_error = "FFmpeg could not prepare this source.".to_string();
    for extra in attempts {
        let _ = fs::remove_file(playlist);
        match spawn_hls(ffmpeg, source_url, workdir, extra, start_position_seconds) {
            Ok(mut child) => {
                if wait_for_playlist(playlist, &mut child).is_ok() {
                    return Ok(child);
                }
                let _ = child.kill();
                let _ = child.wait();
                last_error = "FFmpeg could not remux this source.".into();
            }
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn spawn_hls(
    ffmpeg: &Path,
    source_url: &str,
    workdir: &Path,
    extra: &[&str],
    start_position_seconds: f64,
) -> Result<Child, String> {
    let mut command = Command::new(ffmpeg);
    command.current_dir(workdir).args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-user_agent",
        USER_AGENT,
        "-protocol_whitelist",
        "http,https,tcp,tls,crypto",
    ]);
    if start_position_seconds > 0.0 {
        command.args(["-ss", &format!("{start_position_seconds:.3}")]);
    }
    command
        .args([
            "-re", "-i", source_url, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
        ])
        .args(extra.iter().copied())
        .args([
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_list_size",
            "150",
            "-hls_flags",
            "delete_segments+independent_segments",
            "-hls_segment_type",
            "fmp4",
            "-hls_fmp4_init_filename",
            "init.mp4",
            "index.m3u8",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|error| error.to_string())
}

fn wait_for_playlist(playlist: &Path, child: &mut Child) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if playlist_ready(playlist) {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(30) {
            return Err("Timed out while preparing the in-page stream.".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "FFmpeg exited before playback was ready ({status})."
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(80)),
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn playlist_ready(playlist: &Path) -> bool {
    fs::read_to_string(playlist)
        .map(|body| body.contains(".m4s") || body.contains(".mp4") || body.contains(".ts"))
        .unwrap_or(false)
}

fn serve_request(stream: &mut TcpStream, root: &Path, token: &str) {
    let mut header = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    while header.len() < 8192 && !header.windows(4).any(|window| window == b"\r\n\r\n") {
        let Ok(read) = stream.read(&mut chunk) else {
            return;
        };
        if read == 0 {
            return;
        }
        header.extend_from_slice(&chunk[..read]);
    }
    if header.len() >= 8192 || !header.windows(4).any(|window| window == b"\r\n\r\n") {
        let _ = stream.write_all(
            b"HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n",
        );
        return;
    }
    let text = String::from_utf8_lossy(&header);
    let Some(line) = text.lines().next() else {
        return;
    };
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method == "OPTIONS" {
        let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nConnection: close\r\n\r\n");
        return;
    }
    if method != "GET" && method != "HEAD" {
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
        return;
    }
    let path = target.split('?').next().unwrap_or("/");
    let prefix = format!("/{token}/");
    let Some(relative) = path.strip_prefix(&prefix) else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
    };
    if !allowed_proxy_file(relative) {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
    }
    let file_path = root.join(relative);
    let Ok(mut file) = File::open(&file_path) else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n");
        return;
    };
    let Ok(meta) = file.metadata() else { return };
    let size = meta.len();
    let range = match parse_range(&text, size) {
        Ok(value) => value,
        Err(()) => {
            let body = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(body.as_bytes());
            return;
        }
    };
    let mime = mime_for(&file_path);
    let (status, start, length) = match range {
        None => ("200 OK", 0, size),
        Some((from, to)) => ("206 Partial Content", from, to.saturating_sub(from) + 1),
    };
    if start > 0 {
        let _ = file.seek(SeekFrom::Start(start));
    }
    let mut headers = format!(
    "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n"
  );
    if status.starts_with("206") {
        let end = start + length - 1;
        headers.push_str(&format!("Content-Range: bytes {start}-{end}/{size}\r\n"));
    }
    headers.push_str("\r\n");
    let _ = stream.write_all(headers.as_bytes());
    if method == "HEAD" {
        return;
    }
    let mut limited = file.take(length);
    let _ = copy(&mut limited, stream);
}

fn allowed_proxy_file(relative: &str) -> bool {
    if relative.is_empty()
        || relative
            .chars()
            .any(|value| matches!(value, '/' | '\\' | ':' | '%'))
        || !relative
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-'))
    {
        return false;
    }
    relative == "index.m3u8"
        || relative == "init.mp4"
        || relative.ends_with(".m4s")
        || relative.ends_with(".ts")
}

fn parse_range(header: &str, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(line) = header
        .lines()
        .find(|row| row.to_ascii_lowercase().starts_with("range:"))
    else {
        return Ok(None);
    };
    if size == 0 {
        return Err(());
    }
    let value = line
        .split_once(':')
        .ok_or(())?
        .1
        .trim()
        .strip_prefix("bytes=")
        .ok_or(())?;
    if value.contains(',') {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok(Some((size.saturating_sub(suffix), size - 1)));
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(size - 1)
    };
    if start >= size || start > end {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "m3u8" => "application/vnd.apple.mpegurl",
        "m4s" | "mp4" => "video/mp4",
        "ts" => "video/mp2t",
        _ => "application/octet-stream",
    }
}

fn kill_child(slot: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn ensure_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("ffmpeg");
    if let Some(existing) = find_named(&root, "ffmpeg") {
        if binary_works(&existing) {
            return Ok(existing);
        }
    }
    if let Some(path) = which("ffmpeg") {
        return Ok(path);
    }
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let url = ffmpeg_download_url()?;
    let bytes = download(&url)?;
    extract_zip(&bytes, &root)?;
    find_named(&root, "ffmpeg")
        .ok_or_else(|| "Downloaded FFmpeg, but could not find the ffmpeg binary.".to_string())
}

fn ffmpeg_download_url() -> Result<String, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
    ("macos", "aarch64") => Ok("https://evermeet.cx/ffmpeg/getrelease/zip".into()),
    ("macos", "x86_64") => Ok("https://evermeet.cx/ffmpeg/getrelease/zip".into()),
    ("windows", "x86_64") => Ok("https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip".into()),
    ("windows", "aarch64") => Ok("https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-winarm64-gpl.zip".into()),
    ("linux", "x86_64") => Ok("https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz".into()),
    _ => Err("No FFmpeg build is configured for this platform.".into()),
  }
}

fn which(name: &str) -> Option<PathBuf> {
    let flag = if name == "ffmpeg" {
        "-version"
    } else {
        "--version"
    };
    Command::new(name)
        .arg(flag)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?
        .success()
        .then(|| PathBuf::from(name))
}

fn binary_works(path: &Path) -> bool {
    Command::new(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn find_named(root: &Path, stem: &str) -> Option<PathBuf> {
    if !root.exists() {
        return None;
    }
    let mut matches = Vec::new();
    visit_named(root, stem, &mut matches);
    matches.into_iter().next()
}

fn visit_named(dir: &Path, stem: &str, matches: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit_named(&path, stem, matches);
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if name == stem || name.eq_ignore_ascii_case(&format!("{stem}.exe")) {
            matches.push(path);
        }
    }
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.get(url).send().map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Could not download FFmpeg ({})", response.status()));
    }
    Ok(response
        .bytes()
        .map_err(|error| error.to_string())?
        .to_vec())
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    if bytes.len() >= 4 && bytes[0] == 0xFD && bytes[1] == 0x37 {
        return Err("This platform's FFmpeg archive is tar.xz; install ffmpeg on PATH or use macOS/Windows.".into());
    }
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(name) = file.enclosed_name() else {
            continue;
        };
        let out = dest.join(name);
        if file.is_dir() {
            fs::create_dir_all(&out).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut target = File::create(&out).map_err(|error| error.to_string())?;
        copy(&mut file, &mut target).map_err(|error| error.to_string())?;
        make_executable(&out);
    }
    Ok(())
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_url_must_match_connected_origin() {
        assert!(validate_source_url(
            "https://media.example:8443/Videos/1?ticket=secret",
            "https://media.example:8443",
        )
        .is_ok());
        assert!(
            validate_source_url("https://other.example/Videos/1", "https://media.example").is_err()
        );
        assert!(validate_source_url("file:///tmp/movie.mkv", "https://media.example").is_err());
        assert!(validate_source_url(
            "https://user:pass@media.example/Videos/1",
            "https://media.example"
        )
        .is_err());
        assert!(validate_source_url(
            "https://media.example/Videos/1#fragment",
            "https://media.example"
        )
        .is_err());
    }

    #[test]
    fn proxy_only_serves_expected_generated_files() {
        assert!(allowed_proxy_file("index.m3u8"));
        assert!(allowed_proxy_file("index42.m4s"));
        assert!(!allowed_proxy_file("../secret"));
        assert!(!allowed_proxy_file("%2e%2e%2fsecret"));
        assert!(!allowed_proxy_file("nested/index.m3u8"));
    }

    #[test]
    fn byte_ranges_distinguish_missing_valid_and_invalid_values() {
        assert_eq!(parse_range("GET / HTTP/1.1\r\n", 100), Ok(None));
        assert_eq!(
            parse_range("Range: bytes=10-19\r\n", 100),
            Ok(Some((10, 19)))
        );
        assert_eq!(parse_range("range: bytes=-10\r\n", 100), Ok(Some((90, 99))));
        assert_eq!(parse_range("Range: bytes=90-\r\n", 100), Ok(Some((90, 99))));
        assert_eq!(parse_range("Range: bytes=100-\r\n", 100), Err(()));
        assert_eq!(parse_range("Range: bytes=1-2,4-5\r\n", 100), Err(()));
        assert_eq!(parse_range("Range: bytes=-1\r\n", 0), Err(()));
    }
}
