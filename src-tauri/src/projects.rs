// Project journal store (docs/project-implementation.md §4, S1 subset). One append-only
// journal per project root is the only authority: events are validated and reduced in TS,
// this side only guarantees ordering (revision CAS), durability, de-duplication by
// actionId and single-writer (OS lock). Owner epochs and artifacts arrive with S2/S3.
use crate::{data_dir, err};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    io::Write,
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

const MAX_TX_BYTES: usize = 1024 * 1024;
const SYNCED_MARKERS: [&str; 4] = ["Mobile Documents", "Dropbox", "CloudStorage", "OneDrive"];

struct Store {
    root: PathBuf,
    revision: u64,
    action_ids: HashMap<String, u64>,
    transactions: Vec<Value>,
    // Why writes are refused; the project can still be read.
    readonly: Option<String>,
    // Held for the life of the process so a second app instance cannot also write.
    _lock: Option<File>,
}

static STORES: Mutex<Option<HashMap<PathBuf, Store>>> = Mutex::new(None);
static INDEX_LOCK: Mutex<()> = Mutex::new(());

// FNV-1a: detects truncation and bit rot, not tampering (the model does not defend against the same user).
fn checksum(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn encode(tx: &Value) -> Result<String, String> {
    let body = serde_json::to_string(tx).map_err(err)?;
    let line = serde_json::to_string(&json!({ "checksum": checksum(body.as_bytes()), "tx": tx })).map_err(err)?;
    if line.len() > MAX_TX_BYTES {
        return Err("單筆專案更新超過 1 MiB".into());
    }
    Ok(line)
}

fn decode(line: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(line).map_err(err)?;
    let tx = value.get("tx").ok_or("缺少 tx")?;
    let expected = value.get("checksum").and_then(Value::as_str).ok_or("缺少 checksum")?;
    let body = serde_json::to_string(tx).map_err(err)?;
    if checksum(body.as_bytes()) != expected {
        return Err("checksum 不符".into());
    }
    Ok(tx.clone())
}

fn try_lock(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new().create(true).write(true).truncate(false).open(path).map_err(err)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("這個專案已被另一個 HiGhostty 開啟，無法寫入".into());
    }
    Ok(file)
}

fn synced_folder(root: &Path) -> Option<&'static str> {
    let text = root.to_string_lossy();
    SYNCED_MARKERS.iter().copied().find(|marker| text.contains(marker))
}

struct Loaded {
    revision: u64,
    action_ids: HashMap<String, u64>,
    transactions: Vec<Value>,
    // Byte length of the valid prefix; anything after it is a torn tail.
    valid_len: usize,
    problem: Option<String>,
}

fn replay(bytes: &[u8]) -> Loaded {
    let mut out = Loaded { revision: 0, action_ids: HashMap::new(), transactions: vec![], valid_len: 0, problem: None };
    let mut offset = 0;
    let mut lineno = 0;
    while offset < bytes.len() {
        lineno += 1;
        let Some(end) = bytes[offset..].iter().position(|b| *b == b'\n') else { break };
        let parsed = std::str::from_utf8(&bytes[offset..offset + end]).map_err(err).and_then(decode);
        let at_tail = offset + end + 1 >= bytes.len();
        match parsed {
            Ok(tx) => {
                let revision = tx.get("revision").and_then(Value::as_u64).unwrap_or(0);
                if revision != out.revision + 1 {
                    out.problem = Some(format!("第 {lineno} 行 revision 不連續（應為 {}，實為 {revision}）", out.revision + 1));
                    return out;
                }
                out.revision = revision;
                if let Some(id) = tx.get("actionId").and_then(Value::as_str) {
                    out.action_ids.insert(id.to_string(), revision);
                }
                out.transactions.push(tx);
                offset += end + 1;
                out.valid_len = offset;
            }
            // A bad last line is a torn write; a bad line followed by more data is real damage.
            Err(_) if at_tail => break,
            Err(e) => {
                out.problem = Some(format!("第 {lineno} 行損毀：{e}"));
                return out;
            }
        }
    }
    out
}

