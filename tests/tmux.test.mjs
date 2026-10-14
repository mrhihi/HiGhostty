import test from "node:test";
import assert from "node:assert/strict";
import { newSessionName, restorable, tmuxCommand, validSession } from "../src/tmux.ts";

test("session names are valid and distinct", () => {
  const a = newSessionName();
  assert.ok(validSession(a));
  assert.notEqual(a, newSessionName());
  assert.ok(validSession(newSessionName(() => 0.9999999)));
  assert.ok(!validSession("hg-bad name"));
  assert.ok(!validSession("$(rm -rf)"));
});

test("tmuxCommand attaches or creates, quoting cwd and command", () => {
  assert.equal(tmuxCommand("hg-abcd1234", "/tmp/a b"), "tmux new-session -A -s hg-abcd1234 -c '/tmp/a b' \\; set-option status on");
  assert.ok(tmuxCommand("hg-abcd1234", "/", undefined, true).endsWith("\\; set-option status off"));
  assert.equal(tmuxCommand("hg-abcd1234", "/it's", "npm run dev"), "tmux new-session -A -s hg-abcd1234 -c '/it'\\''s' 'npm run dev' \\; set-option status on");
  assert.throws(() => tmuxCommand("x; rm", "/"));
});

test("tmuxCommand uses a quoted absolute binary", () => {
  assert.ok(tmuxCommand("hg-abcd1234", "/", undefined, false, "/opt/homebrew/bin/tmux").startsWith("'/opt/homebrew/bin/tmux' new-session -A -s hg-abcd1234"));
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
