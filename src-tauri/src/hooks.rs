//! Install / remove HiGhostty's agent hooks in each agent's user config.
//! Only entries whose command mentions `hg-notify` are ever touched, so the
//! user's own hooks survive both install and removal.
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const MARK: &str = "hg-notify";
const BEGIN: &str = "# >>> highostty >>>";
const END: &str = "# <<< highostty <<<";

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Json,
    CodexToml,
}
pub struct Agent {
    pub id: &'static str,
    pub name: &'static str,
    pub file: &'static str,
    pub kind: Kind,
    pub events: &'static [(&'static str, &'static str)],
}
pub const AGENTS: &[Agent] = &[
    Agent { id: "claude", name: "Claude Code", file: ".claude/settings.json", kind: Kind::Json,
        events: &[("Notification", "waiting"), ("Stop", "done"), ("UserPromptSubmit", "resume")] },
    Agent { id: "codex", name: "Codex CLI", file: ".codex/config.toml", kind: Kind::CodexToml, events: &[] },
    Agent { id: "gemini", name: "Gemini CLI（實驗）", file: ".gemini/settings.json", kind: Kind::Json,
        events: &[("Notification", "waiting"), ("AfterAgent", "done"), ("BeforeAgent", "resume")] },
];

#[derive(Serialize)]
pub struct Status {
    pub id: &'static str,
    pub name: &'static str,
    pub file: String,
    pub installed: bool,
    pub error: Option<String>,
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}
fn is_ours(hook: &Value) -> bool {
    hook.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(MARK))
}

pub fn json_install(root: &mut Value, agent: &Agent, script: &Path) -> Result<(), String> {
    let obj = root.as_object_mut().ok_or("設定檔最外層不是物件")?;
    json_remove_in(obj);
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("hooks 欄位不是物件")?;
    for (event, action) in agent.events {
        let list = hooks.entry(*event).or_insert_with(|| json!([]));
        let list = list.as_array_mut().ok_or("hook 事件不是陣列")?;
        let command = format!("{} {} {}", quote(script), agent.id, action);
        list.push(json!({"hooks":[{"type":"command","command":command}]}));
    }
    Ok(())
}
fn json_remove_in(obj: &mut Map<String, Value>) {
    let Some(hooks) = obj.get_mut("hooks").and_then(Value::as_object_mut) else { return };
    for list in hooks.values_mut() {
        let Some(groups) = list.as_array_mut() else { continue };
        for group in groups.iter_mut() {
            if let Some(inner) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                inner.retain(|h| !is_ours(h));
            }
        }
        groups.retain(|g| g.get("hooks").and_then(Value::as_array).map_or(true, |h| !h.is_empty()));
    }
    hooks.retain(|_, v| v.as_array().map_or(true, |a| !a.is_empty()));
    if hooks.is_empty() {
        obj.remove("hooks");
    }
}
pub fn json_remove(root: &mut Value) {
    if let Some(obj) = root.as_object_mut() {
        json_remove_in(obj);
    }
}
pub fn json_installed(root: &Value) -> bool {
    root.get("hooks").and_then(Value::as_object).is_some_and(|h| {
        h.values().filter_map(Value::as_array).flatten().any(|g| {
            g.get("hooks").and_then(Value::as_array).is_some_and(|inner| inner.iter().any(is_ours))
        })
    })
}

fn toml_block(script: &Path) -> String {
    let path = script.display().to_string().replace('\\', "\\\\").replace('"', "\\\"");
    format!("{BEGIN}\nnotify = [\"{path}\", \"codex\", \"done\"]\n{END}\n")
}
pub fn toml_remove(text: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in text.split_inclusive('\n') {
        let t = line.trim();
        if t == BEGIN { skipping = true; continue; }
        if skipping { if t == END { skipping = false; } continue; }
        out.push_str(line);
    }
    out
}
pub fn toml_installed(text: &str) -> bool {
    text.lines().any(|l| l.trim() == BEGIN)
}
pub fn toml_install(text: &str, script: &Path) -> Result<String, String> {
    let rest = toml_remove(text);
    // `notify` must be a top-level key: refuse if the user already has one.
    for line in rest.lines() {
        let t = line.trim_start();
        if t.starts_with('[') { break; }
        if t.starts_with("notify") && t[6..].trim_start().starts_with('=') {
            return Err("config.toml 已有 notify 設定，請手動整合以免覆蓋".into());
        }
    }
    Ok(format!("{}{}", toml_block(script), rest))
}

