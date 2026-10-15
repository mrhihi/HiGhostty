import test from "node:test";
import assert from "node:assert/strict";
import { decide, reduce, replay, emptyState } from "../src/projects.ts";
import { validatePlan, eligibleTasks, queueReasonOf, buildTaskPayload, stalledTasks, blockedMembers, DEFAULT_STALL_MS } from "../src/project-tasks.ts";

let NOW = "2026-10-15T00:00:00.000Z";
const user = { kind: "user" };
const as = (memberId) => ({ kind: "member", memberId });
let n = 0;
const log = [];
function run(state, actor, body, id) {
  const r = decide(state, { actionId: id ?? `a${++n}`, actor, body }, NOW);
  assert.ok(r.ok, r.ok ? "" : `${r.error.code}: ${r.error.message}`);
  log.push(...r.value.events);
  return r.value.events.reduce(reduce, state);
}
const fail = (state, actor, body) => {
  const r = decide(state, { actionId: `a${++n}`, actor, body }, NOW);
  assert.ok(!r.ok, "expected failure");
  return r.error;
};
const mem = (id, role = "worker") => ({ id, role, name: id, purpose: "", purposeSource: "user", reportMode: "protocol" });

function world() {
  let s = run(emptyState(), user, { type: "CreateProject", config: { schemaVersion: 1, id: "p1", name: "Mail", coordinatorMemberId: "c", createdAt: NOW }, coordinator: mem("c", "coordinator") });
  s = run(s, user, { type: "BindMember", memberId: "c", instanceId: "i-c", generation: 1 });
  s = run(s, as("c"), { type: "Hello", protocolVersion: 1, purpose: "", reportMode: "protocol" });
  s = run(s, user, { type: "AddMember", member: mem("A"), binding: { instanceId: "i-a", generation: 1 } });
  s = run(s, user, { type: "AddMember", member: mem("B"), binding: { instanceId: "i-b", generation: 1 } });
  return s;
}
const PLAN = {
  objective: "整理來信並建立 Jira",
  steps: [
    { key: "collect", memberId: "A", instruction: "整理來信", completion: ["列出需求"] },
    { key: "jira", memberId: "B", instruction: "建立 Jira", dependsOn: ["collect"], completion: ["回報單號"], inputFrom: [{ stepKey: "collect", artifactNames: ["requirements"] }] },
  ],
};
function started() {
  let s = world();
  s = run(s, as("c"), { type: "SubmitPlan", planId: "pl", plan: PLAN });
  s = run(s, user, { type: "StartRun", runId: "r1", planId: "pl", version: 1, taskIds: ["t1", "t2"], consent: { id: "k1", source: "start-button" } });
  return s;
}
const task = (s, id) => s.tasks.find((t) => t.id === id);
// Deliver a task the way the host would: prepare → will-start → sent.
function deliver(s, taskId, attemptId, effectId = `e-${attemptId}`) {
  s = run(s, user, { type: "PrepareDispatch", taskId, attemptId, effectId });
  s = run(s, user, { type: "RecordInputStart", taskId, attemptId, effectId });
  return run(s, user, { type: "RecordInputResult", taskId, attemptId, effectId, outcome: "sent" });
}
const result = (reportId, attemptId, name = "requirements", text = '{"items":[1]}') =>
  ({ reportId, attemptId, kind: "result", summary: "done", artifacts: [{ name, mediaType: "application/json", text }] });
const report = (s, taskId, input) => run(s, as(task(s, taskId).memberId), { type: "ReceiveReport", taskId, report: input });

test("validatePlan reports every problem at once", () => {
  const members = [mem("c", "coordinator"), mem("A")];
  const bad = validatePlan({
    objective: " ", extra: 1,
    steps: [
      { key: "a", memberId: "A", instruction: "x", completion: [], dependsOn: ["a", "zzz"] },
      { key: "a", memberId: "nobody", instruction: "x", completion: ["ok"] },
      { key: "c1", memberId: "c", instruction: "x", completion: ["ok"], inputFrom: [{ stepKey: "a", artifactNames: [] }] },
    ],
  }, members);
  assert.ok(!bad.ok);
  const codes = bad.error.map((e) => e.code);
  for (const code of ["unknown_field", "empty_objective", "empty_completion", "self_dependency", "missing_dependency", "duplicate_key", "unknown_member", "coordinator_as_worker", "input_not_dependency"]) assert.ok(codes.includes(code), code);
});

