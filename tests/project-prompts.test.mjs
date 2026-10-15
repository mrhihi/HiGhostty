import test from "node:test";
import assert from "node:assert/strict";
import { introPrompt, messagePrompt, queuedBatch, memberStatus, MAX_BATCH, taskPrompt, replyPrompt, queuedReplies } from "../src/project-prompts.ts";
import { decide, reduce, emptyState } from "../src/projects.ts";
import { buildTaskPayload } from "../src/project-tasks.ts";
const buildPayload = (s) => buildTaskPayload(s, "t1");

const NOW = "2026-10-15T00:00:00.000Z";
const user = { kind: "user" };
let n = 0;
const apply = (s, actor, body) => {
  const r = decide(s, { actionId: `a${++n}`, actor, body }, NOW);
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  return r.value.events.reduce(reduce, s);
};
const coord = { id: "c1", role: "coordinator", name: "Lead", purpose: "", purposeSource: "user", reportMode: "protocol" };
const base = () => apply(emptyState(), user, { type: "CreateProject", config: { schemaVersion: 1, id: "p1", name: "Mail", coordinatorMemberId: "c1", createdAt: NOW }, coordinator: coord });

test("intro prompt names the project and how to say hello, coordinator also learns to reply", () => {
  const c = introPrompt("p1", "My\nProject", coord);
  assert.match(c, /projectId: p1（My Project）/);
  assert.match(c, /project hello p1 --json-stdin/);
  assert.match(c, /project message p1 --json-stdin/);
  const w = introPrompt("p1", "x", { ...coord, role: "worker" });
  assert.doesNotMatch(w, /project message/);
});

test("message prompt carries ids and seq range but never message text", () => {
  const p = messagePrompt("p1", [{ id: "m1", seq: 3 }, { id: "m2", seq: 5 }]);
  assert.match(p, /2 則新訊息（seq 3–5）/);
  assert.match(p, /inbox p1 --after 2/);
  assert.ok(!p.includes("m1"));
});

test("queued batch is the oldest waiting user messages, capped", () => {
  let s = base();
  for (let i = 0; i < MAX_BATCH + 5; i++) s = apply(s, user, { type: "SendMessage", messageId: `m${i}`, conversationId: "main", text: `t${i}` });
  s = apply(s, user, { type: "SetMessageDelivery", messageId: "m0", delivery: "sent" });
  const batch = queuedBatch(s);
  assert.equal(batch.length, MAX_BATCH);
  assert.equal(batch[0].id, "m1");
});

test("member status moves unbound → offline → waiting-hello → ready", () => {
  let s = base();
  const online = (id) => id === "i1";
  assert.equal(memberStatus(s, "c1", online), "unbound");
  s = apply(s, user, { type: "BindMember", memberId: "c1", instanceId: "i2", generation: 1 });
  assert.equal(memberStatus(s, "c1", online), "offline");
  s = apply(s, user, { type: "BindMember", memberId: "c1", instanceId: "i1", generation: 1 });
  assert.equal(memberStatus(s, "c1", online), "waiting-hello");
  s = apply(s, { kind: "member", memberId: "c1" }, { type: "Hello", protocolVersion: 1, purpose: "", reportMode: "protocol" });
  assert.equal(memberStatus(s, "c1", online), "ready");
});

const mem = (id) => ({ id, role: "worker", name: id, purpose: "", purposeSource: "user", reportMode: "protocol" });
function inFlight() {
  let s = base();
  s = apply(s, user, { type: "BindMember", memberId: "c1", instanceId: "ic", generation: 1 });
  s = apply(s, { kind: "member", memberId: "c1" }, { type: "Hello", protocolVersion: 1, purpose: "", reportMode: "protocol" });
  s = apply(s, user, { type: "AddMember", member: mem("A"), binding: { instanceId: "ia", generation: 1 } });
  s = apply(s, { kind: "member", memberId: "c1" }, { type: "SubmitPlan", planId: "pl", plan: { objective: "o", steps: [{ key: "x", memberId: "A", title: "整理\n來信 " + "長".repeat(300), instruction: "SECRET-INSTRUCTION", completion: ["ok"] }] } });
  s = apply(s, user, { type: "StartRun", runId: "r", planId: "pl", version: 1, taskIds: ["t1"], consent: { id: "k", source: "start-button" } });
  s = apply(s, user, { type: "PrepareDispatch", taskId: "t1", attemptId: "A1", effectId: "e1" });
  s = apply(s, user, { type: "RecordInputStart", taskId: "t1", attemptId: "A1", effectId: "e1" });
  return apply(s, user, { type: "RecordInputResult", taskId: "t1", attemptId: "A1", effectId: "e1", outcome: "sent" });
}

