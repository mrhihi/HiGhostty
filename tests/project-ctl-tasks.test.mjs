import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv, authorize } from "../src/control.ts";
import { decide, reduce, emptyState } from "../src/projects.ts";
import { observedBody, acceptBody, getResult, planSubmitBody, reworkBody, runStartBody, taskGetResult, taskReportBody, taskResultResult } from "../src/project-control.ts";

const NOW = "2026-10-15T00:00:00.000Z";
const user = { kind: "user" };
const as = (memberId) => ({ kind: "member", memberId });
let n = 0;
function run(state, actor, body, actionId) {
  const r = decide(state, { actionId: actionId ?? `a${++n}`, actor, body }, NOW);
  assert.ok(r.ok, r.ok ? "" : `${r.error.code}: ${r.error.message}`);
  return r.value.events.reduce(reduce, state);
}
const mem = (id, role = "worker") => ({ id, role, name: id, purpose: "", purposeSource: "user", reportMode: "protocol" });
const ids = (() => { let i = 0; return () => `id${++i}`; })();
const PLAN = { objective: "o", steps: [
  { key: "collect", memberId: "A", instruction: "i", completion: ["列出需求"] },
  { key: "jira", memberId: "B", instruction: "j", dependsOn: ["collect"], completion: ["單號"], inputFrom: [{ stepKey: "collect", artifactNames: ["requirements"] }] }] };

function world() {
  let s = run(emptyState(), user, { type: "CreateProject", config: { schemaVersion: 1, id: "p", name: "P", coordinatorMemberId: "c", createdAt: NOW }, coordinator: mem("c", "coordinator") });
  s = run(s, user, { type: "BindMember", memberId: "c", instanceId: "ic", generation: 1 });
  s = run(s, as("c"), { type: "Hello", protocolVersion: 1, purpose: "", reportMode: "protocol" });
  s = run(s, user, { type: "AddMember", member: mem("A"), binding: { instanceId: "ia", generation: 1 } });
  return run(s, user, { type: "AddMember", member: mem("B"), binding: { instanceId: "ib", generation: 1 } });
}

test("the project task commands exist with the right write flags", () => {
  const cases = [["project plan submit", true], ["project run start", true], ["project run pause", true], ["project task get", false],
    ["project task result", false], ["project task report", true], ["project task observed", true], ["project task accept", true], ["project task rework", true]];
  for (const [name, write] of cases) {
    const argv = [...name.split(" "), "p", ...(name.startsWith("project task") ? ["t1"] : []), ...(["project plan submit", "project run start", "project task report", "project task accept", "project task rework", "project task observed"].includes(name) ? ["--json-stdin"] : [])];
    const parsed = parseArgv(argv);
    assert.ok(parsed.ok, `${name}: ${parsed.ok ? "" : parsed.reply.error.message}`);
    assert.equal(parsed.parsed.op.name, name);
    assert.equal(parsed.parsed.op.write, write, name);
    if (write) assert.equal(authorize("readonly", parsed.parsed.op).error.code, "forbidden");
  }
  assert.equal(parseArgv(["project", "task", "get", "p"]).ok, false, "taskId is required");
});

test("plan submit body validates the envelope and leaves the plan to the rules", () => {
  assert.equal(planSubmitBody({}, ids).ok, false);
  assert.equal(planSubmitBody({ plan: {}, extra: 1 }, ids).ok, false);
  assert.equal(planSubmitBody({ plan: {}, basePlanVersion: -1 }, ids).ok, false);
  const ok = planSubmitBody({ plan: PLAN, basePlanVersion: 0, actionId: "mine" }, ids);
  assert.equal(ok.body.type, "SubmitPlan");
  assert.equal(ok.actionId, "mine");
});

test("run start needs a user message id and defaults to the latest plan", () => {
  let s = run(world(), as("c"), { type: "SubmitPlan", planId: "pl", plan: PLAN });
  assert.equal(runStartBody(s, {}, ids).ok, false);
  assert.equal(runStartBody(s, { instructionMessageId: "m1", version: 9 }, ids).ok, false);
  assert.equal(runStartBody(s, { instructionMessageId: "m1", planId: "other" }, ids).ok, false);
  assert.equal(runStartBody(world(), { instructionMessageId: "m1" }, ids).ok, false, "no plan yet");
  const built = runStartBody(s, { instructionMessageId: "m1" }, ids);
  assert.equal(built.body.version, 1);
  assert.equal(built.body.taskIds.length, 2);
  assert.deepEqual([built.body.consent.source, built.body.consent.sourceMessageId], ["user-message", "m1"]);
  // Without a recorded user message the rules ask the user to press Start.
  const r = decide(s, { actionId: "x", actor: as("c"), body: built.body }, NOW);
  assert.ok(!r.ok && r.error.code === "needs_user_decision");
  s = run(s, user, { type: "SendMessage", messageId: "m1", conversationId: "main", text: "直接執行" });
  assert.ok(decide(s, { actionId: "y", actor: as("c"), body: built.body }, NOW).ok);
});

