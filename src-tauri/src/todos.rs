// Todo items for the ⌘⇧L drop. Stored as one JSON document with a revision so a
// stale window cannot overwrite another window's edits.
use crate::{data_dir, err};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::Path, sync::Mutex};
use tauri::Emitter;

static TODOS_LOCK: Mutex<()> = Mutex::new(());
const MAX_TEXT_CHARS: usize = 20_000;
const MAX_CATEGORY_CHARS: usize = 40;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Todos {
    revision: u64,
    items: Vec<Value>,
}

fn load(app: &tauri::AppHandle) -> Result<Todos, String> {
    let path = data_dir(app)?.join("todos.json");
    if !path.exists() {
        return Ok(Todos::default());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(err)?).map_err(err)
}
fn write(path: &Path, document: &Todos) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec_pretty(document).map_err(err)?).map_err(err)?;
    std::fs::rename(temp, path).map_err(err)
}
fn next_revision(current: u64, expected: u64) -> Result<u64, String> {
    if current != expected {
        return Err("待辦已在其他視窗更新。列表已重新載入，請再套用你的修改。".into());
    }
    current.checked_add(1).ok_or_else(|| "待辦修訂號已達上限".into())
}
fn validate(items: &[Value]) -> Result<(), String> {
    for item in items {
        let text = item.get("text").and_then(Value::as_str).unwrap_or("");
        if text.trim().is_empty() {
            return Err("待辦內容不可空白".into());
        }
        if text.chars().count() > MAX_TEXT_CHARS {
            return Err("待辦內容過長".into());
        }
        if text.contains('\0') {
            return Err("待辦內容含有無效字元".into());
        }
        let category = item.get("category").and_then(Value::as_str).unwrap_or("");
        if category.chars().count() > MAX_CATEGORY_CHARS || category.contains('\n') {
            return Err("待辦分類格式不正確".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn todos(app: tauri::AppHandle) -> Result<Todos, String> {
    let _guard = TODOS_LOCK.lock().map_err(err)?;
    load(&app)
}
#[tauri::command]
pub fn save_todos(items: Vec<Value>, expected_revision: u64, app: tauri::AppHandle) -> Result<Todos, String> {
    let _guard = TODOS_LOCK.lock().map_err(err)?;
    validate(&items)?;
    let current = load(&app)?;
    let document = Todos { revision: next_revision(current.revision, expected_revision)?, items };
    write(&data_dir(&app)?.join("todos.json"), &document)?;
    app.emit("todos-changed", &document).map_err(err)?;
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn stale_revisions_are_rejected() {
        assert_eq!(next_revision(4, 4).unwrap(), 5);
        assert!(next_revision(5, 4).unwrap_err().contains("其他視窗更新"));
    }
    #[test]
    fn blank_text_is_rejected_and_multiline_is_kept() {
        assert!(validate(&[json!({ "text": "line one\nline two", "category": "" })]).is_ok());
        assert!(validate(&[json!({ "text": " \n ", "category": "" })]).is_err());
        assert!(validate(&[json!({ "text": "a\u{0}b", "category": "" })]).is_err());
    }
    #[test]
    fn category_length_and_newlines_are_checked() {
        assert!(validate(&[json!({ "text": "x", "category": "bug" })]).is_ok());
        assert!(validate(&[json!({ "text": "x", "category": "a\nb" })]).is_err());
        assert!(validate(&[json!({ "text": "x", "category": "a".repeat(41) })]).is_err());
    }
}