test("validatePlan finds cycles, bad shapes and the step limit", () => {
  const members = [mem("A")];
  const step = (key, dependsOn) => ({ key, memberId: "A", instruction: "x", completion: ["ok"], dependsOn });
  const cycle = validatePlan({ objective: "o", steps: [step("a", ["b"]), step("b", ["c"]), step("c", ["a"])] }, members);
  assert.ok(!cycle.ok && cycle.error.some((e) => e.code === "cycle" && e.message.includes("→")));
  assert.ok(!validatePlan("x", members).ok);
  assert.ok(!validatePlan({ objective: "o", steps: [] }, members).ok);
  const many = validatePlan({ objective: "o", steps: Array.from({ length: 101 }, (_, i) => step(`s${i}`, [])) }, members);
  assert.ok(!many.ok && many.error.some((e) => e.code === "too_many_steps"));
  const fine = validatePlan({ objective: "o", steps: [step("a", []), step("b", ["a"])] }, members);
  assert.ok(fine.ok);
  assert.equal(fine.value.steps[1].dependsOn[0], "a");
});

test("SubmitPlan versions the plan, checks the base version, and rejects invalid plans with details", () => {
  let s = world();
  s = run(s, as("c"), { type: "SubmitPlan", planId: "pl", plan: PLAN });
  assert.deepEqual([s.plans[0].id, s.plans[0].version], ["pl", 1]);
  s = run(s, as("c"), { type: "SubmitPlan", planId: "other", plan: PLAN, basePlanVersion: 1 });
  assert.deepEqual([s.plans[1].id, s.plans[1].version], ["pl", 2], "versions stay under one plan id");
  assert.equal(fail(s, as("c"), { type: "SubmitPlan", planId: "x", plan: PLAN, basePlanVersion: 1 }).code, "revision_conflict");
  const invalid = fail(s, as("c"), { type: "SubmitPlan", planId: "x", plan: { objective: "" } });
  assert.equal(invalid.code, "invalid_plan");
  assert.ok(Array.isArray(invalid.details));
  assert.equal(fail(s, as("A"), { type: "SubmitPlan", planId: "x", plan: PLAN }).code, "forbidden");
});

test("StartRun lists blockers, needs the right consent source, and allows one run at a time", () => {
  let s = world();
  s = run(s, as("c"), { type: "SubmitPlan", planId: "pl", plan: PLAN });
  const start = (consent, actor = user, runId = "r1") => ({ type: "StartRun", runId, planId: "pl", version: 1, taskIds: [`${runId}a`, `${runId}b`], consent });
  assert.equal(fail(s, as("c"), start({ id: "k", source: "start-button" }, as("c"))).code, "forbidden");
  assert.equal(fail(s, as("c"), start({ id: "k", source: "user-message", sourceMessageId: "nope" }, as("c"))).code, "needs_user_decision");
  assert.equal(fail(s, user, { ...start({ id: "k", source: "start-button" }), taskIds: ["only-one"] }).code, "bad_args");

  let blocked = run(s, user, { type: "RemoveMember", memberId: "B" });
  blocked = run(blocked, user, { type: "AddMember", member: mem("B") });
  const e = fail(blocked, user, start({ id: "k", source: "start-button" }));
  assert.equal(e.code, "invalid_state");
  assert.ok(e.details.some((d) => d.includes("B")));

  let ok1 = run(s, user, { type: "SendMessage", messageId: "m1", conversationId: "main", text: "寫好計畫直接執行" });
  ok1 = run(ok1, as("c"), start({ id: "k1", source: "user-message", sourceMessageId: "m1" }, as("c")));
  assert.equal(ok1.consents[0].source, "user-message");
  assert.equal(fail(ok1, user, start({ id: "k2", source: "start-button" }, user, "r2")).code, "invalid_state");
});

test("StartRun needs the coordinator to have said hello", () => {
  let s = run(emptyState(), user, { type: "CreateProject", config: { schemaVersion: 1, id: "p", name: "P", coordinatorMemberId: "c", createdAt: NOW }, coordinator: mem("c", "coordinator") });
  s = run(s, user, { type: "AddMember", member: mem("A"), binding: { instanceId: "i-a", generation: 1 } });
  s = run(s, user, { type: "SubmitPlan", planId: "pl", plan: { objective: "o", steps: [{ key: "x", memberId: "A", instruction: "i", completion: ["ok"] }] } });
  const e = fail(s, user, { type: "StartRun", runId: "r", planId: "pl", version: 1, taskIds: ["t"], consent: { id: "k", source: "start-button" } });
  assert.ok(e.details.some((d) => d.includes("hello")));
});

