import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPS, AGENT_KINDS, MAX_KEYS, MAX_PROMPT_CHARS, agentCommand, confirmedState, keysProblem, promptProblem, startReady, ALERT_LIMITS, SNIPPET_LIMITS, STATUS_MAX_CHARS, alertInput, snippetInput, statusText, DEFAULT_WAIT_MS, KEY_NAMES, MAX_COMMAND_CHARS, commandLine, commandProblem, isShellName, shellQuote, validKey, MAX_WAIT_MS, authorize, claimFor, errReply, findMatch, helpResult, makeMatcher, okReply, parseArgv, resolveCaller, tailLines, usage, waitLimit, waitSatisfied } from "../src/control.ts";

const parse = (...argv) => parseArgv(argv);

test("empty argv shows help; unknown commands are rejected", () => {
  assert.equal(parse().parsed.op.name, "help");
  const unknown = parse("nope");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reply.error.code, "unknown_op");
});

test("argv must be an array of strings", () => {
  assert.equal(parseArgv("ping").reply.error.code, "bad_args");
  assert.equal(parseArgv(["ping", 1]).reply.error.code, "bad_args");
});

test("global --timeout is a number on every command", () => {
  assert.equal(parse("ping", "--timeout", "5000").parsed.flags.timeout, 5000);
  assert.equal(parse("ping", "--timeout=250").parsed.flags.timeout, 250);
  assert.equal(parse("ping", "--timeout", "soon").reply.error.code, "bad_args");
  assert.equal(parse("ping", "--timeout").reply.error.code, "bad_args");
});

test("unknown flags and extra positionals are errors", () => {
  assert.equal(parse("ping", "--what").reply.error.code, "bad_args");
  assert.equal(parse("ping", "extra").reply.error.code, "bad_args");
  assert.equal(parse("ping", "--").reply.error.code, "bad_args");
});

test("positionals, flag kinds and rest follow the spec", () => {
  OPS.push({ name: "demo run", write: true, summary: "t", args: ["id", "note?"], flags: { lines: "number", match: "list", focus: "boolean", name: "string" }, rest: true });
  try {
    const ok = parse("demo", "run", "s1", "--lines=20", "--match", "a", "--match", "b", "--focus", "--name", "x y", "--", "npm", "--version");
    assert.deepEqual(ok.parsed.args, { id: "s1" });
    assert.deepEqual(ok.parsed.flags, { lines: 20, match: ["a", "b"], focus: true, name: "x y" });
    assert.deepEqual(ok.parsed.rest, ["npm", "--version"]);
    assert.deepEqual(parse("demo", "run", "s1", "n").parsed.args, { id: "s1", note: "n" });
    assert.equal(parse("demo", "run").reply.error.code, "bad_args");
    assert.equal(parse("demo", "run", "s1", "--focus=maybe").reply.error.code, "bad_args");
    assert.equal(parse("demo", "run", "s1", "--focus=false").parsed.flags.focus, false);
    assert.match(usage(OPS.at(-1)), /highostty ctl demo run <id> \[<note>\] \[--lines <number>\]/);
  } finally {
    OPS.pop();
  }
});

test("the longest command name wins", () => {
  OPS.push({ name: "tab", write: false, summary: "t", args: ["x?"] }, { name: "tab list", write: false, summary: "t" });
  try {
    assert.equal(parse("tab", "list").parsed.op.name, "tab list");
    assert.equal(parse("tab", "other").parsed.op.name, "tab");
  } finally {
    OPS.pop();
    OPS.pop();
  }
});

test("authorize: off blocks all, readonly blocks writes, full allows", () => {
  const read = { name: "r", write: false, summary: "" };
  const write = { name: "w", write: true, summary: "" };
  assert.equal(authorize("off", read).error.code, "disabled");
  assert.equal(authorize(undefined, read).error.code, "disabled");
  assert.equal(authorize("readonly", read), null);
  assert.equal(authorize("readonly", write).error.code, "forbidden");
  assert.equal(authorize("full", write), null);
});

test("resolveCaller prefers the tmux session; a stale inherited surface id must not win", () => {
  const surfaces = [{ id: "a" }, { id: "b", tmuxSession: "hg-abcd1234" }];
  assert.equal(resolveCaller({ surface: "a" }, surfaces), "a");
  assert.equal(resolveCaller({ tmuxSession: "hg-abcd1234" }, surfaces), "b");
  assert.equal(resolveCaller({ surface: "gone", tmuxSession: "hg-abcd1234" }, surfaces), "b");
  assert.equal(resolveCaller({ surface: "a", tmuxSession: "hg-abcd1234" }, surfaces), "b");
  assert.equal(resolveCaller({ surface: "a", tmuxSession: "hg-other" }, surfaces), undefined);
  assert.equal(resolveCaller({ surface: "gone" }, surfaces), undefined);
  assert.equal(resolveCaller({ tmuxSession: "" }, surfaces), undefined);
  assert.equal(resolveCaller(null, surfaces), undefined);
});

