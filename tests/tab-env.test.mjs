import test from "node:test";
import assert from "node:assert/strict";
import { formatEnv, normalizeEnv, parseEnv, sameEnv } from "../src/tab-env.ts";

test("parseEnv reads KEY=value lines literally and skips blanks and comments", () => {
  const { env, errors } = parseEnv("AWS_PROFILE=dev\n\n# note\n  # indented note\nURL=a=b\nEMPTY=\nQ=\"$HOME ~\"\r\nlower=x");
  assert.deepEqual(env, { AWS_PROFILE: "dev", URL: "a=b", EMPTY: "", Q: "\"$HOME ~\"", lower: "x" });
  assert.deepEqual(errors, []);
});

test("parseEnv reports the line and reason for each bad line", () => {
  const { env, errors } = parseEnv("noequals\n1BAD=x\n=v\nHIGHOSTTY_ENV=0\nhighostty_x=1\nA=1\nA=2\nB=ok");
  assert.deepEqual(errors, [
    { line: 1, code: "syntax" },
    { line: 2, code: "name" },
    { line: 3, code: "name" },
    { line: 4, code: "reserved" },
    { line: 5, code: "reserved" },
    { line: 7, code: "duplicate" },
  ]);
  assert.deepEqual(env, { A: "1", B: "ok" });
});

test("parseEnv allows PATH and keeps its colons", () => {
  assert.deepEqual(parseEnv("PATH=/opt/x/bin:/usr/bin").env, { PATH: "/opt/x/bin:/usr/bin" });
});

test("formatEnv round-trips parseEnv", () => {
  const text = "A=1\nB=x=y\nC=";
  assert.equal(formatEnv(parseEnv(text).env), text);
  assert.equal(formatEnv(undefined), "");
});

test("normalizeEnv drops invalid entries and empties", () => {
  assert.deepEqual(normalizeEnv({ A: "1", "1x": "2", HIGHOSTTY_X: "3", B: 4, C: "" }), { A: "1", C: "" });
  assert.equal(normalizeEnv({}), undefined);
  assert.equal(normalizeEnv({ HIGHOSTTY_X: "1" }), undefined);
  assert.equal(normalizeEnv(null), undefined);
  assert.equal(normalizeEnv(["A=1"]), undefined);
  assert.equal(normalizeEnv("A=1"), undefined);
});

test("sameEnv compares contents", () => {
  assert.ok(sameEnv(undefined, undefined));
  assert.ok(sameEnv({ A: "1" }, { A: "1" }));
  assert.ok(!sameEnv({ A: "1" }, undefined));
});
