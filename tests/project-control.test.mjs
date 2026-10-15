import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv, authorize } from "../src/control.ts";
import { decide, reduce, emptyState } from "../src/projects.ts";
import { memberCandidates, surfaceForInstance, instanceKey, parseInput, helloBody, messageBody, callerMember, getResult, inboxResult, projectErrorReply, MAX_INPUT_BYTES } from "../src/project-control.ts";

const NOW = "2026-10-15T00:00:00.000Z";
const user = { kind: "user" };
let n = 0;
const apply = (s, actor, body) => {
  const r = decide(s, { actionId: `a${++n}`, actor, body }, NOW);
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  return r.value.events.reduce(reduce, s);
};
const coord = { id: "c1", role: "coordinator", name: "Lead", purpose: "", purposeSource: "user", reportMode: "protocol" };
const worker = { id: "w1", role: "worker", name: "W", purpose: "", purposeSource: "user", reportMode: "screen" };
const world = () => {
  let s = apply(emptyState(), user, { type: "CreateProject", config: { schemaVersion: 1, id: "p1", name: "Mail", coordinatorMemberId: "c1", createdAt: NOW }, coordinator: coord });
  s = apply(s, user, { type: "BindMember", memberId: "c1", instanceId: "tmux:hg-1", generation: 1 });
  return apply(s, user, { type: "AddMember", member: worker, binding: { instanceId: "surface:s9", generation: 1 } });
};

test("project commands parse and carry the right write flags", () => {
  const get = parseArgv(["project", "get", "p1"]);
  assert.ok(get.ok);
  assert.equal(get.parsed.args.projectId, "p1");
  assert.equal(authorize("readonly", get.parsed.op), null);
  const hello = parseArgv(["project", "hello", "p1", "--json-stdin"]);
  assert.ok(hello.ok);
  assert.equal(hello.parsed.flags["json-stdin"], true);
  assert.equal(authorize("readonly", hello.parsed.op).error.code, "forbidden");
  assert.equal(authorize("full", hello.parsed.op), null);
  assert.equal(parseArgv(["project", "get"]).ok, false, "projectId is required");
  assert.equal(parseArgv(["project", "inbox", "p1", "--after", "3"]).parsed.flags.after, 3);
});

test("instanceKey prefers the tmux session, which outlives the app", () => {
  assert.equal(instanceKey({ id: "s1", tmuxSession: "hg-1" }), "tmux:hg-1");
  assert.equal(instanceKey({ id: "s1" }), "surface:s1");
});

test("parseInput requires the flag, content, size and a JSON object", () => {
  const flag = { "json-stdin": true };
  assert.equal(parseInput("{}", {}).reply.error.code, "bad_args");
  assert.equal(parseInput("  ", flag).ok, false);
  assert.equal(parseInput(undefined, flag).ok, false);
  assert.equal(parseInput("{oops", flag).ok, false);
  assert.equal(parseInput("[1]", flag).ok, false);
  assert.equal(parseInput("null", flag).ok, false);
  assert.equal(parseInput(JSON.stringify({ t: "x".repeat(MAX_INPUT_BYTES) }), flag).ok, false);
  assert.deepEqual(parseInput('{"a": 1}', flag).value, { a: 1 });
});

test("helloBody validates fields and rejects unknown ones", () => {
  const ok = helloBody({ protocolVersion: 1, purpose: "整理", reportMode: "protocol", reportNeedsApproval: true });
  assert.equal(ok.body.type, "Hello");
  assert.equal(ok.body.reportNeedsApproval, true);
  for (const bad of [
    { protocolVersion: 2, purpose: "", reportMode: "protocol" },
    { protocolVersion: 1, purpose: 1, reportMode: "protocol" },
    { protocolVersion: 1, purpose: "", reportMode: "x" },
    { protocolVersion: 1, purpose: "", reportMode: "screen", reportNeedsApproval: "yes" },
    { protocolVersion: 1, purpose: "", reportMode: "screen", extra: 1 },
  ]) assert.equal(helloBody(bad).ok, false, JSON.stringify(bad));
});

