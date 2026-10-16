// Claude Code / Codex 用量（5 小時與每週視窗）。細節與驗收見 docs/usage.md。
// 錯誤只回代碼（前端翻譯）；Claude 的 OAuth token 只存在記憶體，不寫檔、不進錯誤訊息。
use serde_json::{json, Value};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

// 端點限流很嚴（連續兩次請求就會 429），所以成功與失敗都要久一點才重打；手動重新整理也有最短間隔。
const CLAUDE_TTL: Duration = Duration::from_secs(180);
const CLAUDE_RETRY: Duration = Duration::from_secs(180);
const CLAUDE_MIN_FORCE: Duration = Duration::from_secs(30);
const TAIL_BYTES: u64 = 512 * 1024;
const MAX_CODEX_FILES: usize = 6;

fn window(entry: Option<&Value>, pct_key: &str, reset_key: &str) -> Value {
    let Some(e) = entry.filter(|e| e.is_object()) else { return Value::Null };
    let Some(pct) = e.get(pct_key).and_then(Value::as_f64) else { return Value::Null };
    json!({ "pct": pct, "resets_at": e.get(reset_key).cloned().unwrap_or(Value::Null) })
}

fn failure(code: &str) -> Value {
    json!({ "error": code })
}

// ---------- Codex ----------

/// 從一段 jsonl 文字由尾端往前找最後一筆 token_count 的 rate_limits。
fn codex_from_text(text: &str) -> Option<Value> {
    for line in text.lines().rev() {
        if !line.contains("rate_limits") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let payload = v.get("payload")?;
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(limits) = payload.get("rate_limits").filter(|l| l.is_object()) else { continue };
        return Some(json!({
            "five_hour": window(limits.get("primary"), "used_percent", "resets_at"),
            "week": window(limits.get("secondary"), "used_percent", "resets_at"),
            "plan": limits.get("plan_type").cloned().unwrap_or(Value::Null),
        }));
    }
    None
}

fn rollouts(dir: &Path, out: &mut Vec<(SystemTime, PathBuf)>, depth: u8) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if depth < 4 {
                rollouts(&path, out, depth + 1);
            }
        } else if path.extension().is_some_and(|e| e == "jsonl")
            && path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-"))
        {
            if let Ok(modified) = meta.modified() {
                out.push((modified, path));
            }
        }
    }
}

fn tail_text(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES))).ok()?;
    let mut buf = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn codex_read(home: &Path) -> Value {
    let root = home.join(".codex").join("sessions");
    if !root.is_dir() {
        return failure("not-installed");
    }
    let mut files = Vec::new();
    rollouts(&root, &mut files, 0);
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (modified, path) in files.into_iter().take(MAX_CODEX_FILES) {
        let Some(text) = tail_text(&path) else { continue };
        if let Some(mut found) = codex_from_text(&text) {
            let at = modified.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            found["updated_at"] = json!(at);
            return found;
        }
    }
    failure("no-data")
}

#[tauri::command]
pub async fn usage_codex() -> Value {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return failure("no-data") };
    tauri::async_runtime::spawn_blocking(move || codex_read(&home)).await.unwrap_or_else(|_| failure("no-data"))
}

// ---------- Claude Code ----------

struct ClaudeState {
    at: Instant,
    // 最近一次的結果（可能是錯誤）與最近一次成功的結果；失敗時先顯示舊數字並標註警告。
    latest: Value,
    good: Option<Value>,
}
static CLAUDE: Mutex<Option<ClaudeState>> = Mutex::new(None);

fn is_failure(value: &Value) -> bool {
    value.get("error").is_some()
}

impl ClaudeState {
    fn response(&self) -> Value {
        match (&self.good, is_failure(&self.latest)) {
            (Some(good), true) => {
                let mut v = good.clone();
                v["warning"] = self.latest["error"].clone();
                v
            }
            _ => self.latest.clone(),
        }
    }
}

fn claude_from_json(v: &Value) -> Value {
    let five = window(v.get("five_hour"), "utilization", "resets_at");
    let week = window(v.get("seven_day"), "utilization", "resets_at");
    if five.is_null() && week.is_null() {
        return failure("bad-response");
    }
    json!({ "five_hour": five, "week": week, "plan": Value::Null })
}

fn keychain_token() -> Result<String, &'static str> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "no-token")?;
    if !out.status.success() {
        return Err("no-token");
    }
    let secret: Value = serde_json::from_slice(&out.stdout).map_err(|_| "no-token")?;
    secret
        .pointer("/claudeAiOauth/accessToken")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty() && !t.contains(['"', '\\', '\n']))
        .map(String::from)
        .ok_or("no-token")
}