test("run creates queued tasks; only dependency-free, free, bound ones are eligible", () => {
  const s = started();
  assert.deepEqual(s.tasks.map((t) => [t.id, t.status]), [["t1", "queued"], ["t2", "queued"]]);
  assert.deepEqual(eligibleTasks(s).map((t) => t.id), ["t1"]);
  assert.equal(queueReasonOf(s, task(s, "t2")), "dependency");
  const paused = run(s, as("c"), { type: "PauseRun", runId: "r1" });
  assert.equal(queueReasonOf(paused, task(paused, "t1")), "paused");
  assert.equal(fail(paused, user, { type: "PrepareDispatch", taskId: "t1", attemptId: "x", effectId: "e" }).code, "invalid_state");
  assert.equal(eligibleTasks(run(paused, user, { type: "ResumeRun", runId: "r1" })).length, 1);
  assert.equal(fail(s, user, { type: "ResumeRun", runId: "r1" }).code, "invalid_state");
});

test("Mail → Jira: result, accept with checks, then the downstream task gets the frozen input", () => {
  let s = started();
  s = deliver(s, "t1", "A1");
  assert.equal(task(s, "t1").status, "sent");
  assert.equal(fail(s, user, { type: "PrepareDispatch", taskId: "t2", attemptId: "B1", effectId: "e" }).code, "invalid_state", "t2 waits for t1");
  s = report(s, "t1", result("R1", "A1"));
  assert.equal(task(s, "t1").status, "result-ready");
  assert.equal(s.artifacts.length, 1);
  assert.equal(queueReasonOf(s, task(s, "t2")), "dependency", "result-ready is not accepted yet");

  assert.equal(fail(s, as("c"), { type: "AcceptResult", taskId: "t1", attemptId: "A1", checks: [] }).code, "bad_args");
  assert.equal(fail(s, as("c"), { type: "AcceptResult", taskId: "t1", attemptId: "A1", checks: [{ criterion: "列出需求", evidenceArtifactIds: ["bogus"] }] }).code, "bad_args");
  const evidence = task(s, "t1").resultArtifactIds;
  s = run(s, as("c"), { type: "AcceptResult", taskId: "t1", attemptId: "A1", checks: [{ criterion: "列出需求", evidenceArtifactIds: evidence }] });
  assert.equal(task(s, "t1").status, "completed");
  assert.deepEqual(eligibleTasks(s).map((t) => t.id), ["t2"]);

  s = deliver(s, "t2", "B1");
  const payload = buildTaskPayload(s, "t2");
  assert.equal(payload.inputs[0].artifacts[0].name, "requirements");
  assert.equal(payload.inputs[0].artifacts[0].text, '{"items":[1]}');
  assert.deepEqual(payload.inputs[0].missing, []);
  assert.equal(payload.attemptId, "B1");
  s = report(s, "t2", result("R2", "B1", "tickets", '{"ids":["J-1"]}'));
  s = run(s, user, { type: "AcceptResult", taskId: "t2", attemptId: "B1" });
  assert.equal(s.runs[0].status, "completed", "all tasks completed completes the run");
});

test("payload names inputs that are missing instead of guessing", () => {
  let s = started();
  s = deliver(s, "t1", "A1");
  s = report(s, "t1", result("R1", "A1", "other-name"));
  s = run(s, user, { type: "AcceptResult", taskId: "t1", attemptId: "A1" });
  const payload = buildTaskPayload(s, "t2");
  assert.deepEqual(payload.inputs[0].artifacts, []);
  assert.deepEqual(payload.inputs[0].missing, ["requirements"]);
});

test("one worker, one task at a time within a project", () => {
  let s = run(world(), as("c"), { type: "SubmitPlan", planId: "pl", plan: { objective: "o", steps: [
    { key: "x", memberId: "A", instruction: "i", completion: ["ok"] }, { key: "y", memberId: "A", instruction: "i", completion: ["ok"] }] } });
  s = run(s, user, { type: "StartRun", runId: "r", planId: "pl", version: 1, taskIds: ["tx", "ty"], consent: { id: "k", source: "start-button" } });
  s = deliver(s, "tx", "A1");
  assert.equal(queueReasonOf(s, task(s, "ty")), "busy");
  assert.equal(fail(s, user, { type: "PrepareDispatch", taskId: "ty", attemptId: "A2", effectId: "e2" }).code, "invalid_state");
  s = report(s, "tx", result("R1", "A1"));
  assert.equal(queueReasonOf(s, task(s, "ty")), undefined, "a result releases the worker");
});

