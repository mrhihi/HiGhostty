// Claude Code / Codex / Grok 用量。細節與驗收見 docs/usage.md。
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

// ---------- Grok ----------
// 只讀 Grok CLI 寫下的帳務紀錄，不開 auth.json、不打 API。

const GROK_CHUNK: u64 = 1024 * 1024;
const GROK_MAX: u64 = 8 * 1024 * 1024;
const BILLING_MSG: &str = "billing: fetched credits config";

fn grok_root() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("GROK_HOME") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".grok"))
}

/// 略過小數，把 `YYYY-MM-DDTHH:MM:SS[.frac]Z` 或 `±HH:MM` 換成 epoch 秒。
fn unix_secs(iso: &str) -> Option<u64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year: i32 = iso.get(0..4)?.parse().ok()?;
    let month: u32 = iso.get(5..7)?.parse().ok()?;
    let day: u32 = iso.get(8..10)?.parse().ok()?;
    let hour: u32 = iso.get(11..13)?.parse().ok()?;
    let min: u32 = iso.get(14..16)?.parse().ok()?;
    let sec: u32 = iso.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 60 {
        return None;
    }
    let y = if month <= 2 { year as i64 - 1 } else { year as i64 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if month > 2 { month as u64 - 3 } else { month as u64 + 9 };
    let doy = (153 * mp + 2) / 5 + day as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe as i64 - 719468;
    let mut local = days.checked_mul(86400)?.checked_add(hour as i64 * 3600)?.checked_add(min as i64 * 60)?.checked_add(i64::from(sec))?;
    let mut rest = &iso[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.find(|c: char| !c.is_ascii_digit()).unwrap_or(frac.len());
        if digits == 0 {
            return None;
        }
        rest = &frac[digits..];
    }
    let offset = if rest == "Z" {
        0
    } else if rest.len() == 6 && (rest.as_bytes()[0] == b'+' || rest.as_bytes()[0] == b'-') && rest.as_bytes()[3] == b':' {
        let sign: i64 = if rest.as_bytes()[0] == b'+' { 1 } else { -1 };
        let oh: i64 = rest.get(1..3)?.parse().ok()?;
        let om: i64 = rest.get(4..6)?.parse().ok()?;
        if oh > 23 || om > 59 {
            return None;
        }
        sign * (oh * 3600 + om * 60)
    } else {
        return None;
    };
    local = local.checked_sub(offset)?;
    u64::try_from(local).ok()
}

fn grok_from_event(v: &Value) -> Value {
    let Some(config) = v.pointer("/ctx/config").filter(|c| c.is_object()) else { return failure("grok-no-data") };
    let Some(pct) = config.get("creditUsagePercent").and_then(Value::as_f64).filter(|n| n.is_finite()) else {
        return failure("grok-no-data");
    };
    let resets = config
        .pointer("/currentPeriod/end")
        .filter(|v| v.is_string())
        .or_else(|| config.get("billingPeriodEnd").filter(|v| v.is_string()))
        .cloned()
        .unwrap_or(Value::Null);
    let plan = v.pointer("/ctx/subscriptionTier").filter(|p| p.is_string()).cloned().unwrap_or(Value::Null);
    let updated = v.get("ts").and_then(Value::as_str).and_then(unix_secs);
    json!({
        "five_hour": Value::Null,
        "week": { "pct": pct, "resets_at": resets },
        "plan": plan,
        "updated_at": updated.map(|secs| json!(secs)).unwrap_or(Value::Null),
    })
}

/// 由尾端往前取最新一筆帳務事件。最新一筆沒有百分比就回 grok-no-data，不用更舊的數字。
fn grok_from_text(text: &str) -> Value {
    for line in text.lines().rev() {
        if !line.contains(BILLING_MSG) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("msg").and_then(Value::as_str) != Some(BILLING_MSG) {
            continue;
        }
        return grok_from_event(&v);
    }
    failure("grok-no-data")
}

fn complete_suffix(buf: &[u8], from_start: bool) -> &[u8] {
    if from_start {
        return buf;
    }
    match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[i + 1..],
        None => &[],
    }
}

/// 從檔尾往前讀，找到帳務標記就停，最多 `max` bytes。切到一半的第一行丟掉。
fn read_tail(path: &Path, chunk: u64, max: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return Some(String::new());
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut got = 0u64;
    while got < len && got < max {
        let take = chunk.min(len - got).min(max - got);
        if take == 0 {
            break;
        }
        let start = len - got - take;
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut piece = vec![0u8; take as usize];
        file.read_exact(&mut piece).ok()?;
        piece.append(&mut buf);
        buf = piece;
        got += take;
        let body = complete_suffix(&buf, start == 0);
        if body.windows(BILLING_MSG.len()).any(|w| w == BILLING_MSG.as_bytes()) {
            break;
        }
    }
    let body = complete_suffix(&buf, got >= len);
    Some(String::from_utf8_lossy(body).into_owned())
}

