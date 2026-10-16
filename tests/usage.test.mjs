import test from "node:test";
import assert from "node:assert/strict";
import { useLocale } from "./i18n-helper.mjs";
import { displayPct, levelOf, parseUsage, effective, formatPct, formatDuration, resetText, errorText, warningText } from "../src/usage.ts";
useLocale("en");

test("levelOf thresholds", () => {
  assert.equal(levelOf(0), "ok");
  assert.equal(levelOf(69.9), "ok");
  assert.equal(levelOf(70), "warn");
  assert.equal(levelOf(89.9), "warn");
  assert.equal(levelOf(90), "danger");
  assert.equal(levelOf(100), "danger");
});

test("parseUsage normalizes epoch seconds and ISO strings", () => {
  const codex = parseUsage({ five_hour: { pct: 4, resets_at: 1000 }, week: { pct: 11, resets_at: 2000 }, plan: "plus", updated_at: 5 });
  assert.deepEqual(codex.fiveHour, { pct: 4, resetsAt: 1_000_000 });
  assert.equal(codex.plan, "plus");
  assert.equal(codex.updatedAt, 5000);
  assert.equal(codex.error, null);
  const claude = parseUsage({ five_hour: { pct: 6, resets_at: "2026-10-16T09:10:00+00:00" }, week: null });
  assert.equal(claude.fiveHour.resetsAt, Date.parse("2026-10-16T09:10:00Z"));
  assert.equal(claude.week, null);
});

test("parseUsage keeps error codes and flags empty data", () => {
  assert.equal(parseUsage({ error: "no-token" }).error, "no-token");
  assert.equal(parseUsage(null).error, "no-data");
  assert.equal(parseUsage({ five_hour: { pct: "x" } }).error, "no-data");
});

test("effective resets expired windows to 0", () => {
  const w = { pct: 80, resetsAt: 1000 };
  assert.deepEqual(effective(w, 999), { pct: 80, expired: false });
  assert.deepEqual(effective(w, 1000), { pct: 0, expired: true });
  assert.equal(effective(null, 0), null);
  assert.deepEqual(effective({ pct: 50, resetsAt: null }, 5), { pct: 50, expired: false });
});

test("formatting", () => {
  assert.equal(formatPct(23.4), "23%");
  assert.equal(formatPct(-1), "0%");
  assert.equal(formatDuration(30 * 60000), "30m");
  assert.equal(formatDuration((2 * 60 + 14) * 60000), "2h 14m");
  assert.equal(formatDuration((3 * 1440 + 4 * 60) * 60000), "3d 4h");
  assert.equal(resetText({ pct: 1, resetsAt: 10 * 60000 }, 0), "Resets in 10m");
  assert.equal(resetText({ pct: 1, resetsAt: 5 }, 10), "Window has reset (waiting for new data)");
  assert.equal(resetText(null, 0), "");
});

test("errorText falls back for unknown codes", () => {
  assert.match(errorText("no-token"), /Keychain/);
  assert.equal(errorText("weird"), "Could not read usage.");
});

test("displayPct flips to remaining and clamps", () => {
  assert.equal(displayPct(23, "used"), 23);
  assert.equal(displayPct(23, "left"), 77);
  assert.equal(displayPct(120, "left"), 0);
  assert.equal(displayPct(-5, "left"), 100);
});

test("warning is parsed and has a fallback text", () => {
  const u = parseUsage({ five_hour: { pct: 10, resets_at: null }, week: null, warning: "rate-limited" });
  assert.equal(u.warning, "rate-limited");
  assert.equal(u.error, null);
  assert.match(warningText("rate-limited"), /last value/);
  assert.equal(warningText("weird"), "Could not refresh; showing the last value.");
});