test("messageBody keeps a given messageId and otherwise generates one", () => {
  assert.equal(messageBody({ text: "hi" }, () => "gen").body.messageId, "gen");
  assert.equal(messageBody({ text: "hi", messageId: "mine", inReplyTo: "m1" }, () => "gen").body.messageId, "mine");
  assert.equal(messageBody({ text: " " }, () => "g").ok, false);
  assert.equal(messageBody({ text: "x", inReplyTo: "" }, () => "g").ok, false);
  assert.equal(messageBody({ text: "x", bogus: 1 }, () => "g").ok, false);
});

test("callerMember maps an instance to its member only", () => {
  const s = world();
  assert.equal(callerMember(s, "tmux:hg-1").id, "c1");
  assert.equal(callerMember(s, "surface:s9").id, "w1");
  assert.equal(callerMember(s, "surface:other"), undefined);
  assert.equal(callerMember(s, undefined), undefined);
});

test("get result describes members without message bodies", () => {
  let s = world();
  s = apply(s, { kind: "member", memberId: "w1" }, { type: "Hello", protocolVersion: 1, purpose: "p", reportMode: "protocol" });
  s = apply(s, user, { type: "SendMessage", messageId: "m1", conversationId: "main", text: "secret body" });
  const r = getResult(s, 7);
  assert.equal(r.revision, 7);
  assert.equal(r.messages, 1);
  assert.deepEqual(r.members.map((m) => [m.id, m.bound, m.handshake]), [["c1", true, false], ["w1", true, true]]);
  assert.ok(!JSON.stringify(r).includes("secret body"));
});

test("inbox returns messages after a seq, with lastSeq to resume from", () => {
  let s = world();
  s = apply(s, user, { type: "SendMessage", messageId: "m1", conversationId: "main", text: "a" });
  s = apply(s, user, { type: "SendMessage", messageId: "m2", conversationId: "main", text: "b" });
  assert.deepEqual(inboxResult(s, "c1", undefined).messages.map((m) => m.messageId), ["m1", "m2"]);
  const later = inboxResult(s, "c1", 1);
  assert.deepEqual(later.messages.map((m) => m.messageId), ["m2"]);
  assert.equal(later.lastSeq, 2);
  assert.deepEqual(inboxResult(s, "c1", 2), { messages: [], lastSeq: 2 });
  assert.deepEqual(inboxResult(s, "w1", 0).messages, []);
});

test("project errors map onto ctl error codes", () => {
  assert.equal(projectErrorReply({ code: "forbidden", message: "x" }).error.code, "forbidden");
  assert.equal(projectErrorReply({ code: "instance_in_use", message: "x" }).error.code, "bad_args");
  assert.equal(projectErrorReply({ code: "needs_user_decision", message: "x" }).error.code, "needs_user_decision");
});

test("surfaceForInstance finds the terminal behind a key", () => {
  const list = [{ id: "s1" }, { id: "s2", tmuxSession: "hg-2" }];
  assert.equal(surfaceForInstance("surface:s1", list).id, "s1");
  assert.equal(surfaceForInstance("tmux:hg-2", list).id, "s2");
  assert.equal(surfaceForInstance("surface:s2", list), undefined, "a tmux surface is only known by its session");
  assert.equal(surfaceForInstance("tmux:gone", list), undefined);
});

test("only tmux tabs with a start command offer their first pane as a member", () => {
  const surfaces = new Map([
    ["a", { id: "a", tmuxSession: "hg-a" }], ["b", { id: "b", tmuxSession: "hg-b" }], ["c", { id: "c" }],
    ["d", { id: "d", tmuxSession: "hg-d", exited: true }], ["e", { id: "e", tmuxSession: "hg-e" }],
  ]);
  const tabs = [
    { command: "claude", tmux: true, leaves: ["a", "e"] },
    { tmux: true, leaves: ["b"] },
    { command: "claude", leaves: ["c"] },
    { command: "claude", tmux: true, leaves: ["d"] },
    { command: "  ", tmux: true, leaves: ["e"] },
    { command: "claude", tmux: true, leaves: ["gone"] },
  ];
  assert.deepEqual(memberCandidates(tabs, surfaces).map((s) => s.id), ["a"]);
});