test("task report body is strict, and the same report maps to one actionId", () => {
  const good = { reportId: "R1", attemptId: "A1", kind: "result", summary: "ok", artifacts: [{ name: "x", mediaType: "text/plain", text: "t" }] };
  const a = taskReportBody("t1", good);
  const b = taskReportBody("t1", good);
  assert.equal(a.actionId, b.actionId);
  assert.notEqual(a.actionId, taskReportBody("t1", { ...good, reportId: "R2" }).actionId);
  for (const bad of [{ ...good, reportId: "" }, { ...good, attemptId: undefined }, { ...good, kind: "done" }, { ...good, summary: 3 }, { ...good, extra: 1 },
    { ...good, artifacts: "x" }, { ...good, artifacts: [{ name: "x" }] }, { ...good, artifacts: [{ name: "x", mediaType: "text/plain", text: "t", more: 1 }] }])
    assert.equal(taskReportBody("t1", bad).ok, false, JSON.stringify(bad).slice(0, 60));
  assert.equal(taskReportBody("t1", { reportId: "R", attemptId: "A", kind: "progress" }).body.report.summary, "", "summary is optional");
});

test("accept and rework bodies", () => {
  assert.equal(acceptBody("t", { attemptId: "A", checks: [{ criterion: "c", evidenceArtifactIds: ["a"] }] }).body.checks.length, 1);
  assert.equal(acceptBody("t", { checks: [] }).ok, false);
  assert.equal(acceptBody("t", { attemptId: "A", checks: [{ criterion: "c", evidenceArtifactIds: [1] }] }).ok, false);
  assert.equal(reworkBody("t", { attemptId: "A", feedback: "  " }).ok, false);
  assert.equal(reworkBody("t", { attemptId: "A", feedback: "fix" }).body.type, "RequestRework");
});

function inFlight() {
  let s = run(world(), as("c"), { type: "SubmitPlan", planId: "pl", plan: PLAN });
  s = run(s, user, { type: "StartRun", runId: "r1", planId: "pl", version: 1, taskIds: ["t1", "t2"], consent: { id: "k", source: "start-button" } });
  s = run(s, user, { type: "PrepareDispatch", taskId: "t1", attemptId: "A1", effectId: "e1" });
  s = run(s, user, { type: "RecordInputStart", taskId: "t1", attemptId: "A1", effectId: "e1" });
  return run(s, user, { type: "RecordInputResult", taskId: "t1", attemptId: "A1", effectId: "e1", outcome: "sent" });
}

test("task get is limited to the assigned member", () => {
  const s = inFlight();
  const mine = taskGetResult(s, "A", "t1");
  assert.ok(mine.ok);
  assert.equal(mine.result.attemptId, "A1");
  assert.equal(taskGetResult(s, "B", "t1").error.code, "forbidden");
  assert.equal(taskGetResult(s, "c", "t1").error.code, "forbidden", "even the coordinator uses task result instead");
  assert.equal(taskGetResult(s, "A", "nope").error.code, "not_found");
  assert.ok(!JSON.stringify(taskGetResult(s, "B", "t1")).includes("整理"), "nothing leaks on refusal");
});

test("task result shows artifacts, completion and open questions to the coordinator", () => {
  let s = inFlight();
  s = run(s, as("A"), { type: "ReceiveReport", taskId: "t1", report: { reportId: "Q", attemptId: "A1", kind: "needs-input", summary: "", question: "哪天？" } });
  let r = taskResultResult(s, "t1").result;
  assert.deepEqual(r.openQuestions.map((q) => q.text), ["哪天？"]);
  s = run(s, as("A"), { type: "ReceiveReport", taskId: "t1", report: { reportId: "R", attemptId: "A1", kind: "result", summary: "ok", artifacts: [{ name: "requirements", mediaType: "application/json", text: "{}" }] } });
  r = taskResultResult(s, "t1").result;
  assert.equal(r.status, "result-ready");
  assert.deepEqual(r.completion, ["列出需求"]);
  assert.equal(r.resultArtifacts[0].name, "requirements");
  assert.equal(r.openQuestions.length, 0);
  assert.equal(taskResultResult(s, "zzz").error.code, "not_found");
});

test("project get now reports the plan and run progress", () => {
  const s = inFlight();
  const g = getResult(s, 12);
  assert.deepEqual(g.plan, { id: "pl", latestVersion: 1 });
  assert.equal(g.run.status, "running");
  assert.deepEqual(g.run.tasks.map((t) => [t.id, t.status, t.waitingFor]), [["t1", "sent", undefined], ["t2", "queued", "dependency"]]);
  assert.equal(getResult(world(), 1).run, null);
});

test("observed body is strict", () => {
  assert.equal(observedBody("t", { attemptId: "A", summary: "done" }).body.type, "SubmitObservedResult");
  assert.equal(observedBody("t", { summary: "x" }).ok, false);
  assert.equal(observedBody("t", { attemptId: "A", summary: " " }).ok, false);
  assert.equal(observedBody("t", { attemptId: "A", summary: "x", extra: 1 }).ok, false);
  assert.equal(observedBody("t", { attemptId: "A", summary: "x", artifacts: [{ name: "n" }] }).ok, false);
});

test("run start accepts a helpId instead of a user message, never both", () => {
  const s = run(world(), as("c"), { type: "SubmitPlan", planId: "pl", plan: PLAN });
  assert.equal(runStartBody(s, { instructionMessageId: "m1", helpId: "h1" }, ids).ok, false);
  const built = runStartBody(s, { helpId: "h1" }, ids);
  assert.deepEqual([built.body.consent.source, built.body.consent.sourceHelpId], ["help-request", "h1"]);
  // A helpId that no worker asked is refused; a real one lets the coordinator start without the user.
  assert.equal(decide(s, { actionId: "x", actor: as("c"), body: built.body }, NOW).error.code, "not_found");
  const asked = run(s, as("A"), { type: "AskHelp", helpId: "h1", text: "我查不了 Jira" });
  const started = run(asked, as("c"), built.body);
  assert.equal(started.consents[0].source, "help-request");
});
