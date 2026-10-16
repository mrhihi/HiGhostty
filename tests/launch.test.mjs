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
