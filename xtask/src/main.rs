//! HiGhostty 專案工作：`cargo xtask <command>`。
//!
//! 版本號只存在 package.json（tauri.conf.json 指向它）、src-tauri/Cargo.toml 與兩個 lock 檔。

use std::env;
use std::fmt;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

type Result<T = ()> = std::result::Result<T, String>;

const REPO_URL: &str = "https://github.com/mrhihi/HiGhostty.git";
const REPO_SLUG: &str = "mrhihi/HiGhostty";
const BRANCH: &str = "main";
const APP_NAME: &str = "HiGhostty";
const DEFAULT_TARGET_DIR: &str = "/private/tmp/highostty-target";
const VERSION_FILES: [&str; 4] = [
    "package.json",
    "package-lock.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
];

const USAGE: &str = "\
用法：cargo xtask <command> [options]

  build    [--debug]                          建置 HiGhostty.app
  publish  [--debug] [--skip-build]           打包成 dmg
           [--install | --no-install]         是否複製到 ~/Applications（未指定則詢問）
  clean    [--all]                            清除建置產出與中間產物（--all 連 vendor、node_modules 一併清）
  push     [-m <訊息>]                        推送到 GitHub；帶 -m 會先 commit 所有變更
  version                                     顯示目前與建議的下個版本
  release  <X.Y.Z|patch|minor|major>          升版 → 建置 → dmg → commit → push → tag → GitHub Release
           [--install] [-y | --yes]

Cargo 輸出目錄預設為 /private/tmp/highostty-target，可用 CARGO_TARGET_DIR 覆寫。";

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match dispatch(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("\n✗ {err}");
            ExitCode::FAILURE
        }
    }
}

fn dispatch(args: &[String]) -> Result {
    let (cmd, rest) = match args.split_first() {
        Some((cmd, rest)) => (cmd.as_str(), rest),
        None => {
            println!("{USAGE}");
            return Ok(());
        }
    };
    let mut opts = Opts::parse(rest)?;
    // 先取出所有參數並拒絕多餘的，再開始執行，避免跑完才發現打錯。
    match cmd {
        "build" => {
            let debug = opts.flag("--debug");
            opts.finish()?;
            build(debug).map(|_| ())
        }
        "publish" => {
            let debug = opts.flag("--debug");
            let skip_build = opts.flag("--skip-build");
            let install = match (opts.flag("--install"), opts.flag("--no-install")) {
                (true, true) => return Err("--install 與 --no-install 只能擇一".into()),
                (true, false) => Some(true),
                (false, true) => Some(false),
                (false, false) => None,
            };
            opts.finish()?;
            publish(debug, skip_build, install).map(|_| ())
        }
        "clean" => {
            let all = opts.flag("--all");
            opts.finish()?;
            clean(all)
        }
        "push" => {
            let message = opts.value("-m")?;
            opts.finish()?;
            push(message)
        }
        "version" => {
            opts.finish()?;
            version()
        }
        "release" => {
            let install = opts.flag("--install");
            let yes = opts.flag("-y") || opts.flag("--yes");
            let spec = opts
                .positional()
                .ok_or("請指定版本：cargo xtask release <X.Y.Z|patch|minor|major>")?;
            opts.finish()?;
            release(&spec, install, yes)
        }
        "help" | "-h" | "--help" => {
            println!("{USAGE}");
            Ok(())
        }
        other => Err(format!("未知的指令 `{other}`\n\n{USAGE}")),
    }
}

// ---------------------------------------------------------------- build

fn build(debug: bool) -> Result<PathBuf> {
    let root = root();
    if !root.join("src-tauri/vendor/libghostty.a").exists() {
        return Err("找不到 src-tauri/vendor/libghostty.a，請先執行 `npm run native:bootstrap`".into());
    }
    // 外接碟上的 AppleDouble 檔會被 Tauri 當成 capability 讀取而失敗。
    remove_apple_double(&root.join("src-tauri/capabilities"))?;

    let mut cmd = Command::new("npm");
    cmd.args(["run", "tauri", "--", "build", "--bundles", "app"]);
    if debug {
        cmd.arg("--debug");
    }
    run(cmd.current_dir(&root).env("CARGO_TARGET_DIR", target_dir()))?;

    let app = app_path(debug);
    if !app.exists() {
        return Err(format!("建置完成但找不到 {}", app.display()));
    }
    println!("✓ {}", app.display());
    Ok(app)
}

