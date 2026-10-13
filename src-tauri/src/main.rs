#![cfg(target_os = "macos")]
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::{CStr, CString},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, OnceLock,
    },
};
use tauri::{Emitter, Manager};
static EXIT_APPROVED: AtomicBool = AtomicBool::new(false);
static RESOURCES: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
extern "C" {
    fn hg_command(
        window: *mut std::ffi::c_void,
        label: *const libc::c_char,
        resources: *const libc::c_char,
        request: *const libc::c_char,
        emit: extern "C" fn(*const libc::c_char, *const libc::c_char),
    ) -> *mut libc::c_char;
    fn hg_shutdown();
}
extern "C" fn native_event(label: *const libc::c_char, event: *const libc::c_char) {
    // Never unwind through the C ABI.
    let _ = std::panic::catch_unwind(|| unsafe {
        if label.is_null() || event.is_null() {
            return;
        }
        if let Some(app) = APP.get() {
            let label = CStr::from_ptr(label).to_string_lossy();
            if let (Some(window), Ok(value)) = (
                app.get_webview_window(&label),
                serde_json::from_slice::<Value>(CStr::from_ptr(event).to_bytes()),
            ) {
                let _ = window.emit("native-event", value);
            }
        }
    });
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("找不到家目錄".into())
}
fn expand_path(path: &str, base: Option<&str>) -> Result<PathBuf, String> {
    let p = if path == "~" {
        user_home()?
    } else if let Some(rest) = path.strip_prefix("~/") {
        user_home()?.join(rest)
    } else if path.starts_with('~') {
        return Err("請使用 ~ 或 ~/子目錄；不支援 ~其他使用者".into());
    } else {
        PathBuf::from(path)
    };
    if p.is_absolute() {
        Ok(p)
    } else {
        let base = base.map(PathBuf::from).unwrap_or(user_home()?);
        Ok(base.join(p))
    }
}
#[tauri::command]
fn home() -> Result<String, String> {
    Ok(user_home()?.to_string_lossy().into_owned())
}
#[tauri::command]
fn resolve_path(path: String, base: Option<String>) -> Result<String, String> {
    let p = std::fs::canonicalize(expand_path(&path, base.as_deref())?).map_err(err)?;
    if !p.is_dir() {
        return Err("請選擇目錄".into());
    }
    Ok(p.to_string_lossy().into_owned())
}
#[derive(Serialize)]
struct Directory {
    path: String,
    name: String,
    has_children: bool,
}
#[tauri::command]
async fn directories(path: String) -> Result<Vec<Directory>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = expand_path(&path, None)?;
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(path).map_err(err)? {
            let entry = entry.map_err(err)?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let has_children = std::fs::read_dir(&path)
                .map(|items| items.flatten().any(|e| e.path().is_dir()))
                .unwrap_or(false);
            entries.push(Directory {
                path: path.to_string_lossy().into_owned(),
                name: entry.file_name().to_string_lossy().into_owned(),
                has_children,
            });
        }
        entries.sort_by_key(|x| x.name.to_lowercase());
        Ok(entries)
    })
    .await
    .map_err(err)?
}
fn resources(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = RESOURCES.get() {
        return Ok(path.clone());
    }
    let bundle = app
        .path()
        .resource_dir()
        .unwrap_or_default()
        .join("ghostty");
    if bundle.is_dir() {
        let _ = RESOURCES.set(bundle.clone());
        return Ok(bundle);
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/share/ghostty");
    if dev.is_dir() {
        let _ = RESOURCES.set(dev.clone());
        return Ok(dev);
    }
    Err("缺少 Ghostty resources，請先執行 npm run native:bootstrap".into())
}
async fn call_native(window: tauri::WebviewWindow, request: Value) -> Result<Value, String> {
    let resource = resources(window.app_handle())?;
    let (tx, rx) = mpsc::channel();
    let dispatch = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let label = CString::new(dispatch.label()).map_err(err)?;
                let resource = CString::new(resource.to_string_lossy().as_bytes()).map_err(err)?;
                let req = CString::new(request.to_string()).map_err(err)?;
                let raw = unsafe {
                    hg_command(
                        dispatch.ns_window().map_err(err)?,
                        label.as_ptr(),
                        resource.as_ptr(),
                        req.as_ptr(),
                        native_event,
                    )
                };
                if raw.is_null() {
                    return Err("原生橋接未傳回結果".into());
                }
                let result = unsafe {
                    serde_json::from_slice::<Value>(CStr::from_ptr(raw).to_bytes()).map_err(err)
                };
                unsafe {
                    libc::free(raw.cast());
                }
                let value = result?;
                if let Some(error) = value.get("error").and_then(Value::as_str) {
                    return Err(error.to_owned());
                }
                Ok(value)
            })();
            let _ = tx.send(result);
        })
        .map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(err)?)
        .await
        .map_err(err)?
}
#[tauri::command]
async fn native(window: tauri::WebviewWindow, mut request: Value) -> Result<Value, String> {
    if request.get("op").and_then(Value::as_str) == Some("open") {
        let path = request
            .get("path")
            .and_then(Value::as_str)
            .ok_or("缺少目錄")?;
        request["path"] = Value::String(resolve_path(path.into(), None)?);
        request["id"] = Value::String(uuid::Uuid::new_v4().to_string());
    }
    call_native(window, request).await
}
#[tauri::command]
async fn pick_directory(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<Option<String>, String> {
    let resolved = expand_path(&path, None)?;
    let (tx, rx) = mpsc::channel();
    let dispatch = window.clone();
    // NSOpenPanel stays on the AppKit thread, and is a sheet attached to this window.
    window
        .run_on_main_thread(move || unsafe {
            let req = json!({"op":"pick-directory","path":resolved});
            let result = (|| {
                let label = CString::new(dispatch.label()).map_err(err)?;
                let res = CString::new(
                    resources(dispatch.app_handle())?
                        .to_string_lossy()
                        .as_bytes(),
                )
                .map_err(err)?;
                let request = CString::new(req.to_string()).map_err(err)?;
                let raw = hg_command(
                    dispatch.ns_window().map_err(err)?,
                    label.as_ptr(),
                    res.as_ptr(),
                    request.as_ptr(),
                    native_event,
                );
                if raw.is_null() {
                    return Err("資料夾挑選器未傳回結果".into());
                }
                let value =
                    serde_json::from_slice::<Value>(CStr::from_ptr(raw).to_bytes()).map_err(err);
                libc::free(raw.cast());
                let value = value?;
                Ok(value.get("path").and_then(Value::as_str).map(str::to_owned))
            })();
            let _ = tx.send(result);
        })
        .map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(err)?)
        .await
        .map_err(err)?
}
#[derive(Serialize, Deserialize, Clone)]
struct Favorite {
    id: String,
    alias: String,
    path: String,
}
fn favorites_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = std::env::var_os("HIGHOSTTY_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_config_dir().map_err(err)?);
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("favorites.json"))
}
#[tauri::command]
fn favorites(app: tauri::AppHandle) -> Result<Vec<Favorite>, String> {
    let path = favorites_file(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(err)?).map_err(err)
}
#[tauri::command]
fn save_favorites(items: Vec<Favorite>, app: tauri::AppHandle) -> Result<(), String> {
    for item in &items {
        if item.alias.trim().is_empty() {
            return Err("收藏別名不可空白".into());
        }
    }
    let path = favorites_file(&app)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let content = serde_json::to_vec_pretty(&items).map_err(err)?;
    use std::io::Write;
    let mut file = std::fs::File::create(&temp).map_err(err)?;
    file.write_all(&content).map_err(err)?;
    file.sync_all().map_err(err)?;
    std::fs::rename(temp, path).map_err(err)?;
    app.emit("favorites-changed", &items).map_err(err)
}
#[tauri::command]
fn new_window(app: tauri::AppHandle, path: String, quick: bool) -> Result<String, String> {
    if quick {
        if let Some(window) = app
            .webview_windows()
            .values()
            .find(|w| w.label().starts_with("quick-"))
        {
            let label = window.label().to_string();
            let win = window.clone();
            tauri::async_runtime::spawn(async move {
                let _ = call_native(win, json!({"op":"quick"})).await;
            });
            return Ok(label);
        }
    }
    let path = resolve_path(path, None)?;
    let label = format!(
        "{}-{}",
        if quick { "quick" } else { "window" },
        uuid::Uuid::new_v4()
    );
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("HiGhostty")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .initialization_script(format!(
            "window.__HIGHOSTTY_INITIAL_PATH__={};",
            serde_json::to_string(&path).map_err(err)?
        ))
        .transparent(true)
        .build()
        .map_err(err)?;
    Ok(label)
}
#[tauri::command]
fn list_windows(app: tauri::AppHandle) -> Vec<String> {
    let mut labels: Vec<_> = app.webview_windows().keys().cloned().collect();
    labels.sort();
    labels
}
#[tauri::command]
fn focus_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let window = app.get_webview_window(&label).ok_or("找不到視窗")?;
    window.show().map_err(err)?;
    window.set_focus().map_err(err)
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    EXIT_APPROVED.store(true, Ordering::SeqCst);
    app.exit(0);
}
fn main() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let dir = std::env::temp_dir().join("highostty-diagnostics");
        if std::fs::create_dir_all(&dir).is_ok() {
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("last-crash.txt"))
            {
                let _ = writeln!(file, "{info}");
            }
        }
        previous(info);
    }));
    tauri::Builder::default()
        .setup(|app| {
            let _ = APP.set(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            home,
            resolve_path,
            directories,
            native,
            pick_directory,
            favorites,
            save_favorites,
            new_window,
            list_windows,
            focus_window,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("啟動失敗")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if !EXIT_APPROVED.load(Ordering::SeqCst) {
                    let windows = app.webview_windows();
                    if !windows.is_empty() {
                        api.prevent_exit();
                        let window = windows
                            .values()
                            .find(|w| w.is_focused().unwrap_or(false))
                            .or_else(|| windows.get("main"))
                            .or_else(|| windows.values().next());
                        if let Some(window) = window {
                            let _ = window.emit("native-event", json!({"type":"quit"}));
                        }
                    }
                }
            }
            if let tauri::RunEvent::Exit = event {
                unsafe {
                    hg_shutdown();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_expand_only_the_home_prefix() {
        assert_eq!(expand_path("~", None).unwrap(), user_home().unwrap());
        assert_eq!(
            expand_path("~/中文 目錄", None).unwrap(),
            user_home().unwrap().join("中文 目錄")
        );
        assert_eq!(
            expand_path("child", Some("/private/tmp")).unwrap(),
            PathBuf::from("/private/tmp/child")
        );
        assert!(expand_path("~another", None).is_err());
        assert_eq!(
            expand_path("/tmp/a~b", None).unwrap(),
            PathBuf::from("/tmp/a~b")
        );
    }
}
