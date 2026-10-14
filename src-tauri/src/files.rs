// Files panel commands. Listing uses std; changes go through native/files.m so
// copies keep Finder metadata and deletes use the Trash.
use crate::{err, expand_path};
use serde::Serialize;
use serde_json::Value;
use std::{
    ffi::{CStr, CString},
    time::UNIX_EPOCH,
};
extern "C" {
    fn hg_files(request: *const libc::c_char) -> *mut libc::c_char;
}
#[derive(Serialize)]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
    modified_ms: u64,
    has_children: bool,
}
fn visible(name: &str, show_hidden: bool) -> bool {
    show_hidden || !name.starts_with('.')
}
fn modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
#[tauri::command]
pub async fn list_files(path: String, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = expand_path(&path, None)?;
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(path).map_err(err)? {
            let entry = entry.map_err(err)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !visible(&name, show_hidden) {
                continue;
            }
            let path = entry.path();
            let link = entry.metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);
            // Follow symlinks for type and size; a broken link is shown as a file.
            let metadata = std::fs::metadata(&path).or_else(|_| entry.metadata());
            let (is_dir, size, modified) = metadata
                .map(|m| (m.is_dir(), m.len(), modified_ms(&m)))
                .unwrap_or((false, 0, 0));
            let has_children = is_dir
                && std::fs::read_dir(&path)
                    .map(|mut items| {
                        items.any(|e| e.map(|e| visible(&e.file_name().to_string_lossy(), show_hidden)).unwrap_or(false))
                    })
                    .unwrap_or(false);
            entries.push(FileEntry {
                path: path.to_string_lossy().into_owned(),
                name,
                is_dir,
                is_symlink: link,
                size: if is_dir { 0 } else { size },
                modified_ms: modified,
                has_children,
            });
        }
        Ok(entries)
    })
    .await
    .map_err(err)?
}
// Cheap change detection for polling: the directory's own modification time.
// Async so a slow volume never blocks the main thread.
#[tauri::command]
pub async fn dir_stamp(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = std::fs::metadata(expand_path(&path, None)?).map_err(err)?;
        Ok(modified_ms(&metadata))
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn file_op(request: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let request = CString::new(request.to_string()).map_err(err)?;
        let raw = unsafe { hg_files(request.as_ptr()) };
        if raw.is_null() {
            return Err("檔案操作未傳回結果".into());
        }
        let value = unsafe { serde_json::from_slice::<Value>(CStr::from_ptr(raw).to_bytes()).map_err(err) };
        unsafe { libc::free(raw.cast()) };
        let value = value?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(error.to_owned());
        }
        Ok(value)
    })
    .await
    .map_err(err)?
}