fn app_path(debug: bool) -> PathBuf {
    target_dir()
        .join(profile(debug))
        .join("bundle/macos")
        .join(format!("{APP_NAME}.app"))
}

fn remove_apple_double(dir: &Path) -> Result {
    let Ok(entries) = fs::read_dir(dir) else { return Ok(()) };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with("._") {
            fs::remove_file(entry.path()).map_err(|e| format!("無法刪除 {}：{e}", entry.path().display()))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- clean

/// 預設清 Cargo 輸出目錄（app、dmg、中間產物）與前端輸出；`--all` 另清需重新下載／編譯的
/// `src-tauri/vendor`（要再跑 `npm run native:bootstrap`）、`node_modules` 與 xtask 自己的 target。
fn clean(all: bool) -> Result {
    let root = root();
    let mut targets = vec![
        target_dir(),
        root.join("dist"),
        root.join("src-tauri/target"),
        root.join("src-tauri/gen"),
    ];
    if all {
        targets.extend([
            root.join("src-tauri/vendor"),
            root.join("node_modules"),
            root.join("xtask/target"),
        ]);
    }
    let mut removed = 0;
    for path in targets {
        if !is_removable(&path, &root) {
            return Err(format!("拒絕刪除 {}（路徑不安全）", path.display()));
        }
        if fs::symlink_metadata(&path).is_err() {
            continue;
        }
        let result = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        result.map_err(|e| format!("無法刪除 {}：{e}", path.display()))?;
        println!("✓ 已刪除 {}", path.display());
        removed += 1;
    }
    if removed == 0 {
        println!("沒有需要清除的項目");
    }
    Ok(())
}

/// `CARGO_TARGET_DIR` 可被覆寫，避免誤設成根目錄、家目錄或專案本身而整個刪掉。
fn is_removable(path: &Path, root: &Path) -> bool {
    let home = env::var_os("HOME").map(PathBuf::from);
    path.is_absolute()
        && path.components().count() > 2
        && path != root
        && !root.starts_with(path)
        && home.as_deref() != Some(path)
}

// ---------------------------------------------------------------- publish

fn publish(debug: bool, skip_build: bool, install: Option<bool>) -> Result<PathBuf> {
    let app = if skip_build {
        let app = app_path(debug);
        if !app.exists() {
            return Err(format!("找不到 {}，請拿掉 --skip-build", app.display()));
        }
        app
    } else {
        build(debug)?
    };

    let dmg = make_dmg(&app, debug)?;
    println!("✓ {}", dmg.display());

    let install = match install {
        Some(answer) => answer,
        None => confirm("要複製到 ~/Applications 嗎？", false)?,
    };
    if install {
        install_app(&app)?;
    }
    Ok(dmg)
}

fn make_dmg(app: &Path, debug: bool) -> Result<PathBuf> {
    let version = current_version()?;
    let out_dir = target_dir().join(profile(debug)).join("bundle/dmg");
    let staging = target_dir().join(profile(debug)).join("dmg-staging");
    let dmg = out_dir.join(format!("{APP_NAME}_{version}_{}.dmg", arch()));

    let _ = fs::remove_dir_all(&staging);
    create_dir(&staging)?;
    create_dir(&out_dir)?;
    run(Command::new("ditto").arg(app).arg(staging.join(format!("{APP_NAME}.app"))))?;
    std::os::unix::fs::symlink("/Applications", staging.join("Applications"))
        .map_err(|e| format!("無法建立 Applications 捷徑：{e}"))?;
    run(Command::new("hdiutil")
        .args(["create", "-quiet", "-ov", "-fs", "HFS+", "-format", "UDZO", "-volname"])
        .arg(format!("{APP_NAME} {version}"))
        .arg("-srcfolder")
        .arg(&staging)
        .arg(&dmg))?;
    let _ = fs::remove_dir_all(&staging);
    Ok(dmg)
}

fn install_app(app: &Path) -> Result {
    let home = env::var("HOME").map_err(|_| "找不到 HOME")?;
    let apps = Path::new(&home).join("Applications");
    let dest = apps.join(format!("{APP_NAME}.app"));
    create_dir(&apps)?;
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| format!("無法移除舊版 {}：{e}", dest.display()))?;
    }
    run(Command::new("ditto").arg(app).arg(&dest))?;
    println!("✓ 已安裝到 {}", dest.display());
    Ok(())
}

// ---------------------------------------------------------------- push