test("replies and help", () => {
  assert.deepEqual(okReply(1), { ok: true, result: 1 });
  assert.deepEqual(errReply("failed", "x"), { ok: false, error: { code: "failed", message: "x" } });
  assert.ok(helpResult().commands.some((c) => c.name === "ping" && c.usage.startsWith("highostty ctl ping")));
});

test("read-only list and read commands parse", () => {
  const all = parse("tab", "list", "--here");
  assert.equal(all.parsed.op.scope, "all");
  assert.equal(all.parsed.flags.here, true);
  const read = parse("surface", "read", "abc", "--lines", "30", "--scrollback");
  assert.deepEqual(read.parsed.args, { id: "abc" });
  assert.deepEqual(read.parsed.flags, { lines: 30, scrollback: true });
  assert.equal(parse("surface", "read").reply.error.code, "bad_args");
  assert.equal(parse("agent", "wait", "abc", "--until", "blocked", "--timeout", "5000").parsed.flags.until, "blocked");
  for (const op of OPS.filter((op) => ["window list", "tab list", "agent list", "surface read", "surface wait", "agent wait"].includes(op.name))) assert.equal(op.write, false);
});

test("claims: caller scope needs the caller, surface scope the target, all scope everyone", () => {
  const claim = (argv, callerHere, owned = []) => claimFor(parse(...argv).parsed, { callerHere, ownsSurface: (id) => owned.includes(id) });
  assert.equal(claim(["whoami"], true), "owner");
  assert.equal(claim(["whoami"], false), "none");
  assert.equal(claim(["tab", "list"], false), "part");
  assert.equal(claim(["tab", "list"], true), "part");
  assert.equal(claim(["surface", "read", "s1"], false, ["s1"]), "owner");
  assert.equal(claim(["surface", "read", "s1"], true, ["s2"]), "none");
  assert.equal(claim(["agent", "wait", "s1"], false, ["s1"]), "owner");
});

test("tailLines keeps the last lines and drops the blank tail", () => {
  assert.equal(tailLines("a\nb\nc\n\n   \n", 2), "b\nc");
  assert.equal(tailLines("a  \nb", 5), "a\nb");
  assert.equal(tailLines("", 3), "");
  assert.equal(tailLines("a\nb", 0), "b");
});

test("matcher: literals, regex, and validation", () => {
  const made = (flags) => makeMatcher(flags);
  assert.equal(made({}).ok, false);
  assert.equal(made({ regex: "(" }).reply.error.code, "bad_args");
  const both = made({ match: ["ready", "listening"], regex: "^done \\d+$" }).matcher;
  assert.equal(findMatch("starting\nServer ready on 3000", both), "Server ready on 3000");
  assert.equal(findMatch("x\ndone 42", both), "done 42");
  assert.equal(findMatch("nothing here", both), undefined);
  assert.equal(findMatch("done 42x", both), undefined);
});

test("agent wait targets and wait limits", () => {
  assert.ok(waitSatisfied("idle", undefined));
  assert.ok(waitSatisfied("blocked", undefined));
  assert.ok(!waitSatisfied("working", undefined));
  assert.ok(waitSatisfied("working", "working"));
  assert.ok(!waitSatisfied("idle", "blocked"));
  assert.equal(waitLimit(undefined), DEFAULT_WAIT_MS);
  assert.equal(waitLimit(-1), DEFAULT_WAIT_MS);
  assert.equal(waitLimit(30000), 30000);
  assert.equal(waitLimit(1e12), MAX_WAIT_MS);
});