fn open_store(root: &Path, create: bool) -> Result<Store, String> {
    let dir = root.join(".highostty");
    let journal_dir = dir.join("journal");
    let journal = journal_dir.join("events.jsonl");
    if !journal_dir.is_dir() && !create {
        return Err("這個資料夾沒有 HiGhostty 專案（找不到 .highostty）".into());
    }
    let mut readonly = synced_folder(root).map(|m| format!("專案位於同步資料夾（{m}），journal 與鎖可能失效，已設為唯讀"));
    let mut lock = None;
    if readonly.is_none() {
        let attempt = std::fs::create_dir_all(dir.join("local"))
            .and_then(|_| std::fs::create_dir_all(&journal_dir))
            .map_err(err)
            .and_then(|_| try_lock(&dir.join("local").join("lock")));
        match attempt {
            Ok(file) => lock = Some(file),
            Err(reason) => readonly = Some(reason),
        }
    }
    let bytes = std::fs::read(&journal).unwrap_or_default();
    let loaded = replay(&bytes);
    if let Some(problem) = loaded.problem {
        readonly = Some(format!("journal 異常，已設為唯讀：{problem}"));
    } else if loaded.valid_len < bytes.len() && lock.is_some() {
        // Torn tail from a crash mid-append: keep a copy, then cut back to the last full transaction.
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        std::fs::write(journal_dir.join(format!("tail-{stamp}.bak")), &bytes[loaded.valid_len..]).map_err(err)?;
        OpenOptions::new().write(true).open(&journal).map_err(err)?.set_len(loaded.valid_len as u64).map_err(err)?;
    } else if loaded.valid_len < bytes.len() {
        readonly = readonly.or(Some("journal 尾端不完整，需可寫入時才能修復".into()));
    }
    Ok(Store { root: root.to_path_buf(), revision: loaded.revision, action_ids: loaded.action_ids, transactions: loaded.transactions, readonly, _lock: lock })
}

impl Store {
    fn append(&mut self, expected: u64, action_id: &str, events: Value) -> Result<(u64, bool), String> {
        if let Some(revision) = self.action_ids.get(action_id) {
            return Ok((*revision, true));
        }
        if let Some(reason) = &self.readonly {
            return Err(format!("storage_readonly: {reason}"));
        }
        if expected != self.revision {
            return Err(format!("revision_conflict: 專案已更新到 {}（你的版本 {expected}）", self.revision));
        }
        let revision = self.revision + 1;
        let tx = json!({ "schemaVersion": 1, "revision": revision, "actionId": action_id, "events": events });
        let line = encode(&tx)?;
        let mut file = OpenOptions::new().create(true).append(true).open(self.root.join(".highostty/journal/events.jsonl")).map_err(err)?;
        let before = file.metadata().map_err(err)?.len();
        let written = file.write_all(format!("{line}\n").as_bytes()).and_then(|_| file.sync_data());
        if let Err(error) = written {
            // Cut a half-written line off again; left in place the next append would sit behind it and
            // the journal would later look damaged in the middle.
            let _ = file.set_len(before);
            return Err(err(error));
        }
        self.revision = revision;
        self.action_ids.insert(action_id.to_string(), revision);
        self.transactions.push(tx);
        Ok((revision, false))
    }
    fn snapshot(&self, after: u64) -> Value {
        let transactions: Vec<&Value> = self.transactions.iter().filter(|t| t["revision"].as_u64().unwrap_or(0) > after).collect();
        json!({ "root": self.root, "revision": self.revision, "transactions": transactions, "readonlyReason": self.readonly })
    }
}

fn with_store<T>(root: &Path, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
    let mut guard = STORES.lock().map_err(err)?;
    let store = guard.get_or_insert_with(HashMap::new).get_mut(root).ok_or("專案尚未開啟")?;
    f(store)
}

fn canonical(root: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(root).map_err(|e| format!("找不到資料夾：{e}"))
}

// `.highostty` is a project-local, per-machine-ish folder; offer to keep it out of Git.
fn git_exclude(root: &Path) -> Result<(), String> {
    let info = root.join(".git").join("info");
    if !root.join(".git").is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(&info).map_err(err)?;
    let path = info.join("exclude");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.lines().any(|l| l.trim() == ".highostty/") {
        return Ok(());
    }
    let prefix = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    OpenOptions::new().create(true).append(true).open(path).map_err(err)?.write_all(format!("{prefix}.highostty/\n").as_bytes()).map_err(err)
}