test("reports: only the assigned member, dedup by reportId, conflict on different content", () => {
  let s = deliver(started(), "t1", "A1");
  assert.equal(fail(s, as("B"), { type: "ReceiveReport", taskId: "t1", report: result("R1", "A1") }).code, "forbidden");
  assert.equal(fail(s, user, { type: "ReceiveReport", taskId: "t1", report: result("R1", "A1") }).code, "forbidden");
  const progress = { reportId: "P1", attemptId: "A1", kind: "progress", summary: "halfway" };
  s = report(s, "t1", progress);
  assert.equal(task(s, "t1").status, "running");
  const before = JSON.stringify(s);
  s = report(s, "t1", progress);
  assert.equal(JSON.stringify(s), before, "duplicate is a no-op");
  assert.equal(fail(s, as("A"), { type: "ReceiveReport", taskId: "t1", report: { ...progress, summary: "different" } }).code, "report_conflict");
  assert.equal(fail(s, as("A"), { type: "ReceiveReport", taskId: "t1", report: { ...progress, reportId: "P2", attemptId: "nope" } }).code, "stale_attempt");
});

test("report validation: kinds, question, artifacts and sizes", () => {
  const s = deliver(started(), "t1", "A1");
  const bad = (report) => fail(s, as("A"), { type: "ReceiveReport", taskId: "t1", report }).code;
  assert.equal(bad({ reportId: "", attemptId: "A1", kind: "progress", summary: "" }), "bad_args");
  assert.equal(bad({ reportId: "r", attemptId: "A1", kind: "weird", summary: "" }), "bad_args");
  assert.equal(bad({ reportId: "r", attemptId: "A1", kind: "needs-input", summary: "" }), "bad_args");
  assert.equal(bad({ reportId: "r", attemptId: "A1", kind: "result", summary: "x", artifacts: [{ name: "a", mediaType: "application/json", text: "{oops" }] }), "bad_args");
  assert.equal(bad({ reportId: "r", attemptId: "A1", kind: "result", summary: "x", artifacts: [{ name: "a", mediaType: "text/html", text: "x" }] }), "bad_args");
  assert.equal(bad({ reportId: "r", attemptId: "A1", kind: "result", summary: "x", artifacts: [{ name: "a", mediaType: "text/plain", text: "x".repeat(128 * 1024 + 1) }] }), "bad_args");
});

test("needs-input opens a question issue; progress or result closes it", () => {
  let s = deliver(started(), "t1", "A1");
  s = report(s, "t1", { reportId: "Q1", attemptId: "A1", kind: "needs-input", summary: "", question: "哪一天的信？" });
  assert.equal(task(s, "t1").status, "needs-input");
  assert.equal(s.issues.length, 1);
  assert.equal(s.issues[0].resolvedAt, undefined);
  s = report(s, "t1", { reportId: "P1", attemptId: "A1", kind: "progress", summary: "continuing" });
  assert.equal(task(s, "t1").status, "running");
  assert.ok(s.issues[0].resolvedAt);
});

test("a report before InputSent still advances; the late InputSent does not roll it back", () => {
  let s = started();
  s = run(s, user, { type: "PrepareDispatch", taskId: "t1", attemptId: "A1", effectId: "e1" });
  s = run(s, user, { type: "RecordInputStart", taskId: "t1", attemptId: "A1", effectId: "e1" });
  s = report(s, "t1", result("R1", "A1"));
  assert.equal(task(s, "t1").status, "result-ready");
  s = run(s, user, { type: "RecordInputResult", taskId: "t1", attemptId: "A1", effectId: "e1", outcome: "sent" });
  assert.equal(task(s, "t1").status, "result-ready");
});

test("a report with no InputWillStart is kept as unmatched and does not move the task", () => {
  let s = started();
  s = run(s, user, { type: "PrepareDispatch", taskId: "t1", attemptId: "A1", effectId: "e1" });
  s = report(s, "t1", result("R1", "A1"));
  assert.equal(task(s, "t1").status, "dispatching");
  assert.equal(s.reports[0].stale, "unmatched");
  assert.equal(s.artifacts.length, 0, "an unmatched report's artifacts are not stored as results");
});

