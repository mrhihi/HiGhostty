import test from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/projects.ts";
import { actionItems, emptyMarks, unseen, pruneMarks } from "../src/project-attention.ts";

const base = () => ({
  ...emptyState(),
  config: { schemaVersion: 1, id: "p1", name: "P", coordinatorMemberId: "c", createdAt: "x" },
  members: [{ id: "c", role: "coordinator", name: "C" }, { id: "w", role: "worker", name: "Mail" }],
});
const plan = (acceptance) => ({ id: "pl", version: 1, title: "T", objective: "o", scope: "", steps: [{ key: "s", memberId: "w", title: "Step", instruction: "", dependsOn: [], completion: ["x"], inputFrom: [], acceptance }] });
const task = (status, extra = {}) => ({ id: "t1", runId: "r1", stepKey: "s", planVersion: 1, memberId: "w", status, attemptIds: ["a1"], attempt: { id: "a1" }, cancelRequested: false, resultArtifactIds: [], ...extra });

test("no project, no items", () => assert.deepEqual(actionItems(emptyState()), []));

test("an unstarted plan asks the user to start; a run clears it", () => {
  const s = { ...base(), plans: [plan()] };
  assert.equal(actionItems(s)[0].kind, "start-plan");
  const running = { ...s, runs: [{ id: "r1", planId: "pl", planVersion: 1, status: "running", taskIds: [] }] };
  assert.deepEqual(actionItems(running), []);
});

test("open question shows only while its task waits for input", () => {
  const issue = { id: "i1", taskId: "t1", memberId: "w", kind: "question", text: "which?" };
  const s = { ...base(), plans: [plan()], runs: [{ id: "r1", planId: "pl", planVersion: 1, status: "running", taskIds: ["t1"] }], tasks: [task("needs-input")], issues: [issue] };
  const [item] = actionItems(s);
  assert.equal(item.kind, "question");
  assert.equal(item.id, "issue:i1");
  assert.equal(actionItems({ ...s, tasks: [task("cancelled")] }).length, 0);
  assert.equal(actionItems({ ...s, issues: [{ ...issue, resolvedAt: "x" }] }).length, 0);
});

test("only user-accepted results need the user; coordinator ones do not", () => {
  const mk = (a) => ({ ...base(), plans: [plan(a)], runs: [{ id: "r1", planId: "pl", planVersion: 1, status: "running", taskIds: ["t1"] }], tasks: [task("result-ready")] });
  assert.equal(actionItems(mk("user"))[0].kind, "review-result");
  assert.equal(actionItems(mk("coordinator")).length, 0);
});

test("a terminal block merges with the structured question for the same task", () => {
  const issue = { id: "i1", taskId: "t1", memberId: "w", kind: "question", text: "q" };
  const s = { ...base(), plans: [plan()], runs: [{ id: "r1", planId: "pl", planVersion: 1, status: "running", taskIds: ["t1"] }], tasks: [task("needs-input")], issues: [issue] };
  assert.equal(actionItems(s, { blocked: [{ memberId: "w", taskIds: ["t1"] }] }).length, 1);
  const other = actionItems(s, { blocked: [{ memberId: "w", taskIds: [] }] });
  assert.deepEqual(other.map((i) => i.kind), ["terminal-blocked", "question"]);
});

test("seen and snoozed quiet a badge but never remove the item; prune forgets gone items", () => {
  const s = { ...base(), plans: [plan()] };
  const items = actionItems(s);
  const marks = emptyMarks();
  marks.seen.add(items[0].id);
  assert.equal(unseen(items, marks, 0).length, 0);
  assert.equal(actionItems(s).length, 1);
  marks.snoozed.set("gone", 10);
  pruneMarks(marks, items);
  assert.equal(marks.snoozed.size, 0);
  assert.equal(marks.seen.size, 1);
});

test("stored seen marks are read defensively", async () => {
  const { parseSeen } = await import("../src/project-attention.ts");
  assert.deepEqual(parseSeen('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseSeen('["a",1,null]'), ["a"]);
  assert.deepEqual(parseSeen("not json"), []);
  assert.deepEqual(parseSeen('{"a":1}'), []);
  assert.deepEqual(parseSeen(null), []);
});

test("the banner shows the most pressing unseen item and counts the rest", async () => {
  const { bannerOf } = await import("../src/project-attention.ts");
  const e = (id, kind) => ({ item: { id, kind } });
  const entries = [e("a", "start-plan"), e("b", "question"), e("c", "review-result")];
  const marks = emptyMarks();
  assert.deepEqual([bannerOf(entries, marks, 0).first.item.id, bannerOf(entries, marks, 0).more], ["b", 2]);
  marks.seen.add("b");
  assert.deepEqual([bannerOf(entries, marks, 0).first.item.id, bannerOf(entries, marks, 0).more], ["c", 1]);
  marks.snoozed.set("c", 100);
  assert.equal(bannerOf(entries, marks, 50).first.item.id, "a");
  assert.equal(bannerOf(entries, marks, 100).first.item.id, "c", "a snooze ends");
  assert.deepEqual(bannerOf([], marks, 0), { first: undefined, more: 0 });
});

test("stored snooze times are read defensively and expired ones dropped", async () => {
  const { parseSnoozed } = await import("../src/project-attention.ts");
  assert.deepEqual([...parseSnoozed('{"a":200,"b":50,"c":"x","d":null}', 100)], [["a", 200]]);
  assert.equal(parseSnoozed("nope", 0).size, 0);
  assert.equal(parseSnoozed('["a"]', 0).size, 0);
  assert.equal(parseSnoozed(null, 0).size, 0);
});
