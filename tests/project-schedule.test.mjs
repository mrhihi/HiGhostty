import test from "node:test";
import assert from "node:assert/strict";
import { decide, reduce, emptyState } from "../src/projects.ts";
import { verdict, nextDeliverable, busyElsewhere, OBSERVATION_MAX_AGE_MS } from "../src/project-schedule.ts";
import { holdInstance, leaveInstance, tickHold, giveBack, isHeld, RELEASE_QUIET_MS } from "../src/project-hold.ts";

const NOW = "2026-10-15T00:00:00.000Z";
const user = { kind: "user" };
const as = (memberId) => ({ kind: "member", memberId });
let n = 0;
const run = (s, actor, body) => { const r = decide(s, { actionId: `a${++n}`, actor, body }, NOW); assert.ok(r.ok, r.ok ? "" : r.error.message); return r.value.events.reduce(reduce, s); };
const mem = (id, role = "worker") => ({ id, role, name: id, purpose: "", purposeSource: "user", reportMode: "protocol" });

function project(auto = true, instances = { A: "ia", B: "ib" }) {
  let s = run(emptyState(), user, { type: "CreateProject", config: { schemaVersion: 1, id: "p", name: "P", coordinatorMemberId: "c", createdAt: NOW }, coordinator: mem("c", "coordinator") });
  s = run(s, user, { type: "BindMember", memberId: "c", instanceId: "ic", generation: 1 });
  s = run(s, as("c"), { type: "Hello", protocolVersion: 1, purpose: "", reportMode: "protocol" });
  s = run(s, user, { type: "AddMember", member: mem("A"), binding: { instanceId: instances.A, generation: 1 } });
  s = run(s, user, { type: "AddMember", member: mem("B"), binding: { instanceId: instances.B, generation: 1 } });
  s = run(s, as("c"), { type: "SubmitPlan", planId: "pl", plan: { objective: "o", steps: [
    { key: "x", memberId: "A", instruction: "i", completion: ["ok"] },
    { key: "y", memberId: "B", instruction: "i", completion: ["ok"] },
    { key: "z", memberId: "A", instruction: "i", completion: ["ok"] }] } });
  return run(s, user, { type: "StartRun", runId: "r", planId: "pl", version: 1, taskIds: ["tx", "ty", "tz"], auto, consent: { id: "k", source: "start-button" } });
}
const NOWMS = 1_000_000;
const ctx = (over = {}) => ({
  controlMode: "full", online: () => true, observed: () => ({ state: "idle", at: NOWMS }), held: () => false, busyElsewhere: () => false, now: NOWMS, ...over,
});
const task = (s, id) => s.tasks.find((t) => t.id === id);

test("an idle, online, free worker in full mode is deliverable", () => {
  const s = project();
  assert.deepEqual(verdict(s, task(s, "tx"), ctx()), { ok: true });
});

test("every check has its own reason, and the task rules come first", () => {
  const s = project();
  const t = task(s, "tx");
  const why = (over) => verdict(s, t, ctx(over)).reason;
  assert.equal(why({ controlMode: "readonly" }), "control-mode");
  assert.equal(why({ controlMode: "off" }), "control-mode");
  assert.equal(why({ online: () => false }), "offline");
  assert.equal(why({ busyElsewhere: () => true }), "other-project");
  assert.equal(why({ held: () => true }), "held");
  assert.equal(why({ observed: () => undefined }), "stale-observation");
  assert.equal(why({ observed: () => ({ state: "idle", at: NOWMS - OBSERVATION_MAX_AGE_MS - 1 }) }), "stale-observation");
  assert.equal(why({ observed: () => ({ state: "working", at: NOWMS }) }), "agent-busy");
  assert.equal(why({ observed: () => ({ state: "blocked", at: NOWMS }) }), "agent-blocked");
  assert.equal(why({ observed: () => ({ state: "unknown", at: NOWMS }) }), "agent-unknown");
  const paused = run(s, as("c"), { type: "PauseRun", runId: "r" });
  assert.equal(verdict(paused, task(paused, "tx"), ctx()).reason, "paused");
  assert.equal(verdict(s, task(s, "tz"), ctx()).ok, true, "on its own a second task of a free worker is fine; the pump picks one per member");
});

