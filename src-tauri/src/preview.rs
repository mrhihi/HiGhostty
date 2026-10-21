// Preview pane commands. The front end polls `preview_stat` and only calls
// `preview_read` when the stamp changed; stat on the path (not a file watch)
// keeps working when an editor or agent saves via write-temp-then-rename.
use crate::{err, expand_path};
use serde::Serialize;
use std::{io::Read, time::UNIX_EPOCH};

const MAX_TEXT: u64 = 2 * 1024 * 1024;
const MAX_IMAGE: u64 = 15 * 1024 * 1024;
const MAX_BINARY: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    mtime_ms: u64,
    size: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    mtime_ms: u64,
    size: u64,
    text: Option<String>,
    data_url: Option<String>,
    truncated: bool,
    // Set when the file cannot be shown (binary, too large, wrong type).
    unsupported: Option<String>,
}

fn stamp_of(metadata: &std::fs::Metadata) -> Stamp {
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Stamp {
        mtime_ms,
        size: metadata.len(),
    }
}

#[tauri::command]
pub async fn preview_stat(path: String) -> Result<Stamp, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = expand_path(&path, None)?;
        let metadata = std::fs::metadata(&resolved).map_err(|_| "找不到檔案".to_string())?;
        if !metadata.is_file() {
            return Err("不是檔案".into());
        }
        Ok(stamp_of(&metadata))
    })
    .await
    .map_err(err)?
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn image_mime(path: &str) -> Option<&'static str> {
    match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

// Text is cut at `limit` bytes on a character boundary. Returns None for
// binary content (a NUL byte or invalid UTF-8 before the cut).
fn decode_text(mut bytes: Vec<u8>, total: u64, limit: u64) -> Option<(String, bool)> {
    let truncated = total > limit;
    if truncated {
        bytes.truncate(limit as usize);
    }
    if bytes.contains(&0) {
        return None;
    }
    match String::from_utf8(bytes) {
        Ok(text) => Some((text, truncated)),
        Err(e) if truncated && e.utf8_error().error_len().is_none() => {
            // Only the last character was cut in half.
            let valid = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).ok().map(|text| (text, true))
        }
        Err(_) => None,
    }
}

fn read(path: &str, kind: &str) -> Result<Content, String> {
    let resolved = expand_path(path, None)?;
    let metadata = std::fs::metadata(&resolved).map_err(|_| "找不到檔案".to_string())?;
    if !metadata.is_file() {
        return Err("不是檔案".into());
    }
    let stamp = stamp_of(&metadata);
    let mut content = Content {
        mtime_ms: stamp.mtime_ms,
        size: stamp.size,
        text: None,
        data_url: None,
        truncated: false,
        unsupported: None,
    };
    if kind == "image" {
        let Some(mime) = image_mime(path) else {
            content.unsupported = Some("不支援的圖片格式".into());
            return Ok(content);
        };
        if stamp.size > MAX_IMAGE {
            content.unsupported = Some("圖片超過 15 MB".into());
            return Ok(content);
        }
        let bytes = std::fs::read(&resolved).map_err(err)?;
        content.data_url = Some(format!("data:{mime};base64,{}", base64(&bytes)));
        return Ok(content);
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&resolved)
        .map_err(err)?
        .take(MAX_TEXT + 4)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    match decode_text(bytes, stamp.size, MAX_TEXT) {
        Some((text, truncated)) => {
            content.text = Some(text);
            content.truncated = truncated;
        }
        None => content.unsupported = Some("二進位檔案，無法預覽".into()),
    }
    Ok(content)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn page_mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "xhtml" => "application/xhtml+xml",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// `hgpage://localhost/<absolute path>`: serves an .html file and the files it links to (css, js,
// images) so the page shows up as written. Only loaded inside a sandboxed iframe without
// allow-same-origin, so the page's scripts get an opaque origin: no access to the app or its IPC.
// No CORS header is sent, so those scripts cannot read these files back with fetch.
pub fn serve_page(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let reply = |status: u16, mime: &str, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .header("Cache-Control", "no-store")
            .body(body)
            .unwrap_or_default()
    };
    let Some(path) = percent_decode(request.uri().path()) else {
        return reply(400, "text/plain", Vec::new());
    };
    if !path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return reply(400, "text/plain", Vec::new());
    }
    match std::fs::read(&path) {
        Ok(bytes) => reply(200, page_mime(&path), bytes),
        Err(_) => reply(404, "text/plain", Vec::new()),
    }
}

