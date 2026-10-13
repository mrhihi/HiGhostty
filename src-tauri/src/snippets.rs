// Command snippets shown by the ⌘⇧P palette. Stored as one JSON document with a
// revision so a stale window cannot overwrite another window's edits.
use crate::{data_dir, err};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::Path, sync::Mutex};
use tauri::Emitter;

static SNIPPETS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Snippets {
    revision: u64,
    items: Vec<Value>,
}

fn load(app: &tauri::AppHandle) -> Result<Snippets, String> {
    let path = data_dir(app)?.join("snippets.json");
    if !path.exists() {
        return Ok(Snippets::default());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(err)?).map_err(err)
}
fn write(path: &Path, document: &Snippets) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec_pretty(document).map_err(err)?).map_err(err)?;
    std::fs::rename(temp, path).map_err(err)
}
fn next_revision(current: u64, expected: u64) -> Result<u64, String> {
    if current != expected {
        return Err("片段已在其他視窗更新。列表已重新載入，請再套用你的修改。".into());
    }
    current.checked_add(1).ok_or_else(|| "片段修訂號已達上限".into())
}
fn validate(items: &[Value]) -> Result<(), String> {
    for item in items {
        let text = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or("").trim();
        if text("name").is_empty() {
            return Err("片段名稱不可空白".into());
        }
        if text("text").is_empty() {
            return Err("片段內容不可空白".into());
        }
        if text("scope").is_empty() {
            return Err("片段範圍不可空白".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn snippets(app: tauri::AppHandle) -> Result<Snippets, String> {
    let _guard = SNIPPETS_LOCK.lock().map_err(err)?;
    load(&app)
}
#[tauri::command]
pub fn save_snippets(items: Vec<Value>, expected_revision: u64, app: tauri::AppHandle) -> Result<Snippets, String> {
    let _guard = SNIPPETS_LOCK.lock().map_err(err)?;
    validate(&items)?;
    let current = load(&app)?;
    let document = Snippets { revision: next_revision(current.revision, expected_revision)?, items };
    write(&data_dir(&app)?.join("snippets.json"), &document)?;
    app.emit("snippets-changed", &document).map_err(err)?;
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn stale_revisions_are_rejected() {
        assert_eq!(next_revision(2, 2).unwrap(), 3);
        assert!(next_revision(3, 2).unwrap_err().contains("其他視窗更新"));
    }
    #[test]
    fn blank_fields_are_rejected() {
        let ok = json!({ "name": "status", "text": "git status", "scope": "global" });
        assert!(validate(&[ok.clone()]).is_ok());
        assert!(validate(&[json!({ "name": " ", "text": "x", "scope": "global" })]).is_err());
        assert!(validate(&[json!({ "name": "a", "text": "", "scope": "global" })]).is_err());
        assert!(validate(&[json!({ "name": "a", "text": "x", "scope": "" })]).is_err());
    }
}