test("write commands: tab new, surface run and surface key parse and need full mode", () => {
  const tab = parse("tab", "new", "--cwd", "~/proj", "--tmux", "--", "npm", "run", "dev");
  assert.deepEqual(tab.parsed.flags, { cwd: "~/proj", tmux: true });
  assert.deepEqual(tab.parsed.rest, ["npm", "run", "dev"]);
  assert.equal(tab.parsed.op.scope ?? "caller", "caller");
  const run = parse("surface", "run", "s1", "--", "ls -la");
  assert.deepEqual(run.parsed.args, { id: "s1" });
  assert.deepEqual(run.parsed.rest, ["ls -la"]);
  assert.equal(parse("surface", "run", "s1", "ls").reply.error.code, "bad_args");
  assert.deepEqual(parse("surface", "key", "s1", "ctrl+c").parsed.args, { id: "s1", key: "ctrl+c" });
  for (const argv of [["tab", "new"], ["surface", "run", "s1", "--", "x"], ["surface", "key", "s1", "esc"]]) {
    const op = parse(...argv).parsed.op;
    assert.equal(op.write, true);
    assert.equal(authorize("readonly", op).error.code, "forbidden");
    assert.equal(authorize("full", op), null);
  }
  assert.equal(claimFor(parse("surface", "run", "s1", "--", "x").parsed, { callerHere: true, ownsSurface: (id) => id === "s1" }), "owner");
  assert.equal(claimFor(parse("tab", "new").parsed, { callerHere: false, ownsSurface: () => false }), "none");
});

test("keys: named keys and ctrl+letter only", () => {
  for (const key of [...KEY_NAMES, "ctrl+c", "ctrl+z"]) assert.ok(validKey(key), key);
  for (const key of ["", "Enter", "ctrl+", "ctrl+1", "ctrl+cc", "alt+x", "f5", "cmd+q"]) assert.ok(!validKey(key), key);
});

test("commandLine: one word is a shell line, several are quoted argv", () => {
  assert.equal(commandLine(["npm run dev && echo up"]), "npm run dev && echo up");
  assert.equal(commandLine(["echo", "a b", "it's", "$HOME", "x/y-1.2"]), "echo 'a b' 'it'\\''s' '$HOME' x/y-1.2");
  assert.equal(shellQuote("plain"), "plain");
  assert.equal(shellQuote(""), "''");
});

test("commandProblem rejects empty, multi-line and oversized commands", () => {
  assert.equal(commandProblem("ls"), undefined);
  assert.match(commandProblem("  "), /缺少命令/);
  assert.match(commandProblem("a\nb"), /換行/);
  assert.match(commandProblem("a\rb"), /換行/);
  assert.match(commandProblem("x".repeat(MAX_COMMAND_CHARS + 1)), /太長/);
});

test("isShellName recognises login shells and rejects programs", () => {
  assert.ok(isShellName("zsh") && isShellName("-zsh") && isShellName("bash") && isShellName("fish"));
  assert.ok(!isShellName("node") && !isShellName("vim") && !isShellName("tmux") && !isShellName(""));
});

test("variadic paths: any number, collected in rest", () => {
  const some = parse("files", "reveal", "a.txt", "dir/b c.png");
  assert.deepEqual(some.parsed.rest, ["a.txt", "dir/b c.png"]);
  assert.deepEqual(parse("files", "quicklook").parsed.rest, []);
  assert.deepEqual(parse("files", "quicklook", "x", "--timeout", "100", "y").parsed.rest, ["x", "y"]);
  assert.match(usage(parse("files", "reveal").parsed.op), /highostty ctl files reveal <path…>/);
  assert.equal(parse("files", "reveal", "--bogus").reply.error.code, "bad_args");
});

test("Phase 5 permissions: showing files and adding snippets need full; alerts and status do not", () => {
  const need = (argv) => authorize("readonly", parse(...argv).parsed.op);
  assert.equal(need(["files", "reveal", "x"]).error.code, "forbidden");
  assert.equal(need(["files", "quicklook", "x"]).error.code, "forbidden");
  assert.equal(need(["snippet", "add"]).error.code, "forbidden");
  assert.equal(need(["alert", "raise"]), null);
  assert.equal(need(["alert", "clear"]), null);
  assert.equal(need(["tab", "status", "hi"]), null);
});

test("alertInput needs a single-line title and bounds everything", () => {
  const input = (flags) => alertInput(flags);
  assert.equal(input({}).reply.error.code, "bad_args");
  assert.equal(input({ title: "  " }).ok, false);
  assert.equal(input({ title: "a\nb" }).ok, false);
  assert.equal(input({ title: "x".repeat(ALERT_LIMITS.title + 1) }).ok, false);
  assert.equal(input({ title: "t", body: "x".repeat(ALERT_LIMITS.body + 1) }).ok, false);
  assert.equal(input({ title: "t", option: Array(ALERT_LIMITS.options + 1).fill("o") }).ok, false);
  assert.deepEqual(input({ title: " 要你決定 ", body: " 用哪個？ ", option: ["A", " ", "B "] }).input, { title: "要你決定", body: "用哪個？", options: ["A", "B"] });
});