fn grok_read(root: &Path) -> Value {
    if !root.is_dir() {
        return failure("grok-not-installed");
    }
    let Some(text) = read_tail(&root.join("logs").join("unified.jsonl"), GROK_CHUNK, GROK_MAX) else {
        return failure("grok-no-data");
    };
    grok_from_text(&text)
}

#[tauri::command]
pub async fn usage_grok() -> Value {
    let Some(root) = grok_root() else { return failure("grok-no-data") };
    tauri::async_runtime::spawn_blocking(move || grok_read(&root)).await.unwrap_or_else(|_| failure("grok-no-data"))
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
    fn grok_takes_newest_billing_event() {
        let older = r#"{"ts":"2026-11-02T10:00:00Z","msg":"billing: fetched credits config","ctx":{"config":{"creditUsagePercent":1.0,"currentPeriod":{"end":"2026-11-01T00:00:00Z"}},"subscriptionTier":"Free"}}"#;
        let newer = r#"{"ts":"2026-11-02T11:04:02.636Z","msg":"billing: fetched credits config","ctx":{"config":{"creditUsagePercent":6.0,"billingPeriodEnd":"2026-11-09T10:52:05+00:00"},"subscriptionTier":"SuperGrok Lite"}}"#;
        let text = format!("{older}\n{broken}\n{newer}\n", broken = "{not json billing: fetched credits config");
        let v = grok_from_text(&text);
        assert_eq!(v["week"]["pct"], 6.0);
        assert_eq!(v["week"]["resets_at"], "2026-11-09T10:52:05+00:00");
        assert_eq!(v["plan"], "SuperGrok Lite");
        assert_eq!(v["updated_at"], 1_793_617_442_u64);
        assert!(v["five_hour"].is_null());
        assert!(v.get("error").is_none());
    }

    #[test]
    fn grok_without_percent_ignores_older_snapshot() {
        let older = r#"{"ts":"2026-11-02T10:00:00Z","msg":"billing: fetched credits config","ctx":{"config":{"creditUsagePercent":40.0,"currentPeriod":{"end":"2026-11-09T00:00:00Z"}},"subscriptionTier":"SuperGrok Lite"}}"#;
        let newer = r#"{"ts":"2026-11-02T11:00:00Z","msg":"billing: fetched credits config","ctx":{"config":{"currentPeriod":{"end":"2026-11-09T00:00:00Z"}},"subscriptionTier":"Free"}}"#;
        let v = grok_from_text(&format!("{older}\n{newer}\n"));
        assert_eq!(v["error"], "grok-no-data");
        assert_eq!(grok_from_text("no billing here").get("error").and_then(Value::as_str), Some("grok-no-data"));
    }

    #[test]
    fn grok_unix_secs_handles_zulu_and_offset() {
        assert_eq!(unix_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(unix_secs("1970-01-01T08:00:00+08:00"), Some(0));
        assert_eq!(unix_secs("1970-01-01T00:00:00.5Z"), Some(0));
        assert_eq!(unix_secs("not-a-time"), None);
    }

    #[test]
    fn grok_tail_skips_a_split_first_line_and_stops_at_the_mark() {
        let dir = std::env::temp_dir().join(format!("highostty-grok-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        let path = dir.join("logs").join("unified.jsonl");
        let event = r#"{"ts":"1970-01-01T00:00:01Z","msg":"billing: fetched credits config","ctx":{"config":{"creditUsagePercent":12.5,"currentPeriod":{"end":"1970-01-08T00:00:00Z"}},"subscriptionTier":"SuperGrok"}}"#;
        let mut body = "x".repeat(500);
        body.push('\n');
        body.push_str(event);
        body.push('\n');
        std::fs::write(&path, &body).unwrap();
        let text = read_tail(&path, 40, 10_000).unwrap();
        assert!(!text.starts_with('x'), "partial first line must be dropped");
        assert_eq!(grok_from_text(&text)["week"]["pct"], 12.5);
        assert_eq!(grok_read(&dir)["plan"], "SuperGrok");
        assert_eq!(grok_read(&dir.join("missing"))["error"], "grok-not-installed");
        let _ = std::fs::remove_dir_all(&dir);
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