test("input outcomes: not-sent returns to queued, unknown becomes uncertain and keeps the worker reserved", () => {
  let s = started();
  s = run(s, user, { type: "PrepareDispatch", taskId: "t1", attemptId: "A1", effectId: "e1" });
  s = run(s, user, { type: "RecordInputResult", taskId: "t1", attemptId: "A1", effectId: "e1", outcome: "not-sent" });
  assert.equal(task(s, "t1").status, "queued");
  assert.equal(task(s, "t1").attempt, undefined);
  s = run(s, user, { type: "PrepareDispatch", taskId: "t1", attemptId: "A2", effectId: "e2" });
  assert.deepEqual(task(s, "t1").attemptIds, ["A1", "A2"], "attempt history is kept");
  s = run(s, user, { type: "RecordInputStart", taskId: "t1", attemptId: "A2", effectId: "e2" });
  s = run(s, user, { type: "RecordInputResult", taskId: "t1", attemptId: "A2", effectId: "e2", outcome: "unknown" });
  assert.equal(task(s, "t1").status, "uncertain");
  assert.equal(fail(s, user, { type: "RetryTask", taskId: "t1" }).code, "invalid_state", "uncertain must be reconciled, not retried");
  assert.equal(fail(s, user, { type: "RecordInputResult", taskId: "t1", attemptId: "A1", effectId: "e1", outcome: "sent" }).code, "stale_attempt");
  const reconciled = run(s, user, { type: "ReconcileTask", taskId: "t1", attemptId: "A2", decision: "not-received" });
  assert.equal(task(reconciled, "t1").status, "queued");
  // A matching report resolves uncertainty by itself.
  const resolved = report(s, "t1", result("R1", "A2"));
  assert.equal(task(resolved, "t1").status, "result-ready");
});

test("no report means no state change: sent stays sent however long it is idle", () => {
  const s = deliver(started(), "t1", "A1");
  assert.equal(task(s, "t1").status, "sent");
  assert.equal(task(s, "t1").attempt.id, "A1");
});

test("a report from an old attempt is kept but never touches the new attempt", () => {
  let s = deliver(started(), "t1", "A1");
  s = report(s, "t1", { reportId: "F1", attemptId: "A1", kind: "failed", summary: "boom" });
  s = run(s, user, { type: "RetryTask", taskId: "t1" });
  s = deliver(s, "t1", "A2");
  s = report(s, "t1", result("LATE", "A1"));
  assert.equal(task(s, "t1").status, "sent", "the new attempt is untouched");
  assert.equal(s.reports.at(-1).stale, "old-attempt");
  assert.equal(s.artifacts.length, 0);
  assert.deepEqual(eligibleTasks(s), [], "and downstream is not started");
});

test("declined and failed are not retried automatically; retry is the user's call and can change member", () => {
  let s = deliver(started(), "t1", "A1");
  s = report(s, "t1", { reportId: "D1", attemptId: "A1", kind: "declined", summary: "no" });
  assert.equal(task(s, "t1").status, "declined");
  assert.equal(queueReasonOf(s, task(s, "t2")), "dependency", "downstream stays queued");
  assert.equal(fail(s, as("c"), { type: "RetryTask", taskId: "t1" }).code, "forbidden");
  assert.equal(fail(s, user, { type: "RetryTask", taskId: "t1", memberId: "c" }).code, "bad_args");
  s = run(s, user, { type: "RetryTask", taskId: "t1", memberId: "B" });
  assert.deepEqual([task(s, "t1").status, task(s, "t1").memberId], ["queued", "B"]);
});

test("cancel: queued cancels at once; running only records the request and keeps the worker reserved", () => {
  let s = started();
  s = run(s, user, { type: "RequestCancel", taskId: "t2" });
  assert.equal(task(s, "t2").status, "cancelled");
  s = deliver(s, "t1", "A1");
  s = run(s, user, { type: "RequestCancel", taskId: "t1" });
  assert.equal(task(s, "t1").status, "sent");
  assert.equal(task(s, "t1").cancelRequested, true);
  assert.equal(run(s, user, { type: "RequestCancel", taskId: "t1" }), s, "asking twice changes nothing");
  const done = report(s, "t1", { reportId: "C1", attemptId: "A1", kind: "cancelled", summary: "stopped" });
  assert.equal(task(done, "t1").status, "cancelled");
  const late = report(s, "t1", result("R1", "A1"));
  assert.equal(task(late, "t1").status, "result-ready", "a result that beat the cancel is kept");
  assert.equal(fail(done, user, { type: "RequestCancel", taskId: "t1" }).code, "invalid_state");
});

