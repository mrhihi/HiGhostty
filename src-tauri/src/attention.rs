//! Local socket that agent hooks (via `hg-notify`) talk to. Each line is a JSON
//! object `{surface, agent, event, payload}`; it is forwarded to the frontend as
//! an `agent` native event.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::{Path, PathBuf},
};
use tauri::Emitter;

const SCRIPT: &str = include_str!("hg-notify.sh");

pub fn script_path(dir: &Path) -> PathBuf {
    dir.join("hg-notify")
}

/// Text shown for an agent hook payload: the agent's own message if it has one.
pub fn event_from_line(line: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(line).ok()?;
    let surface = v.get("surface")?.as_str()?;
    let event = v.get("event")?.as_str()?;
    if !matches!(event, "waiting" | "done" | "resume") {
        return None;
    }
    let payload = v.get("payload").unwrap_or(&Value::Null);
    let body = ["message", "last-assistant-message", "last_assistant_message"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .unwrap_or("");
    let title = match event {
        "done" => "已完成，等你回應",
        _ => "等待輸入",
    };
    Some(json!({"type":"agent","id":surface,"event":event,"agent":v.get("agent").and_then(Value::as_str).unwrap_or(""),"title":title,"body":body}))
}

/// Install the helper script, export HIGHOSTTY_SOCKET to future terminals and
/// start listening. Failures only disable the hook channel.
pub fn start(app: tauri::AppHandle, dir: PathBuf) {
    let script = script_path(&dir);
    if std::fs::write(&script, SCRIPT).is_ok() {
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    }
    let socket = dir.join("hg.sock");
    let _ = std::fs::remove_file(&socket);
    let Ok(listener) = UnixListener::bind(&socket) else { return };
    let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));
    std::env::set_var("HIGHOSTTY_SOCKET", &socket);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                // Do not let a stuck client hold a thread forever.
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                for line in BufReader::new(stream).lines().map_while(Result::ok).take(8) {
                    if let Some(event) = event_from_line(&line) {
                        let _ = app.emit("native-event", event);
                    }
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hook_line() {
        let e = event_from_line(r#"{"surface":"s1","agent":"claude","event":"waiting","payload":{"message":"Claude needs your permission"}}"#).unwrap();
        assert_eq!(e["id"], "s1");
        assert_eq!(e["body"], "Claude needs your permission");
        assert_eq!(e["event"], "waiting");
    }
    #[test]
    fn rejects_garbage() {
        assert!(event_from_line("nope").is_none());
        assert!(event_from_line(r#"{"surface":"s","event":"x"}"#).is_none());
    }
}
