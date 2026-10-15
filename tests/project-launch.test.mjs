import test from "node:test";
import assert from "node:assert/strict";
import { launchSpecFromCommand, splitArgs } from "../src/project-launch.ts";

const ok = (cmd, cwd = "/work") => { const r = launchSpecFromCommand(cmd, cwd); assert.ok(r.ok, JSON.stringify(r)); return r; };

test("a plain agent command keeps its arguments and starts in the member's own directory", () => {
  const r = ok("claude --model opus --add-dir ../x", "/jira");
  assert.deepEqual(r.spec, { kind: "claude", cwd: { kind: "absolute", path: "/jira" }, args: ["--model", "opus", "--add-dir", "../x"], tmux: true });
  assert.deepEqual(r.dropped, []);
});

test("flags that re-enter the person's conversation are dropped and reported", () => {
  const r = ok("claude --model opus --resume abc123 --continue -r");
  assert.deepEqual(r.spec.args, ["--model", "opus"]);
  assert.deepEqual(r.dropped, ["--resume", "abc123", "--continue", "-r"]);
  assert.deepEqual(ok("claude --session-id=u1 -p").spec.args, ["-p"]);
  assert.deepEqual(ok("copilot --resume").spec.args, []);
  assert.deepEqual(ok("codex resume 019a --model gpt").spec.args, ["--model", "gpt"]);
});

test("a flag after a resume flag is not swallowed as its id", () => {
  assert.deepEqual(ok("claude --resume --model opus").spec.args, ["--model", "opus"]);
});

test("env prefixes, aliases and non-agents are refused with a reason", () => {
  assert.equal(launchSpecFromCommand("FOO=1 claude", "/w").reason, "env-prefix");
  assert.equal(launchSpecFromCommand("vim", "/w").reason, "not-agent");
  const viaAlias = launchSpecFromCommand("cc --model x", "/w", (p) => (p === "cc" ? ["claude"] : undefined));
  assert.equal(viaAlias.reason, "wrapper");
});

test("shell syntax we will not guess at is refused; plain quotes survive", () => {
  assert.equal(launchSpecFromCommand("claude --x $(pwd)", "/w").reason, "unparseable");
  assert.equal(launchSpecFromCommand("claude 'unterminated", "/w").reason, "unparseable");
  assert.deepEqual(splitArgs(`--prompt "hello world" 'a b'`), ["--prompt", "hello world", "a b"]);
});

test("gh copilot is a supported spelling", () => {
  assert.equal(ok("gh copilot --resume x").spec.kind, "copilot");
});

test("anything a shell would expand is refused rather than copied literally", () => {
  for (const arg of ['"$HOME/x"', "~/proj", "{a,b}", '"`pwd`"', "a#b"]) assert.equal(splitArgs(arg), undefined, arg);
  assert.deepEqual(splitArgs("'$HOME' a~b"), ["$HOME", "a~b"], "single quotes and a tilde inside a word are literal in a shell too");
});