test("rework sends the task back with feedback and the previous result; the old attempt stays in history", () => {
  let s = deliver(started(), "t1", "A1");
  s = report(s, "t1", result("R1", "A1"));
  assert.equal(fail(s, as("c"), { type: "RequestRework", taskId: "t1", attemptId: "A1", feedback: " " }).code, "bad_args");
  assert.equal(fail(s, as("c"), { type: "RequestRework", taskId: "t1", attemptId: "OLD", feedback: "x" }).code, "stale_attempt");
  s = run(s, as("c"), { type: "RequestRework", taskId: "t1", attemptId: "A1", feedback: "漏了第三封" });
  assert.equal(task(s, "t1").status, "queued");
  const payload = buildTaskPayload(s, "t1");
  assert.equal(payload.rework.feedback, "漏了第三封");
  assert.equal(payload.rework.previousArtifacts.length, 1);
  s = deliver(s, "t1", "A2");
  s = report(s, "t1", result("R2", "A2", "requirements", '{"items":[1,2,3]}'));
  assert.equal(task(s, "t1").resultArtifactIds.length, 1);
  assert.ok(task(s, "t1").resultArtifactIds[0].includes("A2"), "the new result replaces the old as the task's result");
});

test("members with unfinished tasks cannot be removed", () => {
  const s = deliver(started(), "t1", "A1");
  assert.equal(fail(s, user, { type: "RemoveMember", memberId: "A" }).code, "invalid_state");
});

test("replaying every emitted event reproduces the final state", () => {
  log.length = 0;
  let state = started();
  state = deliver(state, "t1", "A1");
  state = report(state, "t1", { reportId: "Q1", attemptId: "A1", kind: "needs-input", summary: "", question: "?" });
  state = report(state, "t1", result("R1", "A1"));
  state = run(state, user, { type: "AcceptResult", taskId: "t1", attemptId: "A1" });
  assert.deepEqual(replay([...log]), state);
  assert.equal(new Set(log.map((e) => e.eventId)).size, log.length, "event ids are unique");
});

const at = (minutes) => new Date(Date.parse("2026-10-15T00:00:00.000Z") + minutes * 60_000).toISOString();

test("silence is noticed after the timeout but never changes the task", () => {
  NOW = at(0);
  let s = deliver(started(), "t1", "A1");
  assert.deepEqual(stalledTasks(s, Date.parse(at(9))), []);
  assert.deepEqual(stalledTasks(s, Date.parse(at(11))).map((t) => t.id), ["t1"]);
  assert.equal(task(s, "t1").status, "sent", "no state change from silence");
  // A report restarts the clock.
  NOW = at(11);
  s = report(s, "t1", { reportId: "P", attemptId: "A1", kind: "progress", summary: "still here" });
  assert.deepEqual(stalledTasks(s, Date.parse(at(12))), []);
  assert.deepEqual(stalledTasks(s, Date.parse(at(11) ) + DEFAULT_STALL_MS + 1).map((t) => t.id), ["t1"]);
  // A late report from an old attempt does not count as activity.
  NOW = at(0);
});

test("only in-progress tasks can be stalled; waiting for the user's answer is not silence", () => {
  NOW = at(0);
  let s = deliver(started(), "t1", "A1");
  s = report(s, "t1", { reportId: "Q", attemptId: "A1", kind: "needs-input", summary: "", question: "?" });
  assert.deepEqual(stalledTasks(s, Date.parse(at(600))), []);
  assert.deepEqual(stalledTasks(started(), Date.parse(at(600))), [], "queued tasks are not stalled");
});

test("blocked terminals are listed only for members that hold a task in progress", () => {
  NOW = at(0);
  const s = deliver(started(), "t1", "A1");
  const seen = { A: "blocked", B: "blocked", c: "blocked" };
  assert.deepEqual(blockedMembers(s, (id) => seen[id]), [{ memberId: "A", taskIds: ["t1"] }], "B and the coordinator have no task in progress");
  assert.deepEqual(blockedMembers(s, () => "idle"), []);
  assert.deepEqual(blockedMembers(s, () => undefined), []);
});

test("a silent task can be settled by the user without waiting for the worker", () => {
  NOW = at(0);
  const s = deliver(started(), "t1", "A1");
  assert.equal(task(run(s, user, { type: "ReconcileTask", taskId: "t1", attemptId: "A1", decision: "failed" }), "t1").status, "failed");
  assert.equal(task(run(s, user, { type: "ReconcileTask", taskId: "t1", attemptId: "A1", decision: "not-received" }), "t1").status, "queued");
  assert.equal(fail(s, user, { type: "ReconcileTask", taskId: "t1", attemptId: "OLD", decision: "failed" }).code, "invalid_state");
  NOW = "2026-10-15T00:00:00.000Z";
});

// ---- S2/S3 leftovers ----
const withReportMode = (s, id, reportMode) => ({ ...s, members: s.members.map((m) => (m.id === id ? { ...m, reportMode } : m)) });
const twoStep = (extraA = {}, extraB = {}) => ({
  objective: "o",
  steps: [
    { key: "collect", memberId: "A", instruction: "i", completion: ["ok"], ...extraA },
    { key: "jira", memberId: "B", instruction: "j", dependsOn: ["collect"], completion: ["ok"], ...extraB },
  ],
});