test("statusText collapses whitespace and truncates", () => {
  assert.equal(statusText(undefined), undefined);
  assert.equal(statusText("  \n "), undefined);
  assert.equal(statusText("跑測試   3/5\n"), "跑測試 3/5");
  const long = statusText("x".repeat(100));
  assert.equal(long.length, STATUS_MAX_CHARS);
  assert.ok(long.endsWith("…"));
});

test("snippetInput: scope defaults to the caller's directory; never auto-runs", () => {
  const make = (flags, cwd = "/Users/me/proj") => snippetInput(flags, cwd);
  assert.deepEqual(make({ name: "測試", text: "npm test" }).input, { name: "測試", text: "npm test", scope: "/Users/me/proj", keywords: undefined });
  assert.equal(make({ name: "n", text: "t", scope: "global" }).input.scope, "global");
  assert.equal(make({ name: "n", text: "t", scope: "/etc" }).input.scope, "/etc");
  assert.equal(make({ name: "n", text: "t", scope: "relative/dir" }).ok, false);
  // No caller directory known: "cwd" cannot be resolved, "global" still works.
  assert.match(snippetInput({ name: "n", text: "t" }, undefined).reply.error.message, /找不到呼叫者/);
  assert.equal(snippetInput({ name: "n", text: "t", scope: "global" }, undefined).ok, true);
  assert.equal(make({ name: "n" }).ok, false);
  assert.equal(make({ text: "t" }).ok, false);
  assert.equal(make({ name: "a\nb", text: "t" }).ok, false);
  assert.equal(make({ name: "n", text: "x".repeat(SNIPPET_LIMITS.text + 1) }).ok, false);
  assert.equal(make({ name: "n", text: "a\0b" }).ok, false);
  assert.equal(make({ name: "n", text: "line1\nline2" }).ok, true);
  assert.equal(make({ name: "n", text: "t", keyword: ["git", "push"] }).input.keywords, "git push");
  assert.equal(make({ name: "n", text: "t", keyword: ["has space"] }).ok, false);
  assert.equal("run" in make({ name: "n", text: "t" }).input, false);
});

test("Phase 6 commands parse and need full mode", () => {
  const start = parse("agent", "start", "claude", "--cwd", "/tmp/x", "--timeout", "60000", "--", "--model", "opus");
  assert.deepEqual(start.parsed.args, { kind: "claude" });
  assert.deepEqual(start.parsed.rest, ["--model", "opus"]);
  const prompt = parse("agent", "prompt", "s1", "請檢查 diff", "--wait", "--timeout", "120000");
  assert.deepEqual(prompt.parsed.args, { id: "s1", text: "請檢查 diff" });
  assert.equal(prompt.parsed.flags.wait, true);
  assert.deepEqual(parse("agent", "keys", "s1", "esc", "ctrl+c").parsed.rest, ["esc", "ctrl+c"]);
  assert.equal(parse("agent", "prompt", "s1").reply.error.code, "bad_args");
  for (const argv of [["agent", "start", "claude"], ["agent", "prompt", "s1", "hi"], ["agent", "keys", "s1", "esc"]]) {
    const op = parse(...argv).parsed.op;
    assert.equal(op.write, true);
    assert.equal(authorize("readonly", op).error.code, "forbidden");
  }
  assert.equal(claimFor(parse("agent", "prompt", "s1", "hi").parsed, { callerHere: true, ownsSurface: (id) => id === "s2" }), "none");
  assert.equal(claimFor(parse("agent", "start", "claude").parsed, { callerHere: true, ownsSurface: () => false }), "owner");
});

test("agentCommand accepts only known agents and quotes their arguments", () => {
  assert.equal(agentCommand("claude", []).line, "claude");
  assert.equal(agentCommand("codex", ["--model", "gpt 5", "it's"]).line, "codex --model 'gpt 5' 'it'\\''s'");
  for (const kind of AGENT_KINDS) assert.ok(agentCommand(kind, []).ok, kind);
  for (const kind of ["rm", "claude;ls", "", "Claude", "node"]) assert.equal(agentCommand(kind, []).reply.error.code, "bad_args", kind);
  assert.equal(agentCommand("claude", ["a\nb"]).ok, false);
});

test("promptProblem and keysProblem", () => {
  assert.equal(promptProblem("多行\n的 prompt"), undefined);
  assert.match(promptProblem("   "), /不可為空/);
  assert.match(promptProblem("x".repeat(MAX_PROMPT_CHARS + 1)), /太長/);
  assert.match(promptProblem("a\0b"), /NUL/);
  assert.equal(keysProblem(["esc", "ctrl+c", "enter"]), undefined);
  assert.match(keysProblem([]), /缺少按鍵/);
  assert.match(keysProblem(["esc", "f5"]), /f5/);
  assert.match(keysProblem(Array(MAX_KEYS + 1).fill("esc")), /最多/);
});

