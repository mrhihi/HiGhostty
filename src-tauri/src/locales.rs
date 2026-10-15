// 介面語系：設定（settings.json 的 language）與使用者語系檔（<data_dir>/locales/<code>.json）。
// 語系檔內容由前端解析與驗證（src/i18n.ts）；Rust 只管檔名安全、原子寫入與跨視窗通知。
use crate::{data_dir, err};
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex};
use tauri::Emitter;

static LOCALES_LOCK: Mutex<()> = Mutex::new(());
// 單一語系檔上限；匯入時避免讀進不相干的大檔。
const MAX_LOCALE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct LocaleText {
    code: String,
    text: String,
}

// 與 src/i18n.ts 的 validLocaleCode 同一條規則；code 會成為檔名，所以不允許任何路徑字元。
fn valid_code(code: &str) -> bool {
    if code.is_empty() || code.len() > 35 {
        return false;
    }
    let mut parts = code.split('-');
    let lang = parts.next().unwrap_or("");
    if !(2..=3).contains(&lang.len()) || !lang.bytes().all(|b| b.is_ascii_lowercase()) {
        return false;
    }
    parts.all(|p| (2..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}
fn locales_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("locales");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}
fn locale_path(app: &tauri::AppHandle, code: &str) -> Result<PathBuf, String> {
    if !valid_code(code) {
        return Err("invalid locale code".into());
    }
    Ok(locales_dir(app)?.join(format!("{code}.json")))
}
fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, bytes).map_err(err)?;
    std::fs::rename(temp, path).map_err(err)
}
fn read_limited(path: &std::path::Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(err)?;
    if !meta.is_file() || meta.len() > MAX_LOCALE_BYTES {
        return Err("file is not a locale file or is too large".into());
    }
    String::from_utf8(std::fs::read(path).map_err(err)?).map_err(err)
}
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("settings.json"))
}

#[tauri::command]
pub fn ui_language(app: tauri::AppHandle) -> String {
    settings_path(&app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|v| v.get("language").and_then(Value::as_str).map(str::to_owned))
        .filter(|v| v == "system" || valid_code(v))
        .unwrap_or_else(|| "system".into())
}
#[tauri::command]
pub fn set_ui_language(app: tauri::AppHandle, language: String) -> Result<(), String> {
    if language != "system" && !valid_code(&language) {
        return Err("invalid locale code".into());
    }
    let _guard = LOCALES_LOCK.lock().map_err(err)?;
    let path = settings_path(&app)?;
    // 保留 settings.json 其他欄位。
    let mut settings = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    settings["language"] = Value::String(language.clone());
    write_atomic(&path, settings.to_string().as_bytes())?;
    app.emit("language-changed", language).map_err(err)
}
#[tauri::command]
pub fn locales_list(app: tauri::AppHandle) -> Result<Vec<LocaleText>, String> {
    let _guard = LOCALES_LOCK.lock().map_err(err)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(locales_dir(&app)?).map_err(err)?.flatten() {
        let path = entry.path();
        let Some(code) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else { continue };
        if path.extension().and_then(|e| e.to_str()) != Some("json") || !valid_code(&code) {
            continue;
        }
        if let Ok(text) = read_limited(&path) {
            out.push(LocaleText { code, text });
        }
    }
    out.sort_by(|a, b| a.code.cmp(&b.code));
    Ok(out)
}
#[tauri::command]
pub fn locale_save(app: tauri::AppHandle, code: String, text: String) -> Result<(), String> {
    if text.len() as u64 > MAX_LOCALE_BYTES {
        return Err("locale file is too large".into());
    }
    let _guard = LOCALES_LOCK.lock().map_err(err)?;
    write_atomic(&locale_path(&app, &code)?, text.as_bytes())?;
    app.emit("locales-changed", code).map_err(err)
}
#[tauri::command]
pub fn locale_delete(app: tauri::AppHandle, code: String) -> Result<(), String> {
    let _guard = LOCALES_LOCK.lock().map_err(err)?;
    let path = locale_path(&app, &code)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(err)?;
    }
    app.emit("locales-changed", code).map_err(err)
}
// 匯入：只讀內容回傳，由前端驗證通過後才呼叫 locale_save。
#[tauri::command]
pub fn locale_read_file(path: String) -> Result<String, String> {
    read_limited(std::path::Path::new(&path))
}
#[tauri::command]
pub fn locale_write_file(path: String, text: String) -> Result<(), String> {
    write_atomic(std::path::Path::new(&path), text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locale_codes_become_safe_file_names() {
        for ok in ["en", "zh-Hant", "pt-BR", "ja", "fil", "sr-Latn-RS"] {
            assert!(valid_code(ok), "{ok}");
        }
        for bad in ["", "e", "EN", "../x", "en/US", "en_US", "en-", "-en", "zh-Hant.json", "a-b", "abcd"] {
            assert!(!valid_code(bad), "{bad}");
        }
    }
}