test("auto acceptance is refused before an external write and for workers that do not report by protocol", () => {
  const members = [mem("A"), mem("B")];
  const bad = validatePlan(twoStep({ acceptance: "auto-on-protocol-result" }, { externalWrite: true }), members);
  assert.ok(!bad.ok && bad.error.some((e) => e.code === "auto_before_external_write"));
  assert.ok(validatePlan(twoStep({ acceptance: "auto-on-protocol-result" }), members).ok, "fine when nothing downstream writes outside");
  assert.ok(validatePlan(twoStep({ acceptance: "user" }, { externalWrite: true }), members).ok);
  const screen = validatePlan(twoStep({ acceptance: "auto-on-protocol-result" }), [{ ...mem("A"), reportMode: "screen" }, mem("B")]);
  assert.ok(!screen.ok && screen.error.some((e) => e.code === "auto_needs_protocol"));
  assert.ok(!validatePlan(twoStep({ acceptance: "whenever" }), members).ok);
  // transitive: A(auto) → mid → B(external)
  const chain = validatePlan({ objective: "o", steps: [
    { key: "a", memberId: "A", instruction: "i", completion: ["ok"], acceptance: "auto-on-protocol-result" },
    { key: "m", memberId: "A", instruction: "i", completion: ["ok"], dependsOn: ["a"] },
    { key: "b", memberId: "B", instruction: "i", completion: ["ok"], dependsOn: ["m"], externalWrite: true }] }, members);
  assert.ok(!chain.ok && chain.error.some((e) => e.code === "auto_before_external_write"));
});

test("an auto-accept step completes on its protocol result and opens the next step; the run completes with the last", () => {
  let s = world();
  s = run(s, as("c"), { type: "SubmitPlan", planId: "pl", plan: twoStep({ acceptance: "auto-on-protocol-result" }, { inputFrom: [{ stepKey: "collect", artifactNames: ["requirements"] }] }) });
  s = run(s, user, { type: "StartRun", runId: "r1", planId: "pl", version: 1, taskIds: ["t1", "t2"], consent: { id: "k", source: "start-button" } });
  s = deliver(s, "t1", "A1");
  s = report(s, "t1", result("R1", "A1"));
  assert.equal(task(s, "t1").status, "completed");
  assert.equal(task(s, "t1").resultArtifactIds.length, 1, "its result is kept for the next step");
  assert.deepEqual(eligibleTasks(s).map((t) => t.id), ["t2"]);
  assert.equal(buildTaskPayload(s, "t2").inputs[0].artifacts.length, 1);
  // A worker that cancels before reporting is not auto-accepted.
  let c = world();
  c = run(c, as("c"), { type: "SubmitPlan", planId: "pl", plan: twoStep({ acceptance: "auto-on-protocol-result" }) });
  c = run(c, user, { type: "StartRun", runId: "r1", planId: "pl", version: 1, taskIds: ["t1", "t2"], consent: { id: "k", source: "start-button" } });
  c = deliver(c, "t1", "A1");
  c = run(c, user, { type: "RequestCancel", taskId: "t1" });
  c = report(c, "t1", result("R1", "A1"));
  assert.equal(task(c, "t1").status, "result-ready", "a result that arrives after a cancel request waits for a person");
});

test("a worker that reports by screen cannot be auto-accepted even if the plan asked for it", () => {
  let s = world();
  s = run(s, as("c"), { type: "SubmitPlan", planId: "pl", plan: twoStep({ acceptance: "auto-on-protocol-result" }) });
  s = run(s, user, { type: "StartRun", runId: "r1", planId: "pl", version: 1, taskIds: ["t1", "t2"], consent: { id: "k", source: "start-button" } });
  s = deliver(withReportMode(s, "A", "screen"), "t1", "A1");
  s = report(s, "t1", result("R1", "A1"));
  assert.equal(task(s, "t1").status, "result-ready");
});

