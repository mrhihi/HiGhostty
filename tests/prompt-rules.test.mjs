import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRules, DEFAULT_AGENTS, formatRuleError } from "../src/prompt-rules.ts";
import { createTranslator } from "../src/i18n.ts";
import { loadBuiltin } from "./i18n-helper.mjs";
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

test("scope, not and working are validated; bad values fall back", () => {
  const bad = (rule) => buildRules(builtin, JSON.stringify({ rules: [{ id: "x", kind: "input", label: "X", pattern: "a", ...rule }] }));
  assert.ok(bad({ scope: "nowhere" }).errors.length > 0);
  assert.ok(bad({ not: "a" }).errors.length > 0);
  assert.ok(bad({ not: ["("] }).errors.length > 0);
  assert.equal(bad({ scope: "after-rule", not: ["b"] }).errors.length, 0);
  assert.ok(buildRules(builtin, JSON.stringify({ working: ["["] })).errors.length > 0);
  const merged = buildRules(builtin, JSON.stringify({ working: ["building"] }));
  assert.equal(merged.errors.length, 0);
  assert.ok(merged.rules.working.length >= 2);
});

test("rule errors are structured, flag a broken user file, and format per language", () => {
  const ok = buildRules(builtin, JSON.stringify({ rules: [] }));
  assert.equal(ok.userBroken, false);
  const broken = buildRules(builtin, JSON.stringify({ rules: [{ id: "x", kind: "nope", label: "l", pattern: "a" }] }));
  assert.equal(broken.userBroken, true);
  assert.equal(broken.errors.length, 1);
  const [error] = broken.errors;
  assert.equal(error.source, "user");
  assert.equal(error.key, "rules.err.kind");
  assert.equal(error.params.index, 1);
  const en = loadBuiltin("en");
  const zh = loadBuiltin("zh-Hant");
  assert.match(formatRuleError(error, createTranslator(en, en, "en")), /^user rules rule #1 \(x\): kind must be one of/);
  assert.match(formatRuleError(error, createTranslator(zh, en, "zh-Hant")), /^使用者規則 規則 #1 \(x\)：kind 必須是/);
  assert.equal(buildRules("{bad").userBroken, false);
  assert.equal(buildRules("{bad").errors[0].source, "builtin");
  assert.equal(buildRules(builtin, "{bad").userBroken, true);
});

test("idle process rules: built-in ships dotnet build servers, user rules append, bad ones are reported", () => {
  const base = buildRules(builtin);
  assert.deepEqual(base.errors, []);
  assert.ok(base.rules.idle.some((item) => item.name === "VBCSCompiler"));
  assert.ok(base.rules.idle.some((item) => item.name === "dotnet" && item.args?.includes("nodeReuse:true")));
  const user = JSON.stringify({ idle: [{ name: "gradle", args: ["GradleDaemon"] }, { name: "VBCSCompiler" }] });
  const merged = buildRules(builtin, user);
  assert.deepEqual(merged.errors, []);
  assert.equal(merged.rules.idle.length, base.rules.idle.length + 1);
  assert.ok(merged.rules.idle.some((item) => item.name === "gradle"));
  for (const bad of [{ idle: {} }, { idle: [{}] }, { idle: [{ name: "x", args: [1] }] }, { idle: [{ name: "x", args: [""] }] }]) {
    const result = buildRules(builtin, JSON.stringify(bad));
    assert.equal(result.userBroken, true);
    assert.equal(result.errors[0].key, "rules.err.idle");
    assert.deepEqual(result.rules.idle, base.rules.idle);
  }
});