fn claude_fetch() -> Value {
    let token = match keychain_token() {
        Ok(t) => t,
        Err(code) => return failure(code),
    };
    // token 經 stdin 的 curl 設定檔傳入，不出現在行程參數列。
    let Ok(mut child) = Command::new("curl")
        .args(["-sS", "-m", "10", "-w", "\n%{http_code}", "-K", "-", "https://api.anthropic.com/api/oauth/usage"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return failure("network");
    };
    if let Some(mut stdin) = child.stdin.take() {
        let config = format!("header = \"Authorization: Bearer {token}\"\nheader = \"anthropic-beta: oauth-2025-04-20\"\n");
        let _ = stdin.write_all(config.as_bytes());
    }
    let Ok(out) = child.wait_with_output() else { return failure("network") };
    let text = String::from_utf8_lossy(&out.stdout);
    let Some((body, status)) = text.rsplit_once('\n') else { return failure("network") };
    match status.trim() {
        "200" => serde_json::from_str::<Value>(body).map(|v| claude_from_json(&v)).unwrap_or_else(|_| failure("bad-response")),
        "401" | "403" => failure("unauthorized"),
        "429" => failure("rate-limited"),
        "000" => failure("network"),
        _ => failure("http"),
    }
}

#[tauri::command]
pub async fn usage_claude(force: Option<bool>) -> Value {
    let force = force.unwrap_or(false);
    if let Some(state) = CLAUDE.lock().ok().as_deref().and_then(Option::as_ref) {
        let ttl = if is_failure(&state.latest) { CLAUDE_RETRY } else { CLAUDE_TTL };
        let wait = if force { CLAUDE_MIN_FORCE } else { ttl };
        if state.at.elapsed() < wait {
            return state.response();
        }
    }
    let value = tauri::async_runtime::spawn_blocking(claude_fetch).await.unwrap_or_else(|_| failure("network"));
    // 失敗也記下時間，避免每次輪詢都彈 Keychain 授權或打 API。
    let mut guard = match CLAUDE.lock() {
        Ok(g) => g,
        Err(_) => return value,
    };
    let good = if is_failure(&value) { guard.as_ref().and_then(|s| s.good.clone()) } else { Some(value.clone()) };
    let state = ClaudeState { at: Instant::now(), latest: value, good };
    let response = state.response();
    *guard = Some(state);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_takes_last_token_count() {
        let text = concat!(
            r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":1.0,"window_minutes":300,"resets_at":100},"secondary":{"used_percent":2.0,"window_minutes":10080,"resets_at":200},"plan_type":"plus"}}}"#, "\n",
            r#"{"type":"event_msg","payload":{"type":"agent_message","note":"rate_limits"}}"#, "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":4.0,"window_minutes":300,"resets_at":300},"secondary":{"used_percent":11.0,"window_minutes":10080,"resets_at":400},"plan_type":"plus"}}}"#, "\n",
            "{broken rate_limits",
        );
        let v = codex_from_text(text).unwrap();
        assert_eq!(v["five_hour"]["pct"], 4.0);
        assert_eq!(v["week"]["resets_at"], 400);
        assert_eq!(v["plan"], "plus");
    }

    #[test]
    fn codex_without_rate_limits_is_none() {
        assert!(codex_from_text(r#"{"payload":{"type":"token_count","rate_limits":null}}"#).is_none());
    }

    #[test]
    fn claude_maps_utilization() {
        let v = claude_from_json(&json!({
            "five_hour": {"utilization": 6.0, "resets_at": "2026-10-16T09:10:00+00:00"},
            "seven_day": {"utilization": 98.0, "resets_at": "2026-10-19T05:00:00+00:00"}
        }));
        assert_eq!(v["five_hour"]["pct"], 6.0);
        assert_eq!(v["week"]["resets_at"], "2026-10-19T05:00:00+00:00");
        assert_eq!(claude_from_json(&json!({"five_hour": null}))["error"], "bad-response");
    }

    #[test]
    fn claude_failure_keeps_last_good_value_with_warning() {
        let good = claude_from_json(&json!({"five_hour": {"utilization": 10.0, "resets_at": "x"}}));
        let state = ClaudeState { at: Instant::now(), latest: failure("rate-limited"), good: Some(good) };
        let r = state.response();
        assert_eq!(r["five_hour"]["pct"], 10.0);
        assert_eq!(r["warning"], "rate-limited");
        assert!(r.get("error").is_none());
        let bare = ClaudeState { at: Instant::now(), latest: failure("rate-limited"), good: None };
        assert_eq!(bare.response()["error"], "rate-limited");
    }
}