#[tauri::command]
pub fn project_open(root: String, create: bool, git_exclude_on_create: bool) -> Result<Value, String> {
    let root = canonical(&root)?;
    let mut guard = STORES.lock().map_err(err)?;
    let stores = guard.get_or_insert_with(HashMap::new);
    if !stores.contains_key(&root) {
        let store = open_store(&root, create)?;
        stores.insert(root.clone(), store);
        if create && git_exclude_on_create {
            git_exclude(&root)?;
        }
    }
    Ok(stores[&root].snapshot(0))
}

#[tauri::command]
pub fn project_snapshot(root: String, after_revision: Option<u64>) -> Result<Value, String> {
    let root = canonical(&root)?;
    with_store(&root, |s| Ok(s.snapshot(after_revision.unwrap_or(0))))
}

#[tauri::command]
pub fn project_commit(root: String, expected_revision: u64, action_id: String, events: Value, app: tauri::AppHandle) -> Result<Value, String> {
    let root = canonical(&root)?;
    if !events.is_array() {
        return Err("events 必須是陣列".into());
    }
    // The lock is released before emitting so a slow listener cannot stall other commits.
    let (revision, duplicate) = with_store(&root, |s| s.append(expected_revision, &action_id, events))?;
    if !duplicate {
        app.emit("project-changed", json!({ "root": root, "revision": revision })).map_err(err)?;
    }
    Ok(json!({ "revision": revision, "duplicate": duplicate }))
}

#[tauri::command]
pub fn project_close(root: String) -> Result<(), String> {
    let root = canonical(&root)?;
    if let Some(stores) = STORES.lock().map_err(err)?.as_mut() {
        stores.remove(&root);
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Index {
    items: Vec<IndexItem>,
}
#[derive(Serialize, Deserialize, Clone)]
struct IndexItem {
    root: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "projectId")]
    project_id: String,
    #[serde(default, rename = "lastOpenedAt")]
    last_opened_at: String,
}

fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("projects-index-v1.json"))
}
fn read_index(app: &tauri::AppHandle) -> Result<Index, String> {
    let path = index_path(app)?;
    if !path.exists() {
        return Ok(Index::default());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(err)?).map_err(err)
}
fn write_index(app: &tauri::AppHandle, index: &Index) -> Result<(), String> {
    let path = index_path(app)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec_pretty(index).map_err(err)?).map_err(err)?;
    std::fs::rename(temp, path).map_err(err)
}

#[tauri::command]
pub fn project_index_list(app: tauri::AppHandle) -> Result<Value, String> {
    let _guard = INDEX_LOCK.lock().map_err(err)?;
    let items: Vec<Value> = read_index(&app)?
        .items
        .into_iter()
        .map(|i| json!({ "root": i.root, "name": i.name, "projectId": i.project_id, "lastOpenedAt": i.last_opened_at, "exists": Path::new(&i.root).join(".highostty").is_dir() }))
        .collect();
    Ok(json!(items))
}

// Remembers a project in the sidebar list; the root (canonical) is the identity, so re-adding just refreshes it.
#[tauri::command]
pub fn project_index_touch(root: String, name: String, project_id: String, opened_at: String, app: tauri::AppHandle) -> Result<(), String> {
    let root = canonical(&root)?.to_string_lossy().to_string();
    let _guard = INDEX_LOCK.lock().map_err(err)?;
    let mut index = read_index(&app)?;
    let item = IndexItem { root: root.clone(), name, project_id, last_opened_at: opened_at };
    match index.items.iter_mut().find(|i| i.root == root) {
        Some(existing) => *existing = item,
        None => index.items.push(item),
    }
    write_index(&app, &index)?;
    app.emit("project-index-changed", ()).map_err(err)
}

