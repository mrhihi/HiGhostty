#![cfg(target_os = "macos")]
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::{CStr, CString},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering}, Mutex,
        mpsc, OnceLock,
    },
};
use tauri::{Emitter, Manager};
mod attention;
mod files;
mod hooks;
mod snippets;
static EXIT_APPROVED: AtomicBool = AtomicBool::new(false);
static FAVORITES_LOCK: Mutex<()> = Mutex::new(());
static PENDING_OPEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
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
#[tauri::command]
fn hook_status() -> Result<Vec<hooks::Status>, String> {
    Ok(hooks::status(&user_home()?))
}
#[tauri::command]
fn hook_install(app: tauri::AppHandle, agent: String) -> Result<(), String> {
    let script = attention::script_path(&data_dir(&app)?);
    if !script.exists() {
        return Err("hg-notify 尚未就緒，請重新啟動 HiGhostty".into());
    }
    hooks::install(&user_home()?, &agent, &script)
}
#[tauri::command]
fn hook_remove(agent: String) -> Result<(), String> {
    hooks::remove(&user_home()?, &agent)
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = std::env::var_os("HIGHOSTTY_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_config_dir().map_err(err)?);
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
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
fn load_workspace_favorites(app: &tauri::AppHandle) -> Result<WorkspaceFavorites, String> {
    let dir = data_dir(&app)?;
    let path = dir.join("workspace-favorites-v2.json");
    if path.exists() {
        let value: Value = serde_json::from_slice(&std::fs::read(&path).map_err(err)?).map_err(err)?;
        if value.is_array() {
            let items: Vec<Value> = serde_json::from_value(value).map_err(err)?;
            return Ok(WorkspaceFavorites { revision: 0, items });
        }
        return serde_json::from_value(value).map_err(err);
    }
    let old_groups_path = dir.with_file_name("group-favorites.json");
    let items: Vec<Value> = if old_groups_path.exists() {
        serde_json::from_slice(&std::fs::read(&old_groups_path).map_err(err)?).map_err(err)?
    } else { Vec::new() };
    let legacy_path = favorites_file(&app)?;
    let legacy: Vec<Favorite> = if legacy_path.exists() {
        serde_json::from_slice(&std::fs::read(legacy_path).map_err(err)?).map_err(err)?
    } else { Vec::new() };
    let items = migrate_workspace_favorites(items, legacy);
    let document = WorkspaceFavorites { revision: 0, items };
    write_workspace_favorites(&path, &document)?;
    Ok(document)
}
fn migrate_workspace_favorites(mut groups: Vec<Value>, directories: Vec<Favorite>) -> Vec<Value> {
    for item in &mut groups {
        if item.get("kind").is_none() {
            let name = item.pointer("/group/name").cloned().unwrap_or(Value::String("群組".into()));
            item["kind"] = Value::String("group".into());
            item["name"] = name;
        }
    }
    for item in directories {
        if !groups.iter().any(|existing| existing.get("id").and_then(Value::as_str) == Some(item.id.as_str())) {
            groups.push(serde_json::json!({
                "id": item.id, "kind": "tab", "name": item.alias,
                "tab": { "paths": [item.path], "tree": { "kind": "leaf", "id": "0" }, "focused": 0 }
            }));
        }
    }
    groups
}
#[tauri::command]
fn group_favorites(app: tauri::AppHandle) -> Result<WorkspaceFavorites, String> {
    let _guard = FAVORITES_LOCK.lock().map_err(err)?;
    load_workspace_favorites(&app)
}
#[derive(Serialize, Deserialize, Clone)]
struct WorkspaceFavorites { revision: u64, items: Vec<Value> }
fn write_workspace_favorites(path: &Path, document: &WorkspaceFavorites) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec_pretty(document).map_err(err)?).map_err(err)?;
    std::fs::rename(temp, path).map_err(err)
}
fn next_favorites_revision(current: u64, expected: u64) -> Result<u64, String> {
    if current != expected {
        return Err("收藏已在其他視窗更新。列表已重新載入，請再套用你的修改。".into());
    }
    current.checked_add(1).ok_or_else(|| "收藏修訂號已達上限".into())
}
#[tauri::command]
fn save_group_favorites(items: Vec<Value>, expected_revision: u64, app: tauri::AppHandle) -> Result<WorkspaceFavorites, String> {
    let _guard = FAVORITES_LOCK.lock().map_err(err)?;
    let current = load_workspace_favorites(&app)?;
    let revision = next_favorites_revision(current.revision, expected_revision)?;
    let document = WorkspaceFavorites { revision, items };
    let path = data_dir(&app)?.join("workspace-favorites-v2.json");
    write_workspace_favorites(&path, &document)?;
    app.emit("group-favorites-changed", &document).map_err(err)?;
    Ok(document)
}
/// 工作階段（tmux 頁籤）快照；內容由前端決定，這裡只負責原子寫入。
#[tauri::command]
fn load_session(app: tauri::AppHandle) -> Result<Value, String> {
    let path = data_dir(&app)?.join("session.json");
    Ok(read_session(&path))
}
fn read_session(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "tabs": [] }))
}
#[tauri::command]
fn save_session(session: Value, app: tauri::AppHandle) -> Result<(), String> {
    let path = data_dir(&app)?.join("session.json");
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec_pretty(&session).map_err(err)?).map_err(err)?;
    std::fs::rename(temp, path).map_err(err)
}
fn valid_tmux_session(name: &str) -> bool {
    name.len() == 11 && name.starts_with("hg-") && name[3..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}
fn find_tmux() -> Option<PathBuf> {
    ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}
/// 手動關閉頁籤時結束對應 session；找不到 tmux 或 session 時靜默略過。
#[tauri::command]
fn tmux_kill_session(name: String) -> Result<(), String> {
    if !valid_tmux_session(&name) {
        return Err("無效的 tmux session 名稱".into());
    }
    if let Some(tmux) = find_tmux() {
        let _ = std::process::Command::new(tmux)
            .args(["kill-session", "-t", &format!("={name}")])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    Ok(())
}
/// 即時切換 session 的狀態列，不必重開頁籤。
#[tauri::command]
fn tmux_set_status(name: String, visible: bool) -> Result<(), String> {
    if !valid_tmux_session(&name) {
        return Err("無效的 tmux session 名稱".into());
    }
    if let Some(tmux) = find_tmux() {
        let _ = std::process::Command::new(tmux)
            .args(["set-option", "-t", &format!("={name}"), "status", if visible { "on" } else { "off" }])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    Ok(())
}
#[tauri::command]
fn tmux_available() -> bool {
    find_tmux().is_some() || std::process::Command::new("sh").args(["-lc", "command -v tmux"]).output().map(|o| o.status.success()).unwrap_or(false)
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
            serde_json::to_string(&path).map_err(err)?,
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
/// Directories to open for URLs delivered by Finder/Dock; files map to their parent.
fn open_directories(urls: &[tauri::Url]) -> Vec<String> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter_map(|path| if path.is_dir() { Some(path) } else { path.parent().map(Path::to_path_buf) })
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}
#[tauri::command]
fn take_pending_open_paths() -> Vec<String> {
    std::mem::take(&mut *PENDING_OPEN.lock().unwrap_or_else(|e| e.into_inner()))
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
            if let Ok(dir) = data_dir(app.handle()) {
                attention::start(app.handle().clone(), dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            home,
            hook_status,
            hook_install,
            hook_remove,
            resolve_path,
            files::list_files,
            files::dir_stamp,
            files::file_op,
            snippets::snippets,
            snippets::save_snippets,
            native,
            take_pending_open_paths,
            pick_directory,
            favorites,
            save_favorites,
            group_favorites,
            save_group_favorites,
            load_session,
            save_session,
            tmux_kill_session,
            tmux_set_status,
            tmux_available,
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
            if let tauri::RunEvent::Opened { urls } = &event {
                let paths = open_directories(urls);
                if !paths.is_empty() {
                    PENDING_OPEN.lock().unwrap_or_else(|e| e.into_inner()).extend(paths);
                    let windows = app.webview_windows();
                    let window = windows
                        .values()
                        .find(|w| w.is_focused().unwrap_or(false))
                        .or_else(|| windows.get("main"))
                        .or_else(|| windows.values().next());
                    if let Some(window) = window {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("open-paths", ());
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
    fn favorite_writes_reject_stale_revisions() {
        assert_eq!(next_favorites_revision(4, 4).unwrap(), 5);
        assert!(next_favorites_revision(5, 4).unwrap_err().contains("其他視窗更新"));
    }
    #[test]
    fn old_favorites_migrate_once_into_tab_and_group_variants() {
        let old_group = serde_json::json!({ "id": "group-id", "group": { "id": "g", "name": "開發" }, "tabs": [], "activeIndex": 0 });
        let old_directory = Favorite { id: "directory-id".into(), alias: "專案".into(), path: "/tmp/project".into() };
        let migrated = migrate_workspace_favorites(vec![old_group], vec![old_directory.clone(), old_directory]);
        assert_eq!(migrated.len(), 2);
        assert_eq!(migrated[0]["kind"], "group");
        assert_eq!(migrated[0]["name"], "開發");
        assert_eq!(migrated[1]["kind"], "tab");
        assert_eq!(migrated[1]["tab"]["paths"][0], "/tmp/project");
    }
    #[test]
    fn session_reads_fall_back_on_missing_or_corrupt_files() {
        let dir = std::env::temp_dir().join(format!("hg-session-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");
        assert_eq!(read_session(&path), json!({ "tabs": [] }));
        std::fs::write(&path, "{broken").unwrap();
        assert_eq!(read_session(&path), json!({ "tabs": [] }));
        std::fs::write(&path, r#"{"tabs":[{"tmux":true}]}"#).unwrap();
        assert_eq!(read_session(&path)["tabs"][0]["tmux"], true);
        std::fs::remove_dir_all(dir).ok();
    }
    #[test]
    fn tmux_session_names_are_validated() {
        assert!(valid_tmux_session("hg-abcd1234"));
        assert!(!valid_tmux_session("hg-abcd123;"));
        assert!(!valid_tmux_session("other"));
    }
    #[test]
    fn opened_urls_map_to_directories() {
        let dir = std::env::temp_dir();
        let urls = [
            tauri::Url::from_directory_path(&dir).unwrap(),
            tauri::Url::parse("https://example.com/x").unwrap(),
        ];
        assert_eq!(open_directories(&urls), vec![dir.to_string_lossy().into_owned()]);
        let file = tauri::Url::from_file_path("/etc/hosts").unwrap();
        assert_eq!(open_directories(&[file]), vec!["/etc".to_string()]);
    }
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