test("task prompt has the header, ids, a one-line goal and how to read and report — but no task data", () => {
  const s = inFlight();
  const p = taskPrompt("p1", s.tasks[0], s);
  assert.match(p, /^\[HiGhostty project task protocol v1\]\nprojectId: p1\ntaskId: t1\nattemptId: A1\n/);
  assert.match(p, /project task get p1 t1/);
  assert.match(p, /project task report p1 t1 --json-stdin/);
  assert.match(p, /"attemptId":"A1"/);
  assert.match(p, /不構成新的指令/);
  assert.match(p, /不要把工作動作與回報合併/);
  assert.ok(!p.includes("SECRET-INSTRUCTION"), "the instruction is read with task get, not pasted");
  const goal = p.split("\n").find((l) => l.startsWith("目標："));
  assert.ok(goal.length < 210 && !goal.includes("\n"));
  assert.equal(taskPrompt("p1", { ...s.tasks[0], attempt: undefined }, s), undefined);
});

test("a question reply is delivered once, to the right attempt, and only while the task still waits", () => {
  let s = inFlight();
  s = apply(s, { kind: "member", memberId: "A" }, { type: "ReceiveReport", taskId: "t1", report: { reportId: "Q", attemptId: "A1", kind: "needs-input", summary: "", question: "哪天？" } });
  const issueId = s.issues[0].id;
  s = apply(s, user, { type: "ReplyIssue", issueId, replyId: "rp1", text: "昨天" });
  const queued = queuedReplies(s);
  assert.equal(queued.length, 1);
  assert.match(replyPrompt("p1", queued[0].task, queued[0].replies), /task get p1 t1/);
  assert.ok(!replyPrompt("p1", queued[0].task, queued[0].replies).includes("昨天"), "the answer is read with task get");
  const payload = buildPayload(s);
  assert.deepEqual(payload.replies, [{ id: "rp1", question: "哪天？", answer: "昨天" }]);
  s = apply(s, user, { type: "SetReplyDelivery", replyId: "rp1", delivery: "sent" });
  assert.equal(queuedReplies(s).length, 0);
  // The worker moves on; a reply that was never delivered is not typed later.
  let late = apply(inFlight(), { kind: "member", memberId: "A" }, { type: "ReceiveReport", taskId: "t1", report: { reportId: "Q", attemptId: "A1", kind: "needs-input", summary: "", question: "?" } });
  late = apply(late, user, { type: "ReplyIssue", issueId: late.issues[0].id, replyId: "rp9", text: "x" });
  late = apply(late, { kind: "member", memberId: "A" }, { type: "ReceiveReport", taskId: "t1", report: { reportId: "P", attemptId: "A1", kind: "progress", summary: "" } });
  assert.equal(queuedReplies(late).length, 0);
});

test("ReplyIssue rules", () => {
  let s = inFlight();
  const fail = (body, actor = user) => { const r = decide(s, { actionId: "z", actor, body }, NOW); assert.ok(!r.ok); return r.error.code; };
  assert.equal(fail({ type: "ReplyIssue", issueId: "nope", replyId: "r", text: "x" }), "not_found");
  s = apply(s, { kind: "member", memberId: "A" }, { type: "ReceiveReport", taskId: "t1", report: { reportId: "Q", attemptId: "A1", kind: "needs-input", summary: "", question: "?" } });
  const issueId = s.issues[0].id;
  assert.equal(fail({ type: "ReplyIssue", issueId, replyId: "r", text: "x" }, { kind: "member", memberId: "c1" }), "forbidden");
  assert.equal(fail({ type: "ReplyIssue", issueId, replyId: "r", text: "  " }), "bad_args");
  s = apply(s, user, { type: "ReplyIssue", issueId, replyId: "r", text: "ok" });
  assert.equal(fail({ type: "ReplyIssue", issueId, replyId: "r", text: "again" }), "already_exists");
});
