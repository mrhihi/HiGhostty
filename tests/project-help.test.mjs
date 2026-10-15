import test from "node:test";
import assert from "node:assert/strict";
import { decide, reduce, emptyState } from "../src/projects.ts";
import { helpAskBody, helpAnswerBody, helpGetResult } from "../src/project-control.ts";
import { helpPrompt, helpAnswerPrompt, queuedHelps, queuedHelpAnswers } from "../src/project-prompts.ts";

const NOW = "2026-10-15T00:00:00.000Z";
const user = { kind: "user" };
const as = (id) => ({ kind: "member", memberId: id });
let n = 0;
const run = (s, actor, body) => decide(s, { actionId: `a${++n}`, actor, body }, NOW);
const apply = (s, actor, body) => {
  const r = run(s, actor, body);
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  return r.value.events.reduce(reduce, s);
};
const member = (id, role) => ({ id, role, name: id, purpose: "", purposeSource: "user", reportMode: "screen" });
const world = () => {
  let s = apply(emptyState(), user, { type: "CreateProject", config: { schemaVersion: 1, id: "p1", name: "Mail", coordinatorMemberId: "c1", createdAt: NOW }, coordinator: member("c1", "coordinator") });
  s = apply(s, user, { type: "AddMember", member: member("w1", "worker") });
  return apply(s, user, { type: "AddMember", member: member("w2", "worker") });
};

test("a worker asks, the coordinator answers, and each side's delivery is tracked separately", () => {
  let s = apply(world(), as("w1"), { type: "AskHelp", helpId: "h1", text: "要查資料庫，有人能幫忙嗎？" });
  assert.deepEqual(queuedHelps(s).map((h) => h.id), ["h1"]);
  s = apply(s, user, { type: "SetHelpDelivery", helpId: "h1", part: "ask", delivery: "sent" });
  assert.equal(queuedHelps(s).length, 0);
  s = apply(s, as("c1"), { type: "AnswerHelp", helpId: "h1", text: "找 w2" });
  assert.equal(s.helps[0].delivery, "replied");
  assert.deepEqual(queuedHelpAnswers(s).map((g) => [g.memberId, g.helps.map((h) => h.id)]), [["w1", ["h1"]]]);
  // a late "sent" for the request must not step `replied` back
  s = apply(s, user, { type: "SetHelpDelivery", helpId: "h1", part: "ask", delivery: "sent" });
  assert.equal(s.helps[0].delivery, "replied");
  s = apply(s, user, { type: "SetHelpDelivery", helpId: "h1", part: "answer", delivery: "sent" });
  assert.equal(queuedHelpAnswers(s).length, 0);
});

test("help rules: only workers ask, only the coordinator answers, once", () => {
  const s = world();
  assert.equal(run(s, as("c1"), { type: "AskHelp", helpId: "h", text: "x" }).error.code, "forbidden");
  assert.equal(run(s, user, { type: "AskHelp", helpId: "h", text: "x" }).error.code, "forbidden");
  assert.equal(run(s, as("w1"), { type: "AskHelp", helpId: "h", text: "  " }).error.code, "bad_args");
  const asked = apply(s, as("w1"), { type: "AskHelp", helpId: "h", text: "x" });
  assert.equal(run(asked, as("w2"), { type: "AskHelp", helpId: "h", text: "x" }).error.code, "already_exists");
  assert.equal(run(asked, as("w2"), { type: "AnswerHelp", helpId: "h", text: "y" }).error.code, "forbidden");
  assert.equal(run(asked, as("c1"), { type: "AnswerHelp", helpId: "nope", text: "y" }).error.code, "not_found");
  const answered = apply(asked, as("c1"), { type: "AnswerHelp", helpId: "h", text: "y" });
  assert.equal(run(answered, as("c1"), { type: "AnswerHelp", helpId: "h", text: "z" }).error.code, "invalid_state");
});

test("help command inputs are validated and help get is limited to the asker and the coordinator", () => {
  assert.ok(helpAskBody({ text: "hi" }, () => "gen").ok);
  assert.equal(helpAskBody({ text: "hi" }, () => "gen").body.helpId, "gen");
  assert.equal(helpAskBody({ text: "hi" }, () => "gen").actionId, "help:gen");
  assert.ok(!helpAskBody({ text: "" }, () => "g").ok);
  assert.ok(!helpAskBody({ text: "hi", extra: 1 }, () => "g").ok);
  assert.ok(!helpAnswerBody({ text: "hi" }).ok);
  assert.ok(helpAnswerBody({ helpId: "h", text: "hi" }).ok);
  let s = apply(world(), as("w1"), { type: "AskHelp", helpId: "h1", text: "need db" });
  s = apply(s, as("c1"), { type: "AnswerHelp", helpId: "h1", text: "ask w2" });
  const mine = helpGetResult(s, { id: "w1" }, "h1");
  assert.ok(mine.ok);
  assert.equal(mine.result.answer, "ask w2");
  assert.ok(helpGetResult(s, { id: "c1" }, "h1").ok);
  assert.equal(helpGetResult(s, { id: "w2" }, "h1").error.code, "not_found");
});

test("help prompts carry ids and commands, never the text", () => {
  const ask = helpPrompt("p1", [{ id: "h1", memberId: "w1" }]);
  assert.match(ask, /helpId: h1/);
  assert.match(ask, /project help get p1/);
  assert.match(ask, /project help answer p1 --json-stdin/);
  assert.match(helpAnswerPrompt("p1", [{ id: "h1" }]), /project help get p1 h1/);
});

test("a step can name a model; only plain model names are accepted", async () => {
  const { validatePlan } = await import("../src/project-tasks.ts");
  const members = [member("c1", "coordinator"), member("w1", "worker")];
  const plan = (model) => ({ objective: "x", steps: [{ key: "a", memberId: "w1", instruction: "do", completion: ["done"], ...(model === undefined ? {} : { model }) }] });
  const ok = validatePlan(plan("sonnet"), members);
  assert.ok(ok.ok && ok.value.steps[0].model === "sonnet");
  assert.ok(validatePlan(plan(undefined), members).ok);
  assert.ok(!validatePlan(plan("opus; rm -rf /"), members).ok);
});

test("only the user sets a member's default model, and it shows up in the project view", () => {
  let s = world();
  assert.ok(!run(s, as("w1"), { type: "SetMemberModel", memberId: "w1", model: "opus" }).ok);
  assert.ok(!run(s, user, { type: "SetMemberModel", memberId: "w1", model: "bad model" }).ok);
  s = apply(s, user, { type: "SetMemberModel", memberId: "w1", model: "haiku" });
  assert.equal(s.members.find((m) => m.id === "w1").model, "haiku");
  s = apply(s, user, { type: "SetMemberModel", memberId: "w1", model: "" });
  assert.equal(s.members.find((m) => m.id === "w1").model, undefined);
});

test("a worker's intro asks it to say the ask-first pledge after hello", async () => {
  const { introPrompt, ASK_FIRST_PLEDGE } = await import("../src/project-prompts.ts");
  assert.ok(introPrompt("p1", "Mail", member("w1", "worker")).includes(ASK_FIRST_PLEDGE));
  assert.ok(!introPrompt("p1", "Mail", member("c1", "coordinator")).includes(ASK_FIRST_PLEDGE));
});