test("a state must be seen twice in a row to count", () => {
  const settled = (state) => state !== "working";
  assert.equal(confirmedState(undefined, "idle", settled), false);
  assert.equal(confirmedState("working", "idle", settled), false);
  assert.equal(confirmedState("idle", "idle", settled), true);
  assert.equal(confirmedState("idle", "blocked", settled), false);
  assert.equal(confirmedState("blocked", "blocked", settled), true);
  assert.equal(confirmedState("working", "working", settled), false);
});

test("agent start is ready only on a steady, non-blank idle or asking screen", () => {
  assert.equal(startReady(undefined, "banner", "idle"), false);
  assert.equal(startReady("loading", "banner", "idle"), false);
  assert.equal(startReady("banner", "banner", "idle"), true);
  assert.equal(startReady("banner", "banner", "blocked"), true);
  assert.equal(startReady("banner", "banner", "working"), false);
  assert.equal(startReady("  ", "  ", "idle"), false);
});

// ---- the skill that teaches agents these commands must match the command table ----
const skill = readFileSync(new URL("../skills/highostty/SKILL.md", import.meta.url), "utf8");
// Split a shell-ish example line into words: bare words, "double quoted" words, a trailing # comment dropped.
function words(line) {
  const out = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const match of line.matchAll(pattern)) {
    if (match[2]?.startsWith("#")) break;
    out.push(match[1] ?? match[2]);
  }
  return out;
}
const examples = [...skill.matchAll(/^"\$HIGHOSTTY_CLI" ctl (.+)$/gm)].map((match) => words(match[1])).filter((argv) => !argv[0].startsWith("<")); // the generic syntax line is not an example

test("the skill is a valid, app-managed skill file", () => {
  assert.ok(skill.startsWith("---\nname: highostty\ndescription: "));
  assert.ok(skill.includes("<!-- managed by HiGhostty"));
  assert.ok(skill.includes('test "${HIGHOSTTY_ENV:-}" = 1'));
});

test("every example command in the skill parses against the command table", () => {
  assert.ok(examples.length >= 20, `only ${examples.length} examples found`);
  for (const argv of examples) {
    const result = parseArgv(argv);
    assert.ok(result.ok, `${argv.join(" ")} → ${result.reply?.error?.message}`);
  }
});

test("the skill mentions every command (except ping) and every error code", () => {
  for (const op of OPS.filter((op) => op.name !== "ping")) assert.ok(skill.includes(op.name), `${op.name} is not in the skill`);
  for (const code of ["disabled", "forbidden", "bad_args", "unknown_op", "not_found", "busy", "agent_blocked", "agent_prompt_stalled", "timeout", "failed", "unavailable"]) assert.ok(skill.includes("`" + code + "`"), `${code} is not explained`);
});

test("the skill's write examples are the ones that need full mode", () => {
  const needsFull = (argv) => parseArgv(argv).parsed.op.write;
  for (const argv of examples) {
    const name = parseArgv(argv).parsed.op.name;
    if (["tab new", "surface run", "surface key", "files reveal", "files quicklook", "snippet add", "agent start", "agent prompt", "agent keys"].includes(name)) assert.equal(needsFull(argv), true, name);
    if (["alert raise", "alert clear", "tab status", "surface read", "surface wait", "tab list", "agent list", "window list", "whoami"].includes(name)) assert.equal(needsFull(argv), false, name);
  }
});

test("preview commands are read-only and parse path (--side is accepted and ignored)", () => {
  for (const name of ["preview open", "preview close", "preview status"]) assert.equal(OPS.find((op) => op.name === name).write, false);
  const { parsed } = parse("preview", "open", "docs/PLAN.md", "--side", "bottom");
  assert.equal(parsed.op.name, "preview open");
  assert.equal(parsed.args.path, "docs/PLAN.md");
  assert.equal(parsed.flags.side, "bottom");
  assert.equal(authorize("readonly", parsed.op), null);
  assert.ok(parse("preview", "open").reply);
});

test("preview window opens a new window, so it needs full mode", () => {
  const { parsed } = parse("preview", "window", "PLAN.md");
  assert.equal(parsed.op.name, "preview window");
  assert.equal(parsed.op.write, true);
  assert.equal(authorize("readonly", parsed.op).error.code, "forbidden");
  assert.equal(authorize("full", parsed.op), null);
});