test("force skips busy, unknown, stale and hold, but never blocked, offline or control mode", () => {
  const s = project();
  const t = task(s, "tx");
  const f = (over) => verdict(s, t, ctx({ force: true, ...over }));
  assert.equal(f({ observed: () => ({ state: "working", at: NOWMS }) }).ok, true);
  assert.equal(f({ observed: () => ({ state: "unknown", at: 0 }) }).ok, true);
  assert.equal(f({ held: () => true }).ok, true);
  assert.equal(f({ observed: () => ({ state: "blocked", at: NOWMS }) }).reason, "agent-blocked");
  assert.equal(f({ online: () => false }).reason, "offline");
  assert.equal(f({ controlMode: "readonly" }).reason, "control-mode");
  assert.equal(f({ busyElsewhere: () => true }).reason, "other-project");
});

test("the pump takes one task per member in run order and ignores runs without auto delivery", () => {
  const s = project();
  assert.deepEqual(nextDeliverable(s, ctx()).map((t) => t.id), ["tx", "ty"], "tz waits behind tx for the same member");
  assert.deepEqual(nextDeliverable(project(false), ctx()), [], "manual runs are never handed over by the pump");
  assert.deepEqual(nextDeliverable(s, ctx({ observed: (id) => (id === "A" ? { state: "working", at: NOWMS } : { state: "idle", at: NOWMS }) })).map((t) => t.id), ["ty"]);
});

test("the same agent in two projects is delivered to one at a time", () => {
  const a = project(true, { A: "shared", B: "ib" });
  const b = project(true, { A: "shared", B: "ib2" });
  const projects = [{ root: "/a", state: a }, { root: "/b", state: b }];
  assert.equal(busyElsewhere(projects, "/a", "shared"), false, "nothing is running yet");
  let started = run(a, user, { type: "PrepareDispatch", taskId: "tx", attemptId: "A1", effectId: "e" });
  const now = [{ root: "/a", state: started }, { root: "/b", state: b }];
  assert.equal(busyElsewhere(now, "/b", "shared"), true, "project B must wait while project A's task is in progress");
  assert.equal(busyElsewhere(now, "/a", "shared"), false, "a project is not blocked by itself");
  assert.equal(busyElsewhere(now, "/b", "ib2"), false);
  started = run(started, user, { type: "RecordInputStart", taskId: "tx", attemptId: "A1", effectId: "e" });
  started = run(started, user, { type: "RecordInputResult", taskId: "tx", attemptId: "A1", effectId: "e", outcome: "sent" });
  started = run(started, as("A"), { type: "ReceiveReport", taskId: "tx", report: { reportId: "R", attemptId: "A1", kind: "result", summary: "ok" } });
  assert.equal(busyElsewhere([{ root: "/a", state: started }, { root: "/b", state: b }], "/b", "shared"), false, "a result frees the agent for the other project");
});

test("manual hold: stays until the user leaves and the terminal is idle long enough", () => {
  const holds = new Map();
  holdInstance(holds, "i");
  assert.equal(isHeld(holds, "i"), true);
  assert.equal(tickHold(holds, "i", "idle", 0), false, "still at the terminal");
  leaveInstance(holds, "i", 1000);
  assert.equal(tickHold(holds, "i", "idle", 1000), false, "the idle countdown starts now");
  assert.equal(tickHold(holds, "i", "working", 5000), false, "activity resets it");
  assert.equal(tickHold(holds, "i", "idle", 6000), false);
  assert.equal(tickHold(holds, "i", "idle", 6000 + RELEASE_QUIET_MS - 1), false);
  assert.equal(tickHold(holds, "i", "idle", 6000 + RELEASE_QUIET_MS), true);
  assert.equal(isHeld(holds, "i"), false);
});

test("manual hold: unknown or blocked screens never release it, and the user can give it back at once", () => {
  const holds = new Map();
  holdInstance(holds, "i");
  leaveInstance(holds, "i", 0);
  for (const state of ["unknown", "blocked", undefined]) assert.equal(tickHold(holds, "i", state, 999_999), false);
  assert.equal(isHeld(holds, "i"), true);
  giveBack(holds, "i");
  assert.equal(isHeld(holds, "i"), false);
  assert.equal(tickHold(holds, "i", "idle", 1), false, "no hold, nothing to release");
  leaveInstance(holds, "other", 5);
  assert.equal(isHeld(holds, "other"), false, "leaving a terminal that was never held does nothing");
});
