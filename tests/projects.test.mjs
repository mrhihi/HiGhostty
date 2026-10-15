import test from "node:test";
import assert from "node:assert/strict";
import { decide, reduce, replay, emptyState, inboxFor, coordinatorOf, memberForInstance } from "../src/projects.ts";

const NOW = "2026-10-15T00:00:00.000Z";
const user = { kind: "user" };
const as = (memberId) => ({ kind: "member", memberId });
let n = 0;
const act = (actor, body) => ({ actionId: `a${++n}`, actor, body });

const coord = { id: "c1", role: "coordinator", name: "Lead", purpose: "", purposeSource: "user", reportMode: "protocol" };
const worker = (id, extra = {}) => ({ id, role: "worker", name: `W-${id}`, purpose: "", purposeSource: "user", reportMode: "screen", ...extra });

// Apply an action, asserting success, and return the next state.
function run(state, actor, body) {
  const r = decide(state, act(actor, body), NOW);
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  return r.value.events.reduce(reduce, state);
}
const fail = (state, actor, body) => {
  const r = decide(state, act(actor, body), NOW);
  assert.ok(!r.ok, "expected failure");
  return r.error;
};

const created = () =>
  run(emptyState(), user, {
    type: "CreateProject",
    config: { schemaVersion: 1, id: "p1", name: "  Mail  ", coordinatorMemberId: "c1", createdAt: NOW },
    coordinator: coord,
  });

test("CreateProject trims name, adds coordinator, and cannot repeat", () => {
  const s = created();
  assert.equal(s.config.name, "Mail");
  assert.equal(coordinatorOf(s).id, "c1");
  assert.equal(fail(s, user, { type: "CreateProject", config: s.config, coordinator: coord }).code, "already_exists");
});

test("CreateProject rejects blank name and mismatched coordinator", () => {
  const body = (name, cid) => ({ type: "CreateProject", config: { schemaVersion: 1, id: "p", name, coordinatorMemberId: cid, createdAt: NOW }, coordinator: coord });
  assert.equal(fail(emptyState(), user, body("  ", "c1")).code, "bad_args");
  assert.equal(fail(emptyState(), user, body("x", "other")).code, "bad_args");
  assert.equal(fail(emptyState(), as("c1"), body("x", "c1")).code, "forbidden");
});

test("actions before creation are not_found", () => {
  assert.equal(fail(emptyState(), user, { type: "RenameProject", name: "x" }).code, "not_found");
});

test("AddMember with binding is atomic and one instance maps to one member", () => {
  let s = created();
  s = run(s, user, { type: "AddMember", member: worker("w1"), binding: { instanceId: "i1", generation: 1 } });
  assert.equal(s.bindings.w1.instanceId, "i1");
  assert.equal(s.bindings.w1.bindingRevision, 1);
  assert.equal(memberForInstance(s, "i1").id, "w1");
  assert.equal(fail(s, user, { type: "AddMember", member: worker("w2"), binding: { instanceId: "i1", generation: 1 } }).code, "instance_in_use");
  assert.equal(s.members.length, 2, "failed add leaves state untouched");
  assert.equal(fail(s, user, { type: "AddMember", member: worker("w1") }).code, "already_exists");
  assert.equal(fail(s, user, { type: "AddMember", member: { ...coord, id: "c2" } }).code, "bad_args");
});

test("rebinding bumps bindingRevision and clears the old handshake", () => {
  let s = created();
  s = run(s, user, { type: "AddMember", member: worker("w1"), binding: { instanceId: "i1", generation: 1 } });
  s = run(s, as("w1"), { type: "Hello", purpose: "整理信件", reportMode: "protocol", protocolVersion: 1 });
  assert.ok(s.handshakes.w1);
  s = run(s, user, { type: "BindMember", memberId: "w1", instanceId: "i2", generation: 1 });
  assert.equal(s.bindings.w1.bindingRevision, 2);
  assert.equal(s.handshakes.w1, undefined);
});

test("RemoveMember drops binding; coordinator cannot be removed", () => {
  let s = created();
  s = run(s, user, { type: "AddMember", member: worker("w1"), binding: { instanceId: "i1", generation: 1 } });
  assert.equal(fail(s, user, { type: "RemoveMember", memberId: "c1" }).code, "bad_args");
  s = run(s, user, { type: "RemoveMember", memberId: "w1" });
  assert.equal(s.bindings.w1, undefined);
  assert.equal(memberForInstance(s, "i1"), undefined);
});

test("hello records handshake, reportNeedsApproval and fills agent purpose", () => {
  let s = created();
  s = run(s, user, { type: "AddMember", member: worker("w1") });
  s = run(s, as("w1"), { type: "Hello", purpose: "整理信件", reportMode: "protocol", reportNeedsApproval: true, protocolVersion: 1 });
  assert.equal(s.handshakes.w1.reportNeedsApproval, true);
  assert.equal(s.members.find((m) => m.id === "w1").reportMode, "protocol");
  assert.deepEqual(
    [s.members.find((m) => m.id === "w1").purpose, s.members.find((m) => m.id === "w1").purposeSource],
    ["整理信件", "agent"],
  );
});