#[tauri::command]
pub async fn preview_read(path: String, kind: String) -> Result<Content, String> {
    tauri::async_runtime::spawn_blocking(move || read(&path, &kind))
        .await
        .map_err(err)?
}

// Raw bytes for the library-rendered kinds (pdf, office files). Sent as a binary IPC
// response so large files do not go through JSON or base64.
fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    let resolved = expand_path(path, None)?;
    let metadata = std::fs::metadata(&resolved).map_err(|_| "找不到檔案".to_string())?;
    if !metadata.is_file() {
        return Err("不是檔案".into());
    }
    if metadata.len() > MAX_BINARY {
        return Err("檔案超過 50 MB".into());
    }
    std::fs::read(&resolved).map_err(err)
}

#[tauri::command]
pub async fn preview_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_bytes(&path).map(tauri::ipc::Response::new))
        .await
        .map_err(err)?
}

// Links in rendered markdown. Only web URLs ever reach `open`.
#[tauri::command]
pub fn preview_open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || url.starts_with('-') {
        return Err("只能開啟 http／https 連結".into());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(err)?;
    Ok(())
}

// Windows that only show a file. They have no terminals and never answer
// `control-request`, so window enumeration elsewhere must skip them.
pub const WINDOW_PREFIX: &str = "preview-";
pub fn is_preview_window(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX)
}
// One window per file: asking again for the same path brings it to the front.
fn window_label(path: &std::path::Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{WINDOW_PREFIX}{:016x}", hasher.finish())
}

/// Where a popped-out preview came from, so "放回頁籤" can return it there.
#[derive(Serialize, serde::Deserialize, Clone)]
pub struct DockTarget {
    pub window: String,
    pub tab: Option<String>,
}

/// The terminal window that should take the file back: its origin if that window still
/// exists, else "main", else any terminal window.
fn dock_window(app: &tauri::AppHandle, origin: Option<&DockTarget>) -> Option<tauri::WebviewWindow> {
    use tauri::Manager;
    let windows = app.webview_windows();
    origin
        .and_then(|o| windows.get(&o.window))
        .filter(|w| !is_preview_window(w.label()))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.iter().find(|(label, _)| !is_preview_window(label)).map(|(_, w)| w))
        .cloned()
}

/// Sends the file back to a tab (the front end of the target window shows it) and closes
/// the preview window that called.
#[tauri::command]
pub fn preview_dock(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    origin: Option<DockTarget>,
) -> Result<(), String> {
    use tauri::Emitter;
    let target = dock_window(&app, origin.as_ref()).ok_or("沒有可放回的終端機視窗")?;
    let tab = origin.as_ref().and_then(|o| o.tab.clone());
    app.emit_to(
        target.label(),
        "preview-dock",
        serde_json::json!({ "path": path, "tab": tab }),
    )
    .map_err(err)?;
    let _ = target.unminimize();
    let _ = target.show();
    let _ = target.set_focus();
    window.destroy().map_err(err)
}

#[tauri::command]
pub fn open_preview_window(
    app: tauri::AppHandle,
    path: String,
    focus: bool,
    origin: Option<DockTarget>,
) -> Result<String, String> {
    use tauri::Manager;
    let resolved = expand_path(&path, None)?;
    if !std::fs::metadata(&resolved).map_err(|_| "找不到檔案".to_string())?.is_file() {
        return Err("不是檔案".into());
    }
    let resolved = resolved.to_string_lossy().into_owned();
    let label = window_label(std::path::Path::new(&resolved));
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        if focus {
            let _ = window.set_focus();
        }
        return Ok(label);
    }
    let title = resolved.rsplit('/').next().unwrap_or("預覽").to_string();
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("preview.html".into()))
        .title(title)
        .inner_size(900.0, 720.0)
        .min_inner_size(360.0, 240.0)
        .focused(focus)
        .initialization_script(format!(
            "window.__HIGHOSTTY_PREVIEW__={};",
            serde_json::json!({ "path": resolved, "origin": origin })
        ))
        .build()
        .map_err(err)?;
    Ok(label)
}

fn files_label(tab: &str) -> Result<String, String> {
    if tab.is_empty() || !tab.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("頁籤代號格式不正確".into());
    }
    Ok(format!("{WINDOW_PREFIX}files-{tab}"))
}

