import test from "node:test";
import assert from "node:assert/strict";
import { AI_TOOLS, composeLaunch, parseLaunch, validModel } from "../src/launch.ts";

const claude = AI_TOOLS.find((tool) => tool.id === "claude");
const gemini = AI_TOOLS.find((tool) => tool.id === "gemini");

test("compose builds program, model and extra arguments", () => {
  assert.equal(composeLaunch(claude, "", ""), "claude");
  assert.equal(composeLaunch(claude, "opus", "--resume"), "claude --model opus --resume");
  assert.equal(composeLaunch(claude, "bad model; rm", "-p x"), "claude -p x");
});

test("parse reads the stored command back, otherwise it is custom", () => {
  assert.deepEqual(parseLaunch("claude --model opus --resume"), { tool: claude, model: "opus", extra: "--resume" });
  assert.deepEqual(parseLaunch("gemini -m gemini-2.5-pro"), { tool: gemini, model: "gemini-2.5-pro", extra: "" });
  assert.deepEqual(parseLaunch("claude --model=sonnet"), { tool: claude, model: "sonnet", extra: "" });
  assert.deepEqual(parseLaunch("claude --resume"), { tool: claude, model: "", extra: "--resume" });
  assert.equal(parseLaunch("claudex"), undefined);
  assert.equal(parseLaunch("FOO=1 claude"), undefined);
  assert.equal(parseLaunch("/usr/local/bin/claude"), undefined);
  assert.equal(parseLaunch(""), undefined);
});

test("composed commands read back the same", () => {
  for (const tool of AI_TOOLS) for (const model of ["", tool.models[0], "custom-1.2"]) {
    const line = composeLaunch(tool, model, "--flag a");
    assert.equal(composeLaunch(parseLaunch(line).tool, parseLaunch(line).model, parseLaunch(line).extra), line);
  }
});

test("copy on select is a Claude-only --settings flag that reads back", () => {
  assert.equal(composeLaunch(claude, "opus", "--resume", false), `claude --settings '{"copyOnSelect":false}' --model opus --resume`);
  assert.equal(composeLaunch(claude, "", "", true), `claude --settings '{"copyOnSelect":true}'`);
  assert.equal(composeLaunch(gemini, "", "", false), "gemini");
  for (const on of [true, false]) {
    const line = composeLaunch(claude, "opus", "--resume", on);
    assert.deepEqual(parseLaunch(line), { tool: claude, model: "opus", extra: "--resume", copyOnSelect: on });
  }
  assert.deepEqual(parseLaunch(`claude --settings '{"copyOnSelect":false}'`), { tool: claude, model: "", extra: "", copyOnSelect: false });
});

test("model names are plain identifiers", () => {
  assert.ok(validModel("gpt-5-codex") && validModel("claude-sonnet-4.5") && validModel("a/b:c"));
  assert.ok(!validModel("a b") && !validModel("$(x)") && !validModel("-x") && !validModel(""));
});

import { joinCommand, splitCommand } from "../src/launch.ts";
test("a custom command splits into program and arguments and joins back", () => {
  assert.deepEqual(splitCommand("htop -d 5"), { program: "htop", args: "-d 5" });
  assert.deepEqual(splitCommand("FOO=1 BAR=x npm run dev"), { program: "FOO=1 BAR=x npm", args: "run dev" });
  assert.deepEqual(splitCommand("lazygit"), { program: "lazygit", args: "" });
  assert.deepEqual(splitCommand(""), { program: "", args: "" });
  assert.equal(joinCommand("htop", "-d 5"), "htop -d 5");
  assert.equal(joinCommand(" ", " -x"), "-x");
});

import { DEFAULT_TOOLS, normalizeOpeners, normalizePresets, normalizeTools, presetCommand, validApp } from "../src/launch.ts";

test("presets build commands and drop invalid entries", () => {
  const presets = normalizePresets([
    { id: "a", name: "Opus", tool: "claude", model: "opus", extra: " --resume " },
    { id: "a", name: "dup", tool: "codex" },
    { id: "b", name: "bad", tool: "nope" },
    { id: "c", tool: "codex", model: "x; rm" },
    null,
  ]);
  assert.deepEqual(presets.map((p) => p.id), ["a", "c"]);
  assert.equal(presetCommand(presets[0]), "claude --model opus --resume");
  assert.equal(presets[1].model, "");
  assert.deepEqual(normalizePresets("x"), []);
});

test("openers need a safe app name", () => {
  assert.equal(validApp("Visual Studio Code"), true);
  assert.equal(validApp("-a evil"), false);
  assert.equal(validApp("bad\nname"), false);
  assert.deepEqual(normalizeOpeners([{ app: "Zed" }, { app: "" }, { app: "--x" }]).map((o) => [o.name, o.app]), [["Zed", "Zed"]]);
});

test("missing config gets defaults, existing config is honored", () => {
  assert.deepEqual(normalizeTools(undefined), DEFAULT_TOOLS);
  assert.deepEqual(normalizeTools({ presets: [], openers: [] }), { presets: [], openers: [], models: {}, icons: {} });
});

import { applyModels, builtinModels, normalizeModels, parseModelList } from "../src/launch.ts";

test("model lists can be overridden per tool and restored", () => {
  assert.deepEqual(parseModelList("a-1, b.2\nbad;x  a-1"), ["a-1", "b.2"]);
  const models = normalizeModels({ claude: ["fresh-1", "x y", 3], codex: [], nope: ["z"] });
  assert.deepEqual(models, { claude: ["fresh-1", "x", "y"] });
  assert.deepEqual(normalizeTools({ presets: [], openers: [], models: { gemini: ["g-1"] } }).models, { gemini: ["g-1"] });
  const before = builtinModels("claude");
  applyModels({ claude: ["fresh-1"] });
  assert.deepEqual(claude.models, ["fresh-1"]);
  applyModels({});
  assert.deepEqual(claude.models, before);
});

test("icons: normalize and resolve", async () => {
  const { normalizeIcons, resolveIcon } = await import("../src/launch.ts");
  assert.deepEqual(normalizeIcons({ claude: "claude", codex: "none", gemini: "🤖", copilot: "toolong!", x: "a" }), { codex: "none", gemini: "🤖" });
  assert.deepEqual(resolveIcon("claude", {}), { mark: "claude" });
  assert.deepEqual(resolveIcon("claude", { claude: "none" }), {});
  assert.deepEqual(resolveIcon("claude", { claude: "gemini" }), { mark: "gemini" });
  assert.deepEqual(resolveIcon("claude", { claude: "🤖" }), { text: "🤖" });
});
