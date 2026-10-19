// Quick-launch presets and "open folder with" apps (launch-tools.json). The front end owns
// validation and defaults; Rust stores the document and runs `open -a`.
use crate::{data_dir, err};
use serde_json::Value;
use std::{path::Path, process::Command, sync::Mutex};

static TOOLS_LOCK: Mutex<()> = Mutex::new(());

fn write(path: &Path, document: &Value) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec_pretty(document).map_err(err)?).map_err(err)?;
    std::fs::rename(temp, path).map_err(err)
}
fn valid_app(app: &str) -> bool {
    let app = app.trim();
    !app.is_empty() && !app.starts_with('-') && !app.chars().any(|c| c.is_control())
}

// None when never configured (the front end then uses its defaults); a corrupt file reads as None too.
#[tauri::command]
pub fn load_launch_tools(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let _guard = TOOLS_LOCK.lock().map_err(err)?;
    let path = data_dir(&app)?.join("launch-tools.json");
    if !path.exists() {
        return Ok(None);
    }
    Ok(serde_json::from_slice(&std::fs::read(path).map_err(err)?).ok())
}
#[tauri::command]
pub fn save_launch_tools(tools: Value, app: tauri::AppHandle) -> Result<(), String> {
    let _guard = TOOLS_LOCK.lock().map_err(err)?;
    if !tools.is_object() {
        return Err("launch-tools 格式錯誤".into());
    }
    write(&data_dir(&app)?.join("launch-tools.json"), &tools)
}
// `open -a <app> <dir>`: arguments are passed as an array, never through a shell.
#[tauri::command]
pub async fn open_with_app(path: String, app: String) -> Result<(), String> {
    if !valid_app(&app) {
        return Err("應用程式名稱無效".into());
    }
    if !Path::new(&path).is_dir() {
        return Err(format!("目錄不存在：{path}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("open").arg("-a").arg(app.trim()).arg("--").arg(&path).output().map_err(err)?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_names_are_validated() {
        assert!(valid_app("Visual Studio Code"));
        assert!(!valid_app(" "));
        assert!(!valid_app("-a"));
        assert!(!valid_app("a\nb"));
    }
}