fn target(home: &Path, agent: &Agent) -> PathBuf { home.join(agent.file) }
fn find(id: &str) -> Result<&'static Agent, String> {
    AGENTS.iter().find(|a| a.id == id).ok_or_else(|| "未知的 agent".to_string())
}
fn read(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
fn backup_and_write(path: &Path, existed: bool, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    if existed {
        let bak = PathBuf::from(format!("{}.highostty.bak", path.display()));
        if !bak.exists() { std::fs::copy(path, &bak).map_err(|e| e.to_string())?; }
    }
    // Write beside the file then rename, so a crash cannot truncate user config.
    let tmp = PathBuf::from(format!("{}.highostty.tmp", path.display()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}
fn parse_json(text: Option<String>) -> Result<Value, String> {
    match text {
        None => Ok(json!({})),
        Some(t) if t.trim().is_empty() => Ok(json!({})),
        Some(t) => serde_json::from_str(&t).map_err(|e| format!("設定檔不是有效的 JSON：{e}")),
    }
}
fn pretty(v: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(v).map(|s| s + "\n").map_err(|e| e.to_string())
}

pub fn status(home: &Path) -> Vec<Status> {
    AGENTS.iter().map(|a| {
        let path = target(home, a);
        let (installed, error) = match read(&path) {
            Err(e) => (false, Some(e)),
            Ok(text) => match a.kind {
                Kind::CodexToml => (text.as_deref().is_some_and(toml_installed), None),
                Kind::Json => match parse_json(text) {
                    Ok(v) => (json_installed(&v), None),
                    Err(e) => (false, Some(e)),
                },
            },
        };
        Status { id: a.id, name: a.name, file: path.display().to_string(), installed, error }
    }).collect()
}
pub fn install(home: &Path, id: &str, script: &Path) -> Result<(), String> {
    let agent = find(id)?;
    let path = target(home, agent);
    let text = read(&path)?;
    let existed = text.is_some();
    let out = match agent.kind {
        Kind::CodexToml => toml_install(text.as_deref().unwrap_or(""), script)?,
        Kind::Json => { let mut v = parse_json(text)?; json_install(&mut v, agent, script)?; pretty(&v)? }
    };
    backup_and_write(&path, existed, &out)
}
pub fn remove(home: &Path, id: &str) -> Result<(), String> {
    let agent = find(id)?;
    let path = target(home, agent);
    let Some(text) = read(&path)? else { return Ok(()) };
    let out = match agent.kind {
        Kind::CodexToml => toml_remove(&text),
        Kind::Json => { let mut v = parse_json(Some(text))?; json_remove(&mut v); pretty(&v)? }
    };
    backup_and_write(&path, true, &out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn script() -> PathBuf { PathBuf::from("/data/hg-notify") }

    #[test]
    fn json_install_keeps_user_hooks_and_is_idempotent() {
        let mut v = json!({"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}});
        json_install(&mut v, &AGENTS[0], &script()).unwrap();
        json_install(&mut v, &AGENTS[0], &script()).unwrap();
        assert!(json_installed(&v));
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(v["hooks"]["Notification"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn json_remove_restores_original() {
        let original = json!({"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}});
        let mut v = original.clone();
        json_install(&mut v, &AGENTS[0], &script()).unwrap();
        json_remove(&mut v);
        assert_eq!(v, original);
        let mut empty = json!({});
        json_install(&mut empty, &AGENTS[0], &script()).unwrap();
        json_remove(&mut empty);
        assert_eq!(empty, json!({}));
    }
    #[test]
    fn toml_roundtrip_and_conflict() {
        let original = "model = \"o3\"\n[tui]\nx = 1\n";
        let installed = toml_install(original, &script()).unwrap();
        assert!(toml_installed(&installed));
        assert!(installed.starts_with(BEGIN));
        assert_eq!(toml_remove(&installed), original);
        assert_eq!(toml_install(&installed, &script()).unwrap(), installed);
        assert!(toml_install("notify = [\"x\"]\n", &script()).is_err());
        // notify inside another table is not a conflict
        assert!(toml_install("[a]\nnotify = 1\n", &script()).is_ok());
    }
}
