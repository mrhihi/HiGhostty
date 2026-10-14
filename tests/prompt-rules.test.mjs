import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRules, DEFAULT_AGENTS } from "../src/prompt-rules.ts";
import { recognizePrompt } from "../src/attention.ts";

const builtin = readFileSync(new URL("../src/prompt-rules.json", import.meta.url), "utf8");

test("the shipped rules file is valid", () => {
  const { rules, errors, userRules } = buildRules(builtin);
  assert.deepEqual(errors, []);
  assert.equal(userRules, 0);
  assert.ok(rules.rules.length > 0);
  assert.ok(rules.agents.includes("claude"));
});

test("user rules come first and can add agents and footers", () => {
  const user = JSON.stringify({
    agents: ["myagent"],
    footers: ["building\\.\\.\\."],
    rules: [{ id: "mine", kind: "input", label: "我的規則", scope: "last", pattern: "ready\\?$", flags: "i" }],
  });
  const { rules, errors, userRules } = buildRules(builtin, user);
  assert.deepEqual(errors, []);
  assert.equal(userRules, 1);
  assert.equal(rules.rules[0].id, "mine");
  assert.ok(rules.agents.includes("myagent") && rules.agents.includes("claude"));
  assert.equal(recognizePrompt(["Are you ready?"], rules).label, "我的規則");
  assert.equal(recognizePrompt(["Are you ready?", "building..."], rules), null);
});

test("a user rule with a built-in id replaces it; disable removes it", () => {
  const replaced = buildRules(builtin, JSON.stringify({ rules: [{ id: "yesno", kind: "yesno", label: "自訂確認", scope: "tail", pattern: "\\(ok\\?\\)" }] }));
  assert.equal(replaced.rules.rules.filter((rule) => rule.id === "yesno").length, 1);
  assert.equal(recognizePrompt(["Go on (ok?)"], replaced.rules).label, "自訂確認");
  const disabled = buildRules(builtin, JSON.stringify({ disable: ["ask"] }));
  assert.equal(recognizePrompt(["What name?"], disabled.rules), null);
});

test("a broken user file is ignored with a reason", () => {
  const base = buildRules(builtin).rules.rules.length;
  for (const bad of [
    "{not json",
    JSON.stringify({ rules: [{ id: "x", kind: "nope", label: "l", pattern: "a" }] }),
    JSON.stringify({ rules: [{ id: "x", kind: "menu", label: "l", pattern: "(" }] }),
    JSON.stringify({ rules: [{ id: "x", kind: "menu", label: "l" }] }),
    JSON.stringify({ rules: [{ id: "x", kind: "menu", label: "l", pattern: "a" }, { id: "x", kind: "menu", label: "l", pattern: "b" }] }),
    JSON.stringify({ agents: ["("] }),
    "[]",
  ]) {
    const result = buildRules(builtin, bad);
    assert.ok(result.errors.length > 0, bad);
    assert.equal(result.userRules, 0);
    assert.equal(result.rules.rules.length, base);
  }
});

test("blank or missing user file is fine; a broken built-in falls back", () => {
  assert.deepEqual(buildRules(builtin, "  ").errors, []);
  const broken = buildRules("{oops");
  assert.ok(broken.errors.length > 0);
  assert.deepEqual(broken.rules.agents, DEFAULT_AGENTS);
});