// Only forgets the entry; the .highostty folder and its journal are left untouched.
#[tauri::command]
pub fn project_index_remove(root: String, app: tauri::AppHandle) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock().map_err(err)?;
    let mut index = read_index(&app)?;
    let seen: HashSet<String> = [root.clone(), canonical(&root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()].into();
    index.items.retain(|i| !seen.contains(&i.root));
    write_index(&app, &index)?;
    app.emit("project-index-changed", ()).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("hg-proj-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::canonicalize(root).unwrap()
    }
    fn journal(root: &Path) -> PathBuf {
        root.join(".highostty/journal/events.jsonl")
    }

    #[test]
    fn open_requires_create_flag_for_new_folder() {
        let root = temp_root("nocreate");
        assert!(open_store(&root, false).is_err());
        assert!(open_store(&root, true).is_ok());
    }

    #[test]
    fn append_replays_after_reopen_and_dedups_by_action_id() {
        let root = temp_root("replay");
        let mut s = open_store(&root, true).unwrap();
        assert_eq!(s.append(0, "a1", json!([{"type": "X"}])).unwrap(), (1, false));
        assert_eq!(s.append(1, "a2", json!([])).unwrap(), (2, false));
        assert_eq!(s.append(0, "a1", json!([])).unwrap(), (1, true), "same actionId returns the first result even with a stale revision");
        drop(s);
        let s = open_store(&root, false).unwrap();
        assert_eq!(s.revision, 2);
        assert_eq!(s.snapshot(1)["transactions"].as_array().unwrap().len(), 1);
        assert!(s.readonly.is_none());
    }

    #[test]
    fn stale_revision_is_a_conflict() {
        let root = temp_root("cas");
        let mut s = open_store(&root, true).unwrap();
        s.append(0, "a1", json!([])).unwrap();
        assert!(s.append(0, "a2", json!([])).unwrap_err().starts_with("revision_conflict"));
        assert_eq!(s.revision, 1);
    }

    #[test]
    fn torn_tail_is_backed_up_and_cut_back() {
        let root = temp_root("torn");
        let mut s = open_store(&root, true).unwrap();
        s.append(0, "a1", json!([])).unwrap();
        drop(s);
        let mut f = OpenOptions::new().append(true).open(journal(&root)).unwrap();
        f.write_all(b"{\"checksum\":\"abc\",\"tx\":{\"rev").unwrap();
        drop(f);
        let mut s = open_store(&root, false).unwrap();
        assert_eq!(s.revision, 1);
        assert!(s.readonly.is_none());
        assert!(std::fs::read_dir(root.join(".highostty/journal")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("tail-")));
        assert_eq!(s.append(1, "a2", json!([])).unwrap(), (2, false), "writing continues after repair");
    }

    #[test]
    fn mid_journal_damage_makes_it_read_only() {
        let root = temp_root("damage");
        let mut s = open_store(&root, true).unwrap();
        for (i, id) in ["a1", "a2", "a3"].iter().enumerate() {
            s.append(i as u64, id, json!([])).unwrap();
        }
        drop(s);
        let text = std::fs::read_to_string(journal(&root)).unwrap();
        let mut lines: Vec<String> = text.lines().map(String::from).collect();
        lines[1] = lines[1].replace("a2", "zz");
        std::fs::write(journal(&root), lines.join("\n") + "\n").unwrap();
        let mut s = open_store(&root, false).unwrap();
        assert!(s.readonly.as_ref().unwrap().contains("第 2 行"));
        assert!(s.append(s.revision, "a9", json!([])).unwrap_err().starts_with("storage_readonly"));
    }

    #[test]
    fn second_opener_in_same_process_tree_gets_readonly() {
        let root = temp_root("lock");
        let first = open_store(&root, true).unwrap();
        let second = open_store(&root, false).unwrap();
        assert!(first.readonly.is_none());
        assert!(second.readonly.as_ref().unwrap().contains("另一個"));
    }

    #[test]
    fn synced_folders_are_read_only() {
        assert!(synced_folder(Path::new("/Users/a/Library/Mobile Documents/x")).is_some());
        assert!(synced_folder(Path::new("/Users/a/code/x")).is_none());
    }

    #[test]
    fn git_exclude_is_idempotent_and_skips_non_git() {
        let root = temp_root("git");
        git_exclude(&root).unwrap();
        assert!(!root.join(".git").exists());
        std::fs::create_dir_all(root.join(".git")).unwrap();
        git_exclude(&root).unwrap();
        git_exclude(&root).unwrap();
        let text = std::fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        assert_eq!(text.matches(".highostty/").count(), 1);
    }

    #[test]
    fn oversized_transactions_are_rejected() {
        let root = temp_root("big");
        let mut s = open_store(&root, true).unwrap();
        let big = "x".repeat(MAX_TX_BYTES);
        assert!(s.append(0, "a1", json!([{ "t": big }])).is_err());
        assert_eq!(s.revision, 0);
    }
}
