//! Agent control socket. A program inside a terminal runs `highostty ctl <words…>`
//! (this same binary, see `cli`), which sends its argv over a Unix socket. The
//! server forwards the request to every window as a `control-request` event. Each
//! window parses it (src/control.ts) and answers through `control_reply` with a
//! claim: "owner" (this is mine, here is the reply), "part" (one window's share of
//! a cross-window listing) or "none" (not involved).
//!
//! The socket is reachable only by the same user (0600 plus a `getpeereid` check).
//! There is no token: the mode setting (off / readonly / full) is what limits
//! what a caller may do, and a token would have to sit in tmux's command line.
use serde_json::{json, Value};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    io::{BufRead, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        },
    },
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

/// sun_path is 104 bytes on macOS; leave room for the terminator.
const MAX_SOCKET_PATH: usize = 100;
// Room for a 256 KiB stdin document even when JSON escaping inflates it.
const MAX_REQUEST_BYTES: u64 = 2 << 20;
const MAX_INPUT_BYTES: usize = 256 * 1024;
const DEFAULT_WAIT_MS: u64 = 30_000;
const MAX_WAIT_MS: u64 = 600_000;
/// Added to the command's timeout (`--timeout`, default 30 s) so a window's own timeout reply arrives first.
const WAIT_MARGIN_MS: u64 = 5_000;
/// Once one window has contributed to a listing, the others get this long to follow
/// (a window that is still loading has no listener and would never answer).
const PART_GRACE_MS: u64 = 1_500;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Off,
    Readonly,
    Full,
}
impl Mode {
    pub fn parse(text: &str) -> Option<Mode> {
        match text {
            "off" => Some(Mode::Off),
            "readonly" => Some(Mode::Readonly),
            "full" => Some(Mode::Full),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Readonly => "readonly",
            Mode::Full => "full",
        }
    }
}

struct Server {
    stop: Arc<AtomicBool>,
    path: PathBuf,
    thread: std::thread::JoinHandle<()>,
}
static MODE: Mutex<Mode> = Mutex::new(Mode::Readonly);
static SERVER: Mutex<Option<Server>> = Mutex::new(None);
/// One window's answer: (window label, claim, reply).
type Answer = (String, String, Value);
static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<Answer>>>> = OnceLock::new();
fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<Answer>>> {
    PENDING.get_or_init(Default::default)
}
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn settings_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(super::data_dir(app)?.join("control.json"))
}
fn read_mode(app: &tauri::AppHandle) -> Mode {
    settings_file(app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("mode").and_then(Value::as_str).and_then(Mode::parse))
        .unwrap_or(Mode::Readonly)
}

/// Where the socket lives. The data directory normally; a short per-user path in the
/// temp dir when that would not fit in sun_path (a long HIGHOSTTY_DATA_DIR).
pub fn socket_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = super::data_dir(app)?;
    let path = dir.join("ctl.sock");
    if path.as_os_str().len() <= MAX_SOCKET_PATH {
        return Ok(path);
    }
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let uid = unsafe { libc::geteuid() };
    let short = std::env::temp_dir().join(format!("highostty-{uid}-{:08x}", hasher.finish() as u32));
    std::fs::create_dir_all(&short).map_err(super::err)?;
    std::fs::set_permissions(&short, std::fs::Permissions::from_mode(0o700)).map_err(super::err)?;
    Ok(short.join("ctl.sock"))
}