test("hello never overwrites a purpose the user wrote", () => {
  let s = created();
  s = run(s, user, { type: "AddMember", member: worker("w1", { purpose: "我寫的", purposeSource: "user" }) });
  s = run(s, as("w1"), { type: "Hello", purpose: "agent 自述", reportMode: "protocol", protocolVersion: 1 });
  assert.equal(s.members.find((m) => m.id === "w1").purpose, "我寫的");
});

test("hello is rejected for users, strangers, bad version or mode", () => {
  const s = run(created(), user, { type: "AddMember", member: worker("w1") });
  const hello = { type: "Hello", purpose: "", reportMode: "protocol", protocolVersion: 1 };
  assert.equal(fail(s, user, hello).code, "forbidden");
  assert.equal(fail(s, as("nobody"), hello).code, "not_found");
  assert.equal(fail(s, as("w1"), { ...hello, protocolVersion: 2 }).code, "bad_args");
  assert.equal(fail(s, as("w1"), { ...hello, reportMode: "x" }).code, "bad_args");
});

test("UpdatePurpose: user edits any member, agent only its own", () => {
  const s = run(created(), user, { type: "AddMember", member: worker("w1") });
  run(s, user, { type: "UpdatePurpose", memberId: "w1", purpose: "x", source: "user" });
  run(s, as("w1"), { type: "UpdatePurpose", memberId: "w1", purpose: "x", source: "agent" });
  assert.equal(fail(s, as("c1"), { type: "UpdatePurpose", memberId: "w1", purpose: "x", source: "agent" }).code, "forbidden");
  assert.equal(fail(s, as("w1"), { type: "UpdatePurpose", memberId: "w1", purpose: "x", source: "user" }).code, "forbidden");
});

test("conversation: user message queues, coordinator reply settles it and inbox is seq-based", () => {
  let s = created();
  s = run(s, user, { type: "SendMessage", messageId: "m1", conversationId: "main", text: " 你好 " });
  s = run(s, user, { type: "SendMessage", messageId: "m2", conversationId: "main", text: "第二則" });
  assert.deepEqual(inboxFor(s, "c1").map((m) => m.id), ["m1", "m2"]);
  assert.deepEqual(inboxFor(s, "c1", 1).map((m) => m.id), ["m2"]);
  assert.deepEqual(inboxFor(s, "w1"), [], "only the coordinator has an inbox");
  assert.equal(s.messages[0].text, "你好");
  assert.equal(s.messages[0].delivery, "queued");

  s = run(s, as("c1"), { type: "CoordinatorMessage", messageId: "r1", inReplyTo: "m1", text: "收到" });
  assert.equal(s.messages.find((m) => m.id === "m1").delivery, "replied");
  assert.equal(s.messages.find((m) => m.id === "r1").author, "coordinator");
  assert.equal(inboxFor(s, "c1").length, 2, "replying does not remove inbox history; delivery state does the settling");
});

test("a late delivery update cannot step a replied message back", () => {
  let s = created();
  s = run(s, user, { type: "SendMessage", messageId: "m1", conversationId: "main", text: "hi" });
  s = run(s, as("c1"), { type: "CoordinatorMessage", messageId: "r1", inReplyTo: "m1", text: "ok" });
  s = run(s, user, { type: "SetMessageDelivery", messageId: "m1", delivery: "sent" });
  assert.equal(s.messages.find((m) => m.id === "m1").delivery, "replied");
});

test("conversation guards", () => {
  let s = created();
  s = run(s, user, { type: "AddMember", member: worker("w1") });
  s = run(s, user, { type: "SendMessage", messageId: "m1", conversationId: "main", text: "hi" });
  assert.equal(fail(s, user, { type: "SendMessage", messageId: "m1", conversationId: "main", text: "dup" }).code, "already_exists");
  assert.equal(fail(s, user, { type: "SendMessage", messageId: "m9", conversationId: "main", text: "   " }).code, "bad_args");
  assert.equal(fail(s, as("c1"), { type: "SendMessage", messageId: "m9", conversationId: "main", text: "x" }).code, "forbidden");
  assert.equal(fail(s, as("w1"), { type: "CoordinatorMessage", messageId: "r1", text: "x" }).code, "forbidden");
  assert.equal(fail(s, as("c1"), { type: "CoordinatorMessage", messageId: "r1", inReplyTo: "nope", text: "x" }).code, "not_found");
  assert.equal(fail(s, as("c1"), { type: "CoordinatorMessage", messageId: "r1", text: "x".repeat(20_001) }).code, "bad_args");
});

test("replay of the emitted events reproduces the same state", () => {
  const events = [];
  let s = emptyState();
  const go = (actor, body) => {
    const r = decide(s, act(actor, body), NOW);
    assert.ok(r.ok);
    events.push(...r.value.events);
    s = r.value.events.reduce(reduce, s);
  };
  go(user, { type: "CreateProject", config: { schemaVersion: 1, id: "p1", name: "A", coordinatorMemberId: "c1", createdAt: NOW }, coordinator: coord });
  go(user, { type: "AddMember", member: worker("w1"), binding: { instanceId: "i1", generation: 1 } });
  go(user, { type: "SendMessage", messageId: "m1", conversationId: "main", text: "hi" });
  go(user, { type: "RenameProject", name: "B" });
  assert.deepEqual(replay(events), s);
  assert.equal(new Set(events.map((e) => e.eventId)).size, events.length, "event ids are unique");
});