fn push(message: Option<String>) -> Result {
    ensure_repo()?;
    if let Some(message) = message {
        git(&["add", "-A"])?;
        if git_ok(&["diff", "--cached", "--quiet"]) {
            println!("沒有需要 commit 的變更");
        } else {
            git(&["commit", "-m", &message])?;
        }
    } else if !git_out(&["status", "--porcelain"])?.is_empty() {
        println!("⚠ 工作目錄有未 commit 的變更，只會推送已 commit 的內容（可用 -m 一併 commit）");
    }
    git(&["push", "-u", "origin", &format!("HEAD:{BRANCH}")])
}

/// 第一次使用時建立 git repo 並接上遠端既有的歷史（保留遠端已有的檔案，例如 LICENSE）。
fn ensure_repo() -> Result {
    let root = root();
    if !root.join(".git").exists() {
        println!("初始化 git repo 並連結 {REPO_URL}");
        git(&["init", "-b", BRANCH])?;
    }
    match git_out(&["remote", "get-url", "origin"]) {
        Ok(url) if url == REPO_URL => {}
        Ok(url) => println!("⚠ origin 指向 {url}，不是 {REPO_URL}"),
        Err(_) => git(&["remote", "add", "origin", REPO_URL])?,
    }
    git(&["fetch", "--tags", "origin"])?;

    let has_head = git_ok(&["rev-parse", "--verify", "--quiet", "HEAD"]);
    let remote_ref = format!("origin/{BRANCH}");
    if !has_head && git_ok(&["rev-parse", "--verify", "--quiet", &remote_ref]) {
        // 以遠端歷史為基底，保留本機檔案；本機沒有的遠端檔案取回來。
        git(&["reset", "--mixed", &remote_ref])?;
        let missing = git_out(&["ls-files", "--deleted"])?;
        for file in missing.lines().filter(|l| !l.is_empty()) {
            git(&["checkout", "--", file])?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- version

fn version() -> Result {
    let current = current_version()?;
    println!("目前版本：{current}");

    let Some(log) = commits_since_last_tag()? else {
        let next = current.bump(Bump::Patch);
        println!("尚未建立 git repo，無法分析 commit；建議下個版本：{next}");
        println!("\n  cargo xtask release {next}");
        return Ok(());
    };

    match &log.tag {
        Some(tag) => println!("上一個 tag：{tag}（之後 {} 個 commit）", log.subjects.len()),
        None => println!("尚無版本 tag（共 {} 個 commit）", log.subjects.len()),
    }
    if log.subjects.is_empty() && log.tag.is_some() {
        println!("自上次 release 後沒有新的 commit");
    }

    let (bump, reason) = suggest(&current, &log);
    let next = current.bump(bump);
    println!("建議下個版本：{next}（{reason}）");
    println!("\n  cargo xtask release {next}");
    println!(
        "\n其他選擇：patch → {}、minor → {}、major → {}",
        current.bump(Bump::Patch),
        current.bump(Bump::Minor),
        current.bump(Bump::Major)
    );
    Ok(())
}

struct CommitLog {
    tag: Option<String>,
    subjects: Vec<String>,
    breaking: bool,
}

fn commits_since_last_tag() -> Result<Option<CommitLog>> {
    if !root().join(".git").exists() || !git_ok(&["rev-parse", "--verify", "--quiet", "HEAD"]) {
        return Ok(None);
    }
    let tag = git_out(&["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]).ok();
    let range = tag.as_ref().map_or("HEAD".to_string(), |t| format!("{t}..HEAD"));
    let raw = git_out(&["log", "--format=%s%x1f%b%x1e", &range])?;
    let mut subjects = Vec::new();
    let mut breaking = false;
    for entry in raw.split('\x1e').map(str::trim).filter(|e| !e.is_empty()) {
        let (subject, body) = entry.split_once('\x1f').unwrap_or((entry, ""));
        breaking |= is_breaking(subject) || body.contains("BREAKING CHANGE");
        subjects.push(subject.to_string());
    }
    Ok(Some(CommitLog { tag, subjects, breaking }))
}

/// Conventional Commits 的 `type!:` 或 `type(scope)!:`。
fn is_breaking(subject: &str) -> bool {
    subject
        .split_once(':')
        .is_some_and(|(head, _)| head.ends_with('!') && !head.contains(' '))
}

fn suggest(current: &Version, log: &CommitLog) -> (Bump, &'static str) {
    let feat = log.subjects.iter().any(|s| s.starts_with("feat"));
    match (log.breaking, feat, current.major) {
        (true, _, 0) => (Bump::Minor, "有破壞性變更，0.x 階段升 minor"),
        (true, _, _) => (Bump::Major, "有破壞性變更"),
        (false, true, _) => (Bump::Minor, "有新功能 feat"),
        _ => (Bump::Patch, "僅修正或維護"),
    }
}

// ---------------------------------------------------------------- release

fn release(spec: &str, install: bool, yes: bool) -> Result {
    let current = current_version()?;
    let next = match spec {
        "patch" => current.bump(Bump::Patch),
        "minor" => current.bump(Bump::Minor),
        "major" => current.bump(Bump::Major),
        v => Version::parse(v.strip_prefix('v').unwrap_or(v))?,
    };
    if next <= current {
        return Err(format!("新版本 {next} 必須大於目前版本 {current}"));
    }
    let tag = format!("v{next}");

    // 事前檢查：避免升版後才發現無法推送。
    ensure_repo()?;
    if !git_out(&["status", "--porcelain"])?.is_empty() {
        return Err("工作目錄有未 commit 的變更，請先 commit（或 `cargo xtask push -m ...`）".into());
    }
    let branch = git_out(&["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch != BRANCH {
        return Err(format!("請在 {BRANCH} 分支上 release（目前在 {branch}）"));
    }
    let behind = git_out(&["rev-list", "--count", &format!("HEAD..origin/{BRANCH}")])?;
    if behind != "0" {
        return Err(format!("本機落後 origin/{BRANCH} {behind} 個 commit，請先同步"));
    }
    if git_ok(&["rev-parse", "--verify", "--quiet", &format!("refs/tags/{tag}")]) {
        return Err(format!("tag {tag} 已存在"));
    }
    run(Command::new("gh").args(["auth", "status"]))?;

    println!("\n即將發佈 {APP_NAME} {current} → {next}：建置 dmg、commit、push、tag {tag}、建立 GitHub Release");
    if !yes && !confirm("確定繼續？", false)? {
        return Err("已取消".into());
    }

    set_version(&next)?;
    let dmg = match publish(false, false, Some(install)) {
        Ok(dmg) => dmg,
        Err(err) => {
            println!("建置失敗，還原版本號");
            let mut args = vec!["checkout", "--"];
            args.extend(VERSION_FILES);
            git(&args)?;
            return Err(err);
        }
    };

    let mut add = vec!["add", "--"];
    add.extend(VERSION_FILES);
    git(&add)?;
    git(&["commit", "-m", &format!("chore(release): {tag}")])?;
    git(&["push", "origin", &format!("HEAD:{BRANCH}")])?;
    git(&["tag", "-a", &tag, "-m", &format!("{APP_NAME} {tag}")])?;
    git(&["push", "origin", &tag])?;
    run(Command::new("gh")
        .args(["release", "create", &tag, "--repo", REPO_SLUG, "--verify-tag", "--generate-notes", "--title"])
        .arg(format!("{APP_NAME} {tag}"))
        .arg(&dmg))?;

    println!("\n✓ 已發佈 {tag}：https://github.com/{REPO_SLUG}/releases/tag/{tag}");
    Ok(())
}

fn set_version(next: &Version) -> Result {
    let root = root();
    // npm 同時更新 package.json 與 package-lock.json。
    run(Command::new("npm")
        .args(["version", &next.to_string(), "--no-git-tag-version"])
        .current_dir(&root))?;

    let cargo_toml = root.join("src-tauri/Cargo.toml");
    write(&cargo_toml, &bump_cargo_toml(&read(&cargo_toml)?, next)?)?;
    let cargo_lock = root.join("src-tauri/Cargo.lock");
    write(&cargo_lock, &bump_cargo_lock(&read(&cargo_lock)?, next)?)?;

    println!("✓ 版本號已更新為 {next}");
    Ok(())
}

/// 只改 `[package]` 區段的第一個 version，相依套件的版本不動。
fn bump_cargo_toml(text: &str, next: &Version) -> Result<String> {
    let mut in_package = false;
    let mut done = false;
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('[') {
                in_package = trimmed == "[package]";
            } else if in_package && !done && trimmed.split('=').next().is_some_and(|k| k.trim() == "version") {
                done = true;
                return format!("version = \"{next}\"");
            }
            line.to_string()
        })
        .collect();
    if !done {
        return Err("Cargo.toml 的 [package] 找不到 version".into());
    }
    Ok(lines.join("\n") + "\n")
}

fn bump_cargo_lock(lock: &str, next: &Version) -> Result<String> {
    let marker = "name = \"highostty\"\nversion = \"";
    let start = lock.find(marker).ok_or("Cargo.lock 找不到 highostty")? + marker.len();
    let end = start + lock[start..].find('"').ok_or("Cargo.lock 格式不符")?;
    Ok(format!("{}{next}{}", &lock[..start], &lock[end..]))
}

// ---------------------------------------------------------------- version model

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

#[derive(Clone, Copy)]
enum Bump {
    Patch,
    Minor,
    Major,
}

impl Version {
    fn parse(text: &str) -> Result<Self> {
        let parts: Vec<&str> = text.trim().split('.').collect();
        let num = |s: &str| s.parse::<u64>().map_err(|_| format!("版本號格式應為 X.Y.Z：`{text}`"));
        match parts.as_slice() {
            [a, b, c] => Ok(Self { major: num(a)?, minor: num(b)?, patch: num(c)? }),
            _ => Err(format!("版本號格式應為 X.Y.Z：`{text}`")),
        }
    }

    fn bump(self, bump: Bump) -> Self {
        match bump {
            Bump::Patch => Self { patch: self.patch + 1, ..self },
            Bump::Minor => Self { minor: self.minor + 1, patch: 0, ..self },
            Bump::Major => Self { major: self.major + 1, minor: 0, patch: 0 },
        }
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

fn current_version() -> Result<Version> {
    let root = root();
    let npm = output(Command::new("node")
        .args(["-p", "require('./package.json').version"])
        .current_dir(&root))?;
    let cargo = read(&root.join("src-tauri/Cargo.toml"))?
        .lines()
        .skip_while(|l| l.trim() != "[package]")
        .find_map(|l| {
            let (key, value) = l.split_once('=')?;
            (key.trim() == "version").then(|| value.trim().trim_matches('"').to_string())
        })
        .ok_or("src-tauri/Cargo.toml 找不到 version")?;
    if npm != cargo {
        return Err(format!("版本號不一致：package.json {npm}、Cargo.toml {cargo}"));
    }
    Version::parse(&npm)
}

// ---------------------------------------------------------------- helpers

/// 簡單的參數解析：旗標、`-m <值>` 與一個位置參數；結束時拒絕未使用的參數。
struct Opts {
    args: Vec<Option<String>>,
}

impl Opts {
    fn parse(args: &[String]) -> Result<Self> {
        Ok(Self { args: args.iter().cloned().map(Some).collect() })
    }

    fn flag(&mut self, name: &str) -> bool {
        let found = self.args.iter_mut().find(|a| a.as_deref() == Some(name));
        found.map(|a| a.take()).is_some()
    }

    fn value(&mut self, name: &str) -> Result<Option<String>> {
        let Some(i) = self.args.iter().position(|a| a.as_deref() == Some(name)) else {
            return Ok(None);
        };
        self.args[i] = None;
        match self.args.get_mut(i + 1).and_then(Option::take) {
            Some(v) => Ok(Some(v)),
            None => Err(format!("{name} 需要一個值")),
        }
    }

    fn positional(&mut self) -> Option<String> {
        let slot = self.args.iter_mut().find(|a| a.as_deref().is_some_and(|s| !s.starts_with('-')))?;
        slot.take()
    }

    fn finish(&self) -> Result {
        let rest: Vec<String> = self.args.iter().flatten().cloned().collect();
        if rest.is_empty() { Ok(()) } else { Err(format!("無法辨識的參數：{}", rest.join(" "))) }
    }
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn target_dir() -> PathBuf {
    env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_TARGET_DIR))
}

fn profile(debug: bool) -> &'static str {
    if debug { "debug" } else { "release" }
}

fn arch() -> &'static str {
    match env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x64",
        other => other,
    }
}

fn confirm(question: &str, default: bool) -> Result<bool> {
    if !io::stdin().is_terminal() {
        return Ok(default);
    }
    print!("{question} {} ", if default { "[Y/n]" } else { "[y/N]" });
    io::stdout().flush().ok();
    let mut answer = String::new();
    io::stdin().read_line(&mut answer).map_err(|e| e.to_string())?;
    Ok(match answer.trim().to_lowercase().as_str() {
        "" => default,
        a => a == "y" || a == "yes",
    })
}

fn run(cmd: &mut Command) -> Result {
    println!("$ {}", describe(cmd));
    let status = cmd.status().map_err(|e| format!("無法執行 {}：{e}", describe(cmd)))?;
    if status.success() { Ok(()) } else { Err(format!("指令失敗（{status}）：{}", describe(cmd))) }
}

fn output(cmd: &mut Command) -> Result<String> {
    let out = cmd.output().map_err(|e| format!("無法執行 {}：{e}", describe(cmd)))?;
    if !out.status.success() {
        return Err(format!("指令失敗：{}\n{}", describe(cmd), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git_cmd(args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(root());
    cmd
}

fn git(args: &[&str]) -> Result {
    run(&mut git_cmd(args))
}

fn git_out(args: &[&str]) -> Result<String> {
    output(&mut git_cmd(args))
}

fn git_ok(args: &[&str]) -> bool {
    git_cmd(args).output().is_ok_and(|o| o.status.success())
}

fn describe(cmd: &Command) -> String {
    let mut parts = vec![cmd.get_program().to_string_lossy().into_owned()];
    parts.extend(cmd.get_args().map(|a| {
        let a = a.to_string_lossy();
        if a.contains(' ') { format!("'{a}'") } else { a.into_owned() }
    }));
    parts.join(" ")
}

fn read(path: &Path) -> Result<String> {
    fs::read_to_string(path).map_err(|e| format!("無法讀取 {}：{e}", path.display()))
}

fn write(path: &Path, text: &str) -> Result {
    fs::write(path, text).map_err(|e| format!("無法寫入 {}：{e}", path.display()))
}

fn create_dir(path: &Path) -> Result {
    fs::create_dir_all(path).map_err(|e| format!("無法建立 {}：{e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn log(subjects: &[&str], breaking: bool) -> CommitLog {
        CommitLog { tag: None, subjects: subjects.iter().map(|s| s.to_string()).collect(), breaking }
    }

    #[test]
    fn clean_refuses_unsafe_paths() {
        let root = Path::new("/Users/me/proj");
        assert!(is_removable(Path::new("/private/tmp/highostty-target"), root));
        assert!(!is_removable(Path::new("/"), root));
        assert!(!is_removable(Path::new("/Users"), root));
        assert!(!is_removable(Path::new("/Users/me"), root));
        assert!(!is_removable(root, root));
        assert!(!is_removable(Path::new("relative"), root));
    }

    #[test]
    fn parses_and_bumps() {
        assert_eq!(v("0.2.0").bump(Bump::Patch).to_string(), "0.2.1");
        assert_eq!(v("0.2.3").bump(Bump::Minor).to_string(), "0.3.0");
        assert_eq!(v("1.2.3").bump(Bump::Major).to_string(), "2.0.0");
        assert!(v("0.10.0") > v("0.9.9"));
        assert!(Version::parse("1.2").is_err());
        assert!(Version::parse("1.2.x").is_err());
    }

    #[test]
    fn detects_breaking_subjects() {
        assert!(is_breaking("feat!: drop macOS 12"));
        assert!(is_breaking("refactor(ui)!: new layout"));
        assert!(!is_breaking("fix: handle ! in path"));
        assert!(!is_breaking("docs: wow! great: stuff"));
    }

    #[test]
    fn suggests_bump() {
        assert!(matches!(suggest(&v("0.2.0"), &log(&["fix: a"], false)).0, Bump::Patch));
        assert!(matches!(suggest(&v("0.2.0"), &log(&["feat: a"], false)).0, Bump::Minor));
        assert!(matches!(suggest(&v("0.2.0"), &log(&["fix!: a"], true)).0, Bump::Minor));
        assert!(matches!(suggest(&v("1.2.0"), &log(&["fix!: a"], true)).0, Bump::Major));
    }

    #[test]
    fn bumps_only_package_version_in_cargo_toml() {
        let text = "[package]\nname = \"highostty\"\nversion = \"0.2.0\"\n[dependencies]\nlibc = { version = \"0.2\" }\n";
        let out = bump_cargo_toml(text, &v("0.3.0")).unwrap();
        assert!(out.contains("version = \"0.3.0\"\n[dependencies]"));
        assert!(out.contains("libc = { version = \"0.2\" }"));
    }

    #[test]
    fn bumps_cargo_lock_entry() {
        let lock = "[[package]]\nname = \"heck\"\nversion = \"0.5.0\"\n\n[[package]]\nname = \"highostty\"\nversion = \"0.2.0\"\n";
        let out = bump_cargo_lock(lock, &v("0.2.1")).unwrap();
        assert!(out.ends_with("name = \"highostty\"\nversion = \"0.2.1\"\n"));
        assert!(out.contains("name = \"heck\"\nversion = \"0.5.0\""));
    }
}
