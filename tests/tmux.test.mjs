import { useLocale } from "./i18n-helper.mjs"; useLocale();
import test from "node:test";
import assert from "node:assert/strict";
import { newSessionName, restorable, tmuxCommand, validSession, withProgramPath } from "../src/tmux.ts";

test("session names are valid and distinct", () => {
  const a = newSessionName();
  assert.ok(validSession(a));
  assert.notEqual(a, newSessionName());
  assert.ok(validSession(newSessionName(() => 0.9999999)));
  assert.ok(!validSession("hg-bad name"));
  assert.ok(!validSession("$(rm -rf)"));
});

test("tmuxCommand attaches or creates, quoting cwd and command", () => {
  assert.equal(tmuxCommand("hg-abcd1234", "/tmp/a b"), "tmux start-server \\; set-option -s extended-keys always \\; set-option -s 'terminal-features[100]' 'xterm*:extkeys' \\; new-session -A -s hg-abcd1234 -c '/tmp/a b' \\; set-option status on");
  assert.ok(tmuxCommand("hg-abcd1234", "/", undefined, true).endsWith("\\; set-option status off"));
  assert.equal(tmuxCommand("hg-abcd1234", "/it's", "npm run dev"), "tmux start-server \\; set-option -s extended-keys always \\; set-option -s 'terminal-features[100]' 'xterm*:extkeys' \\; new-session -A -s hg-abcd1234 -c '/it'\\''s' 'npm run dev' \\; set-option status on");
  assert.throws(() => tmuxCommand("x; rm", "/"));
});

test("tmuxCommand uses a quoted absolute binary", () => {
  assert.ok(tmuxCommand("hg-abcd1234", "/", undefined, false, "/opt/homebrew/bin/tmux").startsWith("'/opt/homebrew/bin/tmux' start-server"));
});

test("restorable keeps only tmux tabs and drops invalid sessions", () => {
  const tabs = [
    { paths: ["/a"], tmux: true, tmuxSessions: ["hg-abcd1234", "evil;"] },
    { paths: ["/b"] },
    { paths: ["/c"], tmux: true },
    null,
  ];
  const result = restorable(tabs);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].tmuxSessions, ["hg-abcd1234", undefined]);
  assert.deepEqual(result[1].tmuxSessions, []);
  assert.deepEqual(restorable("nope"), []);
});

test("tmuxCommand passes environment with -e, quoted, and drops unsafe keys", () => {
  const command = tmuxCommand("hg-abcd1234", "/tmp", undefined, false, "tmux", { HIGHOSTTY_ENV: "1", HIGHOSTTY_CLI: "/Applications/Hi Ghostty/it's", "bad key": "x", lower: "x" });
  assert.match(command, /new-session -A -s hg-abcd1234 -e 'HIGHOSTTY_ENV=1' -e 'HIGHOSTTY_CLI=\/Applications\/Hi Ghostty\/it'\\''s' -c '\/tmp'/);
  assert.ok(!command.includes("bad key") && !command.includes("lower="));
});

test("withProgramPath replaces only a bare program name", () => {
  assert.equal(withProgramPath("claude --resume", "/u/.local/bin/claude"), "'/u/.local/bin/claude' --resume");
  assert.equal(withProgramPath("A=1 claude", "/u/bin/claude"), "A=1 '/u/bin/claude'");
  assert.equal(withProgramPath("/x/claude", "/u/bin/claude"), "/x/claude");
  assert.equal(withProgramPath("claude", null), "claude");
  assert.equal(withProgramPath("claude", "/u/it's/claude"), "'/u/it'\\''s/claude'");
  assert.equal(withProgramPath(undefined, "/a"), undefined);
});

import { withProgramDir } from "../src/tmux.ts";
test("withProgramDir puts the program's folder on PATH for scripts that need node", () => {
  assert.equal(withProgramDir("'/u/.nvm/bin/claude' --resume", "/u/.nvm/bin/claude"), `PATH="/u/.nvm/bin:$PATH" '/u/.nvm/bin/claude' --resume`);
  assert.equal(withProgramDir("ls", "/usr/bin/ls"), "ls");
  assert.equal(withProgramDir("claude", null), "claude");
  assert.equal(withProgramDir(undefined, "/a/b"), undefined);
  assert.equal(withProgramDir("x", '/we"ird/$d/x'), `PATH="/we\\"ird/\\$d:$PATH" x`);
  // 有登入 shell PATH 時直接寫進命令（含空白），且程式在系統資料夾或查不到時也要設定
  assert.equal(withProgramDir("claude", "/u/bin/claude", "/a b:/c"), `PATH="/u/bin:/a b:/c" claude`);
  assert.equal(withProgramDir("ls", "/usr/bin/ls", "/a b:/c"), `PATH="/a b:/c" ls`);
  assert.equal(withProgramDir("claude", null, "/a:/c"), `PATH="/a:/c" claude`);
  assert.equal(withProgramDir("claude", null, null), "claude");
});
