import test from "node:test";
import assert from "node:assert/strict";
import { introPrompt, messagePrompt, queuedBatch, memberStatus, MAX_BATCH } from "../src/project-prompts.ts";
import { decide, reduce, emptyState } from "../src/projects.ts";

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