/// Environment for a new terminal surface. Always set, even when the mode is off, so
/// switching the mode on later also works in terminals that are already open.
pub fn surface_env(app: &tauri::AppHandle, surface_id: &str) -> Result<Value, String> {
    let mut env = base_env(app)?;
    env["HIGHOSTTY_SURFACE_ID"] = Value::String(surface_id.to_owned());
    Ok(env)
}
fn base_env(app: &tauri::AppHandle) -> Result<Value, String> {
    let cli = std::env::current_exe().map_err(super::err)?;
    Ok(json!({
        "HIGHOSTTY_ENV": "1",
        "HIGHOSTTY_SOCKET": socket_path(app)?.to_string_lossy(),
        "HIGHOSTTY_CLI": cli.to_string_lossy(),
    }))
}
/// tmux panes do not inherit the client's environment; `new-session -e` (tmux 3.2+) is the only way in.
pub fn tmux_env(app: &tauri::AppHandle, session: &str) -> Result<HashMap<String, String>, String> {
    let mut env = HashMap::new();
    if let Value::Object(map) = base_env(app)? {
        for (key, value) in map {
            if let Value::String(value) = value {
                env.insert(key, value);
            }
        }
    }
    env.insert("HIGHOSTTY_TMUX_SESSION".into(), session.to_owned());
    Ok(env)
}
/// "tmux 3.8", "tmux 3.3a", "tmux next-3.5"; anything we cannot read counts as too old.
pub fn tmux_supports_env(version: &str) -> bool {
    let text = version.trim().strip_prefix("tmux").unwrap_or(version).trim();
    let text = text.trim_start_matches(|c: char| !c.is_ascii_digit());
    let mut parts = text.splitn(2, '.');
    let number = |part: Option<&str>| {
        part.map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>())
            .and_then(|digits| digits.parse::<u32>().ok())
    };
    match (number(parts.next()), number(parts.next())) {
        (Some(major), Some(minor)) => (major, minor) >= (3, 2),
        (Some(major), None) => major > 3,
        _ => false,
    }
}

/// tmux added `extended-keys-format` in 3.5; older versions keep their default xterm format.
pub fn tmux_supports_csi_u(version: &str) -> bool {
    let text = version.trim().strip_prefix("tmux").unwrap_or(version).trim();
    let text = text.trim_start_matches(|c: char| !c.is_ascii_digit());
    let mut parts = text.splitn(2, '.');
    let number = |part: Option<&str>| {
        part.map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>())
            .and_then(|digits| digits.parse::<u32>().ok())
    };
    match (number(parts.next()), number(parts.next())) {
        (Some(major), Some(minor)) => (major, minor) >= (3, 5),
        (Some(major), None) => major > 3,
        _ => false,
    }
}

/// Read the saved mode and start the server accordingly; called once at startup.
pub fn init(app: &tauri::AppHandle) {
    let mode = read_mode(app);
    if let Err(error) = apply_mode(app, mode) {
        eprintln!("agent 控制指令無法啟動：{error}");
    }
}
/// Close the socket when the app exits.
pub fn shutdown() {
    stop();
}
pub fn current_mode() -> Mode {
    *lock(&MODE)
}
pub fn apply_mode(app: &tauri::AppHandle, mode: Mode) -> Result<(), String> {
    *lock(&MODE) = mode;
    stop();
    if mode != Mode::Off {
        start(app)?;
    }
    Ok(())
}
pub fn save_mode(app: &tauri::AppHandle, mode: Mode) -> Result<(), String> {
    std::fs::write(settings_file(app)?, json!({ "mode": mode.as_str() }).to_string()).map_err(super::err)
}
fn stop() {
    let Some(server) = lock(&SERVER).take() else { return };
    server.stop.store(true, Ordering::SeqCst);
    // Wake the blocked accept so the thread sees the flag and removes the socket. Wait for it:
    // otherwise start() right after would connect to the dying socket and report another
    // instance, and the old thread would then delete the socket. Without a successful wake the
    // thread may stay blocked in accept, so only join when the wake went through.
    if UnixStream::connect(&server.path).is_ok() {
        let _ = server.thread.join();
    }
}
fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let path = socket_path(app)?;
    if UnixStream::connect(&path).is_ok() {
        return Err("另一個 HiGhostty 正在使用控制 socket".into());
    }
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).map_err(super::err)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(super::err)?;
    let stop = Arc::new(AtomicBool::new(false));
    let app = app.clone();
    let flag = stop.clone();
    let socket = path.clone();
    let thread = std::thread::spawn(move || {
        for stream in listener.incoming() {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            std::thread::spawn(move || {
                // A panic in one connection must not take the app down.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| serve(&app, stream)));
            });
        }
        let _ = std::fs::remove_file(&socket);
    });
    *lock(&SERVER) = Some(Server { stop, path, thread });
    Ok(())
}

