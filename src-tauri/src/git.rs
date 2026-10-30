// Git status of a pane's working directory, shown in the strip under each split. Read-only:
// GIT_OPTIONAL_LOCKS=0 keeps `status` from taking index.lock while the user is committing.
use crate::err;
use serde::Serialize;
use std::{path::Path, process::Command};

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: String,
    pub detached: bool,
    pub upstream: bool,
    pub changed: u32,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    // This worktree's root and the main work tree it was added from.
    pub root: String,
    pub main: String,
}

// Parses `git status --porcelain=v2 --branch -uno`. Header lines start with `#`; every other
// non-empty line is a changed or unmerged entry.
pub fn parse_status(text: &str) -> GitInfo {
    let mut info = GitInfo::default();
    for line in text.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            if head == "(detached)" {
                info.detached = true;
            } else {
                info.branch = head.to_string();
            }
        } else if line.starts_with("# branch.upstream ") {
            info.upstream = true;
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            let mut parts = ab.split_whitespace();
            info.ahead = parts.next().and_then(|s| s.strip_prefix('+')).and_then(|s| s.parse().ok()).unwrap_or(0);
            info.behind = parts.next().and_then(|s| s.strip_prefix('-')).and_then(|s| s.parse().ok()).unwrap_or(0);
        } else if !line.starts_with('#') && !line.is_empty() {
            info.changed += 1;
        }
    }
    info
}

// A linked worktree's git dir (.git/worktrees/<name>) differs from the shared common dir; in the
// main work tree they are the same directory. Both may be relative to `dir`. The main work tree
// is the common dir's parent (`<main>/.git`).
fn linked_worktree(dir: &Path, root: &str, git_dir: &str, common_dir: &str) -> Option<Worktree> {
    let resolve = |p: &str| dir.join(p).canonicalize().ok();
    let (git, common) = (resolve(git_dir)?, resolve(common_dir)?);
    if git == common {
        return None;
    }
    Some(Worktree { root: root.to_string(), main: common.parent()?.to_string_lossy().into_owned() })
}

fn worktree_of(path: &str) -> Option<Worktree> {
    let out = Command::new("git")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    linked_worktree(Path::new(path), lines.next()?, lines.next()?, lines.next()?)
}

// None when the directory is not inside a git work tree (git exits non-zero there).
#[tauri::command]
pub async fn git_status(path: String) -> Result<Option<GitInfo>, String> {
    if !Path::new(&path).is_dir() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("git")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .arg("-C")
            .arg(&path)
            .args(["status", "--porcelain=v2", "--branch", "-uno"])
            .output()
            .map_err(err)?;
        Ok(out.status.success().then(|| parse_status(&String::from_utf8_lossy(&out.stdout))))
    })
    .await
    .map_err(err)?
}

// Separate from `git_status` because it spawns a second git process and the tab row should not
// wait for it. Some for a linked worktree (`git worktree add`), None for the main work tree or
// outside a repo.
#[tauri::command]
pub async fn git_worktree(path: String) -> Result<Option<Worktree>, String> {
    if !Path::new(&path).is_dir() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || worktree_of(&path)).await.map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_branch_with_upstream() {
        let text = "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n";
        assert_eq!(
            parse_status(text),
            GitInfo { branch: "main".into(), detached: false, upstream: true, changed: 0, ahead: 0, behind: 0 }
        );
    }

    #[test]
    fn counts_ahead_behind_and_changes() {
        let text = "# branch.head feature/x\n# branch.upstream origin/x\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/a.ts\n1 .M N... 100644 100644 100644 a b src/b.ts\n";
        let info = parse_status(text);
        assert_eq!((info.branch.as_str(), info.ahead, info.behind, info.changed), ("feature/x", 2, 1, 2));
    }

    #[test]
    fn detached_head_without_upstream() {
        let info = parse_status("# branch.oid abc\n# branch.head (detached)\n");
        assert!(info.detached);
        assert!(info.branch.is_empty());
        assert_eq!((info.ahead, info.behind, info.changed, info.upstream), (0, 0, 0, false));
    }

    #[test]
    fn unmerged_entries_count_as_dirty() {
        assert_eq!(parse_status("# branch.head main\nu UU N... 100644 100644 100644 100644 a b c d e\n").changed, 1);
    }

    #[test]
    fn linked_worktree_has_distinct_git_and_common_dirs() {
        let root = std::env::temp_dir().join(format!("hg-wt-{}", std::process::id()));
        let main = root.join("main");
        std::fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        let wt = root.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        let canon = |p: &Path| p.canonicalize().unwrap().to_string_lossy().into_owned();
        assert_eq!(linked_worktree(&main, "/x/main", ".git", ".git"), None);
        let found = linked_worktree(&wt, "/x/wt", main.join(".git/worktrees/wt").to_str().unwrap(), main.join(".git").to_str().unwrap());
        assert_eq!(found, Some(Worktree { root: "/x/wt".into(), main: canon(&main) }));
        assert_eq!(linked_worktree(&main, "/x/main", "missing", "missing"), None);
        std::fs::remove_dir_all(&root).ok();
    }
}