test("screen results need the user's confirmation before they count", () => {
  let s = deliver(withReportMode(started(), "A", "screen"), "t1", "A1");
  const obs = { type: "SubmitObservedResult", taskId: "t1", attemptId: "A1", summary: "畫面上看到完成", artifacts: [{ name: "requirements", mediaType: "text/plain", text: "x" }] };
  assert.equal(fail(s, user, obs).code, "forbidden");
  assert.equal(fail(deliver(started(), "t1", "A1"), as("c"), obs).code, "invalid_state", "protocol workers must report themselves");
  s = run(s, as("c"), obs);
  assert.equal(task(s, "t1").status, "sent", "nothing moves until the user confirms");
  assert.equal(task(s, "t1").observed.summary, "畫面上看到完成");
  assert.equal(s.artifacts[0].source, "screen");
  assert.equal(fail(s, as("c"), { type: "ConfirmObservedResult", taskId: "t1", attemptId: "A1" }).code, "forbidden");
  assert.equal(fail(s, user, { type: "ConfirmObservedResult", taskId: "t1", attemptId: "OLD" }).code, "stale_attempt");
  s = run(s, user, { type: "ConfirmObservedResult", taskId: "t1", attemptId: "A1" });
  assert.equal(task(s, "t1").status, "result-ready");
  assert.equal(task(s, "t1").observed, undefined);
  assert.equal(buildTaskPayload(s, "t1").stepKey, "collect");
  s = run(s, user, { type: "AcceptResult", taskId: "t1", attemptId: "A1" });
  assert.deepEqual(eligibleTasks(s).map((t) => t.id), ["t2"]);
});

test("closing a run records what was left; busy or awaiting-acceptance tasks block it", () => {
  let s = started();
  s = deliver(s, "t1", "A1");
  assert.equal(fail(s, user, { type: "CloseRun", runId: "r1" }).code, "invalid_state");
  s = report(s, "t1", { reportId: "F", attemptId: "A1", kind: "failed", summary: "no" });
  assert.equal(fail(s, as("c"), { type: "CloseRun", runId: "r1" }).code, "forbidden");
  s = run(s, user, { type: "CloseRun", runId: "r1" });
  assert.equal(s.runs[0].status, "closed");
  assert.deepEqual(s.runs[0].unfinished, ["t1", "t2"]);
  assert.equal(queueReasonOf(s, task(s, "t2")), "closed");
  assert.equal(fail(s, user, { type: "RetryTask", taskId: "t1" }).code, "invalid_state");
  assert.equal(fail(s, user, { type: "CloseRun", runId: "r1" }).code, "invalid_state");
  assert.ok(run(s, user, { type: "SubmitPlan", planId: "x", plan: PLAN }), "a new plan can be started after closing");
});

test("auto delivery is a per-run switch only the user flips", () => {
  let s = started();
  assert.equal(s.runs[0].auto, false);
  assert.equal(fail(s, as("c"), { type: "SetRunAuto", runId: "r1", auto: true }).code, "forbidden");
  s = run(s, user, { type: "SetRunAuto", runId: "r1", auto: true });
  assert.equal(s.runs[0].auto, true);
  assert.equal(run(s, user, { type: "SetRunAuto", runId: "r1", auto: true }), s, "no change, no event");
  let auto = run(world(), as("c"), { type: "SubmitPlan", planId: "pl", plan: PLAN });
  auto = run(auto, user, { type: "StartRun", runId: "r", planId: "pl", version: 1, taskIds: ["a", "b"], auto: true, consent: { id: "k", source: "start-button" } });
  assert.equal(auto.runs[0].auto, true);
});

test("recovery after a restart: unstarted hand-overs go back to the queue, started ones become uncertain, sent ones stay", () => {
  let s = run(world(), as("c"), { type: "SubmitPlan", planId: "pl", plan: { objective: "o", steps: [
    { key: "x", memberId: "A", instruction: "i", completion: ["ok"] }, { key: "y", memberId: "B", instruction: "i", completion: ["ok"] }] } });
  s = run(s, user, { type: "StartRun", runId: "r", planId: "pl", version: 1, taskIds: ["tx", "ty"], consent: { id: "k", source: "start-button" } });
  s = run(s, user, { type: "PrepareDispatch", taskId: "tx", attemptId: "AX", effectId: "ex" });
  s = run(s, user, { type: "PrepareDispatch", taskId: "ty", attemptId: "AY", effectId: "ey" });
  s = run(s, user, { type: "RecordInputStart", taskId: "ty", attemptId: "AY", effectId: "ey" });
  assert.equal(fail(s, as("c"), { type: "RecoverTasks" }).code, "forbidden");
  s = run(s, user, { type: "RecoverTasks" });
  assert.deepEqual([task(s, "tx").status, task(s, "tx").attempt], ["queued", undefined]);
  assert.equal(task(s, "ty").status, "uncertain", "never re-sent on its own");
  assert.deepEqual(task(s, "tx").attemptIds, ["AX"], "history is kept");
  const sent = deliver(started(), "t1", "A1");
  assert.equal(run(sent, user, { type: "RecoverTasks" }), sent, "sent tasks are left alone");
});