fn failure(code: &str, message: &str) -> Value {
    json!({ "ok": false, "error": { "code": code, "message": message } })
}
fn same_user(stream: &UnixStream) -> bool {
    let (mut uid, mut gid) = (0, 0);
    unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0 && uid == libc::geteuid() }
}
fn wait_ms(request: &Value) -> u64 {
    request
        .get("timeout_ms")
        .and_then(Value::as_f64)
        .filter(|ms| ms.is_finite() && *ms > 0.0)
        .map(|ms| (ms as u64).min(MAX_WAIT_MS))
        .unwrap_or(DEFAULT_WAIT_MS)
        + WAIT_MARGIN_MS
}
/// Combine per-window parts into `{windows: [{window, …fields}]}` (the window the caller is in
/// is not special here). Windows are ordered "main" first, then by label. When no part
/// succeeded the first error is returned instead.
fn merge_parts(mut parts: Vec<(String, Value)>) -> Value {
    parts.sort_by(|a, b| (a.0 != "main", &a.0).cmp(&(b.0 != "main", &b.0)));
    let mut windows = Vec::new();
    let mut first_error = None;
    for (label, reply) in parts {
        if reply.get("ok").and_then(Value::as_bool) != Some(true) {
            first_error.get_or_insert(reply);
            continue;
        }
        let mut entry = json!({ "window": label });
        match reply.get("result") {
            Some(Value::Object(fields)) => entry.as_object_mut().unwrap().extend(fields.clone()),
            Some(other) => entry["result"] = other.clone(),
            None => {}
        }
        windows.push(entry);
    }
    match (windows.is_empty(), first_error) {
        (true, Some(error)) => error,
        _ => json!({ "ok": true, "result": { "windows": windows } }),
    }
}
fn handle(app: &tauri::AppHandle, request: &Value) -> Value {
    let mode = current_mode();
    if mode == Mode::Off {
        return failure("disabled", "agent 控制指令已關閉；請在 HiGhostty 設定開啟");
    }
    let argv_ok = request
        .get("argv")
        .and_then(Value::as_array)
        .is_some_and(|argv| argv.len() <= 256 && argv.iter().all(Value::is_string));
    if !argv_ok {
        return failure("bad_args", "argv 必須是字串陣列");
    }
    let input = request.get("input").cloned().unwrap_or(Value::Null);
    if !input.is_null() && input.as_str().map_or(true, |text| text.len() > MAX_INPUT_BYTES) {
        return failure("bad_args", "input 必須是字串，且不超過 256 KiB");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    lock(pending()).insert(id.clone(), tx);
    // Every terminal window answers once, so their number says when we have heard from all.
    // Standalone preview windows have no control handler and are not counted.
    let expected = app
        .webview_windows()
        .keys()
        .filter(|label| !super::preview::is_preview_window(label))
        .count();
    let sent = app.emit(
        "control-request",
        json!({ "reqId": id, "mode": mode.as_str(), "caller": request.get("caller").cloned().unwrap_or(Value::Null), "argv": request["argv"], "input": input }),
    );
    let reply = match sent {
        Ok(()) => collect(&rx, expected, Duration::from_millis(wait_ms(request))),
        Err(error) => failure("failed", &error.to_string()),
    };
    lock(pending()).remove(&id);
    reply
}
/// Wait for the windows' answers: an owner decides at once; parts are gathered and merged;
/// if every window says "none" the target does not exist.
fn collect(rx: &mpsc::Receiver<Answer>, expected: usize, limit: Duration) -> Value {
    let start = std::time::Instant::now();
    let mut parts = Vec::new();
    let mut seen = 0;
    let mut grace: Option<std::time::Instant> = None;
    while seen < expected {
        let mut deadline = start + limit;
        if let Some(grace) = grace {
            deadline = deadline.min(grace);
        }
        let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) else { break };
        let Ok((window, claim, reply)) = rx.recv_timeout(left) else { break };
        seen += 1;
        match claim.as_str() {
            "owner" => return reply,
            "part" => {
                parts.push((window, reply));
                grace.get_or_insert(std::time::Instant::now() + Duration::from_millis(PART_GRACE_MS));
            }
            _ => {}
        }
    }
    if !parts.is_empty() {
        return merge_parts(parts);
    }
    if seen >= expected {
        failure("not_found", "找不到呼叫者或指定的終端機（頁籤可能已關閉）")
    } else {
        failure("timeout", "沒有視窗回應，指令逾時")
    }
}
fn serve(app: &tauri::AppHandle, stream: UnixStream) {
    if !same_user(&stream) {
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    let read = std::io::BufReader::new((&stream).take(MAX_REQUEST_BYTES)).read_line(&mut line);
    let reply = match (read, serde_json::from_str::<Value>(&line)) {
        (Ok(n), Ok(request)) if n > 0 => handle(app, &request),
        _ => failure("bad_args", "請求不是單行 JSON"),
    };
    let mut out = reply.to_string();
    out.push('\n');
    let _ = (&stream).write_all(out.as_bytes());
}

/// A window answers a `control-request` (see `collect` for what the claim means).
#[tauri::command]
pub fn control_reply(req_id: String, window: String, claim: String, reply: Value) {
    if let Some(tx) = lock(pending()).get(&req_id) {
        let _ = tx.send((window, claim, reply));
    }
}
/// The skill that teaches an agent these commands. It is installed only when the user asks
/// (settings page); the marker tells our own copy apart from a file somebody wrote by hand.
const SKILL: &str = include_str!("../../skills/highostty/SKILL.md");
const SKILL_MARKER: &str = "<!-- managed by HiGhostty";
/// Agents that load SKILL.md from a per-user folder: (id, label, folder under $HOME).
const SKILL_TARGETS: &[(&str, &str, &str)] = &[
    ("claude", "Claude Code", ".claude/skills"),
    ("codex", "Codex", ".codex/skills"),
    ("copilot", "GitHub Copilot", ".copilot/skills"),
    ("gemini", "Gemini CLI", ".gemini/skills"),
];
fn skill_path(target: &str) -> Result<PathBuf, String> {
    let (_, _, dir) = SKILL_TARGETS
        .iter()
        .find(|(id, _, _)| *id == target)
        .ok_or_else(|| format!("未知的 agent：{target}"))?;
    Ok(super::user_home()?.join(dir).join("highostty/SKILL.md"))
}
/// missing | current | outdated (ours, older) | foreign (not ours: never overwritten)
fn skill_state(existing: Option<&str>, bundled: &str) -> &'static str {
    match existing {
        None => "missing",
        Some(text) if text == bundled => "current",
        Some(text) if text.contains(SKILL_MARKER) => "outdated",
        Some(_) => "foreign",
    }
}
fn read_existing(path: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(super::err(e)),
    }
}
/// One entry per supported agent: id, label, path and state.
#[tauri::command]
pub fn skill_status() -> Result<Value, String> {
    let mut rows = Vec::new();
    for (id, label, _) in SKILL_TARGETS {
        let path = skill_path(id)?;
        let state = skill_state(read_existing(&path)?.as_deref(), SKILL);
        rows.push(json!({ "id": id, "label": label, "path": path.to_string_lossy(), "state": state }));
    }
    Ok(Value::Array(rows))
}
/// Write the skill into the agent's skills folder; returns the path.
#[tauri::command]
pub fn skill_install(target: String) -> Result<String, String> {
    let path = skill_path(&target)?;
    let existing = std::fs::read_to_string(&path).ok();
    if skill_state(existing.as_deref(), SKILL) == "foreign" {
        return Err(format!("{} 已存在且不是 HiGhostty 安裝的，不覆蓋；請自行處理或改用「複製 skill 內容」", path.display()));
    }
    std::fs::create_dir_all(path.parent().ok_or("無效的路徑")?).map_err(super::err)?;
    std::fs::write(&path, SKILL).map_err(super::err)?;
    Ok(path.to_string_lossy().into_owned())
}
/// Delete our copy of the skill (and its folder when that leaves it empty). A file that is not
/// ours is never touched; an already missing one is fine.
fn uninstall_at(path: &std::path::Path) -> Result<(), String> {
    let existing = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(super::err(e)),
    };
    match skill_state(existing.as_deref(), SKILL) {
        "missing" => return Ok(()),
        "foreign" => {
            return Err(format!("{} 不是 HiGhostty 安裝的，不刪除；請自行處理", path.display()));
        }
        _ => {}
    }
    std::fs::remove_file(path).map_err(super::err)?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir(dir); // only succeeds when empty
    }
    Ok(())
}
/// Remove the skill installed by `skill_install`.
#[tauri::command]
pub fn skill_uninstall(target: String) -> Result<(), String> {
    uninstall_at(&skill_path(&target)?)
}
/// The skill text, for agents that keep instructions somewhere else.
#[tauri::command]
pub fn skill_text() -> &'static str {
    SKILL
}
/// Paths for `files reveal` / `files quicklook`: `~` and relative paths (against `base`) are
/// expanded, and every path must exist (a dangling symlink counts).
#[tauri::command]
pub fn control_resolve_files(paths: Vec<String>, base: Option<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("需要至少一個路徑".into());
    }
    if paths.len() > 50 {
        return Err("一次最多 50 個路徑".into());
    }
    paths
        .iter()
        .map(|path| {
            let resolved = super::expand_path(path, base.as_deref())?;
            std::fs::symlink_metadata(&resolved).map_err(|_| format!("找不到：{path}"))?;
            Ok(resolved.to_string_lossy().into_owned())
        })
        .collect()
}
#[tauri::command]
pub fn control_mode() -> String {
    current_mode().as_str().into()
}
#[tauri::command]
pub fn set_control_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let mode = Mode::parse(&mode).ok_or("無效的模式")?;
    save_mode(&app, mode)?;
    apply_mode(&app, mode)
}

