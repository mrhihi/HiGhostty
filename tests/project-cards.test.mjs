import test from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/projects.ts";
import { memberActivity, runProgress } from "../src/project-cards.ts";

const step = (key) => ({ key, memberId: "w", title: `T-${key}`, instruction: "", dependsOn: [], completion: ["x"], inputFrom: [] });
const state = (tasks) => ({
  ...emptyState(),
  plans: [{ id: "pl", version: 1, title: "", objective: "", scope: "", steps: [step("a"), step("b")] }],
  runs: [{ id: "r1", planId: "pl", planVersion: 1, status: "running", taskIds: [], consentId: "" }],
  tasks: tasks.map(([id, key, status]) => ({ id, runId: "r1", stepKey: key, planVersion: 1, memberId: "w", status, attemptIds: [], cancelRequested: false, resultArtifactIds: [] })),
});

test("no active task is idle", () => assert.deepEqual(memberActivity(state([["t1", "a", "queued"], ["t2", "b", "completed"]]), "w"), { activity: "idle" }));
test("a running task is working and names the step", () => assert.deepEqual(memberActivity(state([["t1", "a", "running"]]), "w"), { activity: "working", title: "T-a", taskId: "t1" }));
test("a question outranks other activity", () => assert.equal(memberActivity(state([["t1", "a", "running"], ["t2", "b", "needs-input"]]), "w").activity, "needs-input"));
test("result-ready shows as review; another member is untouched", () => {
  const s = state([["t1", "a", "result-ready"]]);
  assert.equal(memberActivity(s, "w").activity, "review");
  assert.equal(memberActivity(s, "other").activity, "idle");
});
test("progress counts completed tasks of the latest run", () => {
  assert.deepEqual(runProgress(state([["t1", "a", "completed"], ["t2", "b", "running"]])), { done: 1, total: 2 });
  assert.equal(runProgress(emptyState()), undefined);
});

import { ownedTerminals } from "../src/project-cards.ts";
test("a project owns its coordinator and live work sessions only", () => {
  const s = {
    ...state([["t1", "a", "running"]]),
    members: [{ id: "c", role: "coordinator", name: "C", favoriteId: "fav1" }, { id: "w", role: "worker", name: "Mail" }],
    bindings: { c: { instanceId: "tmux:hg-c" }, w: { instanceId: "tmux:personal" } },
    executions: [
      { id: "x1", memberId: "w", taskId: "t1", attemptId: "A", instanceId: "tmux:hg-w1", status: "live" },
      { id: "x2", memberId: "w", taskId: "t0", attemptId: "A", instanceId: "tmux:hg-w0", status: "ended" },
    ],
  };
  assert.deepEqual(ownedTerminals(s).map((o) => [o.kind, o.instanceId]), [["coordinator", "tmux:hg-c"], ["work", "tmux:hg-w1"]]);
  assert.equal(ownedTerminals(s)[0].favoriteId, "fav1");
  assert.equal(ownedTerminals(s)[1].title, "T-a");
  assert.deepEqual(ownedTerminals(emptyState()), []);
});