/// The files panel popped out of a tab into its own window. One window per tab: asking
/// again brings it to the front. `init` is handed to the page as `__HIGHOSTTY_FILES__`.
#[tauri::command]
pub fn open_files_window(
    app: tauri::AppHandle,
    tab: String,
    title: String,
    focus: bool,
    size: Option<(f64, f64)>,
    init: serde_json::Value,
) -> Result<String, String> {
    use tauri::Manager;
    let label = files_label(&tab)?;
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        if focus {
            let _ = window.set_focus();
        }
        return Ok(label);
    }
    let (width, height) = size
        .map(|(w, h)| (w.clamp(420.0, 4000.0), h.clamp(320.0, 4000.0)))
        .unwrap_or((760.0, 640.0));
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("files.html".into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(420.0, 320.0)
        .focused(focus)
        .initialization_script(format!("window.__HIGHOSTTY_FILES__={};", init))
        .build()
        .map_err(err)?;
    Ok(label)
}

/// Closes a tab's popped-out files window, if it is open.
#[tauri::command]
pub fn close_files_window(app: tauri::AppHandle, tab: String) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window(&files_label(&tab)?) {
        window.destroy().map_err(err)?;
    }
    Ok(())
}

/// Opens the macOS print sheet for the calling window; its PDF menu saves as PDF. The front
/// end has already swapped in a print-only copy of the rendered document.
#[tauri::command]
pub fn preview_print(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(err)
}

#[tauri::command]
pub fn preview_reveal(path: String) -> Result<(), String> {
    let resolved = expand_path(&path, None)?;
    std::process::Command::new("open")
        .arg("-R")
        .arg(resolved)
        .spawn()
        .map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_reference_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn text_is_cut_on_a_character_boundary() {
        let bytes = "中文字".as_bytes().to_vec(); // 9 bytes
        let (text, truncated) = decode_text(bytes.clone(), 9, 9).unwrap();
        assert_eq!((text.as_str(), truncated), ("中文字", false));
        // 7 bytes cuts the third character in half.
        let (text, truncated) = decode_text(bytes, 9, 7).unwrap();
        assert_eq!((text.as_str(), truncated), ("中文", true));
    }

    #[test]
    fn binary_is_rejected() {
        assert!(decode_text(vec![b'a', 0, b'b'], 3, 10).is_none());
        assert!(decode_text(vec![0xff, 0xfe, b'a'], 3, 10).is_none());
    }

    #[test]
    fn read_reports_kinds_and_missing_files() {
        let dir = std::env::temp_dir().join(format!("hg-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let note = dir.join("a.md");
        std::fs::write(&note, "# hi").unwrap();
        let got = read(note.to_str().unwrap(), "markdown").unwrap();
        assert_eq!(got.text.as_deref(), Some("# hi"));
        let bin = dir.join("b.bin");
        std::fs::write(&bin, [0u8, 1, 2]).unwrap();
        assert!(read(bin.to_str().unwrap(), "text").unwrap().unsupported.is_some());
        let png = dir.join("c.png");
        std::fs::write(&png, [1u8, 2, 3]).unwrap();
        let got = read(png.to_str().unwrap(), "image").unwrap();
        assert_eq!(got.data_url.as_deref(), Some("data:image/png;base64,AQID"));
        assert!(read(dir.join("none.md").to_str().unwrap(), "text").is_err());
        assert!(read(dir.to_str().unwrap(), "text").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_bytes_returns_raw_content_and_rejects_missing() {
        let dir = std::env::temp_dir().join(format!("hg-preview-bytes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.pdf");
        std::fs::write(&file, [0u8, 1, 2, 255]).unwrap();
        assert_eq!(read_bytes(file.to_str().unwrap()).unwrap(), vec![0u8, 1, 2, 255]);
        assert!(read_bytes(dir.join("none.pdf").to_str().unwrap()).is_err());
        assert!(read_bytes(dir.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn window_labels_are_stable_per_path_and_recognised() {
        let a = window_label(std::path::Path::new("/tmp/a.md"));
        assert_eq!(a, window_label(std::path::Path::new("/tmp/a.md")));
        assert_ne!(a, window_label(std::path::Path::new("/tmp/b.md")));
        assert!(is_preview_window(&a));
        assert!(!is_preview_window("main") && !is_preview_window("window-1") && !is_preview_window("quick-1"));
    }

    #[test]
    fn files_window_labels_are_checked_and_treated_as_satellites() {
        let label = files_label("1a2b-3c").unwrap();
        assert!(is_preview_window(&label));
        assert!(files_label("").is_err());
        assert!(files_label("../x").is_err());
    }

    #[test]
    fn only_web_urls_are_opened() {
        assert!(preview_open_url("file:///etc/passwd".into()).is_err());
        assert!(preview_open_url("-a Calculator".into()).is_err());
    }
}