/// The `--timeout <ms>` / `--timeout=<ms>` flag, which bounds how long we wait. Anything after
/// `--` is a command line for the caller's own use and is not looked at.
fn timeout_arg(args: &[String]) -> Option<f64> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--" {
            return None;
        }
        if arg == "--timeout" {
            return iter.next().and_then(|value| value.parse().ok());
        }
        if let Some(value) = arg.strip_prefix("--timeout=") {
            return value.parse().ok();
        }
    }
    None
}

/// `--json-stdin` before any `--`: the command takes a JSON document on stdin.
fn wants_stdin(args: &[String]) -> bool {
    args.iter().take_while(|arg| *arg != "--").any(|arg| arg == "--json-stdin")
}
/// At most MAX_INPUT_BYTES of valid UTF-8 from `reader`.
fn read_input(reader: impl std::io::Read) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader.take(MAX_INPUT_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| format!("讀取 stdin 失敗：{e}"))?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("stdin 超過 256 KiB".into());
    }
    String::from_utf8(bytes).map_err(|_| "stdin 不是 UTF-8".into())
}

/// `highostty ctl <words…>`: send argv to the running app, print its reply, exit.
/// Exit codes: 0 ok, 1 the command failed, 2 the app could not be reached.
pub fn cli(args: Vec<String>) -> i32 {
    let print = |value: Value| println!("{value}");
    let Some(socket) = std::env::var_os("HIGHOSTTY_SOCKET") else {
        print(failure("unavailable", "不在 HiGhostty 的終端機裡（沒有 HIGHOSTTY_SOCKET）"));
        return 2;
    };
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty()).map(Value::String).unwrap_or(Value::Null);
    let timeout_ms = timeout_arg(&args);
    let input = if wants_stdin(&args) {
        match read_input(std::io::stdin()) {
            Ok(text) => Value::String(text),
            Err(message) => {
                print(failure("bad_args", &message));
                return 1;
            }
        }
    } else {
        Value::Null
    };
    let request = json!({
        "input": input,
        "caller": { "surface": env("HIGHOSTTY_SURFACE_ID"), "tmuxSession": env("HIGHOSTTY_TMUX_SESSION") },
        "argv": args,
        "timeout_ms": timeout_ms,
    });
    let unreachable = |message: String| {
        print(failure("unavailable", &format!("連不上 HiGhostty（可能已關閉，或「agent 控制指令」設為關閉）：{message}")));
        2
    };
    let mut stream = match UnixStream::connect(&socket) {
        Ok(stream) => stream,
        Err(error) => return unreachable(error.to_string()),
    };
    let wait = timeout_ms.map(|ms| ms.max(0.0) as u64).unwrap_or(0).min(MAX_WAIT_MS) + DEFAULT_WAIT_MS + WAIT_MARGIN_MS;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(wait)));
    if let Err(error) = stream.write_all(format!("{request}\n").as_bytes()) {
        return unreachable(error.to_string());
    }
    let mut reply = String::new();
    if let Err(error) = std::io::BufReader::new(&stream).read_line(&mut reply) {
        return unreachable(error.to_string());
    }
    match serde_json::from_str::<Value>(&reply) {
        Ok(value) => {
            let ok = value.get("ok").and_then(Value::as_bool) == Some(true);
            print(value);
            if ok { 0 } else { 1 }
        }
        Err(_) => unreachable("回應格式錯誤".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_paths_expand_and_must_exist() {
        let dir = std::env::temp_dir().join(format!("hg-ctl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a b.txt"), "x").unwrap();
        let base = Some(dir.to_string_lossy().into_owned());
        let ok = control_resolve_files(vec!["a b.txt".into(), dir.to_string_lossy().into_owned()], base.clone()).unwrap();
        assert_eq!(ok[0], dir.join("a b.txt").to_string_lossy());
        assert_eq!(ok[1], dir.to_string_lossy());
        assert!(control_resolve_files(vec!["nope.txt".into()], base.clone()).unwrap_err().contains("nope.txt"));
        assert!(control_resolve_files(vec![], base.clone()).is_err());
        assert!(control_resolve_files(vec!["x".into(); 51], base).is_err());
        assert!(control_resolve_files(vec!["~other".into()], None).is_err());
        std::fs::remove_dir_all(dir).ok();
    }
    #[test]
    fn every_target_has_its_own_skill_folder() {
        let paths: Vec<_> = SKILL_TARGETS.iter().map(|(id, _, _)| skill_path(id).unwrap()).collect();
        for (i, a) in paths.iter().enumerate() {
            assert!(a.ends_with("highostty/SKILL.md"));
            assert!(paths.iter().skip(i + 1).all(|b| a != b));
        }
        assert!(skill_path("nope").is_err());
    }

    #[test]
    fn uninstall_removes_only_our_copy() {
        let dir = std::env::temp_dir().join(format!("hg-skill-{}", std::process::id()));
        let folder = dir.join("highostty");
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("SKILL.md");
        std::fs::write(&file, "my own notes").unwrap();
        assert!(uninstall_at(&file).is_err());
        assert!(file.exists());
        std::fs::write(&file, format!("{SKILL}\nold")).unwrap();
        uninstall_at(&file).unwrap();
        assert!(!file.exists() && !folder.exists());
        uninstall_at(&file).unwrap(); // already gone
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_bundled_skill_is_ours_and_states_are_told_apart() {
        assert!(SKILL.starts_with("---\nname: highostty\n"));
        assert!(SKILL.contains(SKILL_MARKER));
        assert_eq!(skill_state(None, SKILL), "missing");
        assert_eq!(skill_state(Some(SKILL), SKILL), "current");
        assert_eq!(skill_state(Some(&format!("{SKILL}\nold")), SKILL), "outdated");
        assert_eq!(skill_state(Some("my own notes"), SKILL), "foreign");
    }
    #[test]
    fn modes_round_trip() {
        for mode in [Mode::Off, Mode::Readonly, Mode::Full] {
            assert_eq!(Mode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(Mode::parse("admin"), None);
    }
    #[test]
    fn tmux_env_support_needs_3_2() {
        assert!(tmux_supports_env("tmux 3.8"));
        assert!(tmux_supports_env("tmux 3.2"));
        assert!(tmux_supports_env("tmux 3.3a"));
        assert!(tmux_supports_env("tmux next-3.5"));
        assert!(tmux_supports_env("tmux 4.0"));
        assert!(!tmux_supports_env("tmux 3.1c"));
        assert!(!tmux_supports_env("tmux 2.9"));
        assert!(!tmux_supports_env("tmux master"));
        assert!(!tmux_supports_env(""));
    }
    #[test]
    fn tmux_csi_u_support_needs_3_5() {
        assert!(tmux_supports_csi_u("tmux 3.8"));
        assert!(tmux_supports_csi_u("tmux 3.5a"));
        assert!(tmux_supports_csi_u("tmux next-3.5"));
        assert!(tmux_supports_csi_u("tmux 4.0"));
        assert!(!tmux_supports_csi_u("tmux 3.4"));
        assert!(!tmux_supports_csi_u("tmux 2.9"));
        assert!(!tmux_supports_csi_u("tmux master"));
        assert!(!tmux_supports_csi_u(""));
    }
    #[test]
    fn timeout_flag_is_read_until_double_dash() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(timeout_arg(&args(&["ping", "--timeout", "250"])), Some(250.0));
        assert_eq!(timeout_arg(&args(&["ping", "--timeout=90"])), Some(90.0));
        assert_eq!(timeout_arg(&args(&["ping", "--timeout", "soon"])), None);
        assert_eq!(timeout_arg(&args(&["surface", "run", "x", "--", "sleep", "--timeout", "5"])), None);
        assert_eq!(timeout_arg(&args(&["ping"])), None);
    }
    #[test]
    fn stdin_is_read_only_when_asked_and_is_bounded() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(wants_stdin(&args(&["agent", "prompt", "p", "--json-stdin"])));
        assert!(!wants_stdin(&args(&["surface", "run", "x", "--", "cat", "--json-stdin"])));
        assert!(!wants_stdin(&args(&["ping"])));
        assert_eq!(read_input("{\"a\":1}".as_bytes()).unwrap(), "{\"a\":1}");
        assert!(read_input(vec![b'x'; MAX_INPUT_BYTES + 1].as_slice()).is_err());
        assert_eq!(read_input(vec![b'x'; MAX_INPUT_BYTES].as_slice()).unwrap().len(), MAX_INPUT_BYTES);
        assert!(read_input([0xff, 0xfe].as_slice()).is_err());
    }
    #[test]
    fn wait_follows_the_callers_timeout() {
        assert_eq!(wait_ms(&json!({})), DEFAULT_WAIT_MS + WAIT_MARGIN_MS);
        assert_eq!(wait_ms(&json!({ "timeout_ms": 120000 })), 125_000);
        assert_eq!(wait_ms(&json!({ "timeout_ms": 1e12 })), MAX_WAIT_MS + WAIT_MARGIN_MS);
        assert_eq!(wait_ms(&json!({ "timeout_ms": -5 })), DEFAULT_WAIT_MS + WAIT_MARGIN_MS);
    }
    fn answer(window: &str, claim: &str, reply: Value) -> Answer {
        (window.into(), claim.into(), reply)
    }
    fn gather(answers: Vec<Answer>, expected: usize, limit_ms: u64) -> Value {
        let (tx, rx) = mpsc::channel();
        for item in answers {
            tx.send(item).unwrap();
        }
        collect(&rx, expected, Duration::from_millis(limit_ms))
    }
    #[test]
    fn an_owner_answers_at_once_even_before_other_windows() {
        let reply = json!({ "ok": true, "result": 1 });
        let got = gather(vec![answer("a", "none", Value::Null), answer("b", "owner", reply.clone())], 3, 200);
        assert_eq!(got, reply);
    }
    #[test]
    fn nobody_claiming_it_is_not_found() {
        let got = gather(vec![answer("a", "none", Value::Null), answer("b", "none", Value::Null)], 2, 200);
        assert_eq!(got["error"]["code"], "not_found");
        assert_eq!(gather(vec![], 2, 50)["error"]["code"], "timeout");
    }
    #[test]
    fn parts_are_merged_main_first_and_late_windows_do_not_block() {
        let part = |n: i64| json!({ "ok": true, "result": { "tabs": n } });
        let got = gather(vec![answer("window-9", "part", part(2)), answer("main", "part", part(1))], 3, 3000);
        assert_eq!(got["ok"], true);
        let windows = got["result"]["windows"].as_array().unwrap();
        assert_eq!(windows[0], json!({ "window": "main", "tabs": 1 }));
        assert_eq!(windows[1], json!({ "window": "window-9", "tabs": 2 }));
    }
    #[test]
    fn failed_parts_are_dropped_unless_all_failed() {
        let ok = json!({ "ok": true, "result": { "n": 1 } });
        let bad = failure("failed", "x");
        let mixed = merge_parts(vec![("main".into(), bad.clone()), ("w".into(), ok)]);
        assert_eq!(mixed["result"]["windows"].as_array().unwrap().len(), 1);
        assert_eq!(merge_parts(vec![("main".into(), bad.clone())]), bad);
    }
}
