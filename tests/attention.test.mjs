import test from "node:test";
import assert from "node:assert/strict";
import { attachScreen, raise, clear, clearSource, prune, unreadCount, tabsWithAlerts, badgeText, emptyAttention, titleSpinnerStopped, looksLikeMenu, snapshot, idleStep, QUIET_MS } from "../src/attention.ts";

const a = (surfaceId, source, title = "t", body = "") => ({ surfaceId, source, title, body, since: 1 });

test("same alert repeats merge into a count", () => {
  let s = raise(emptyAttention, a("1", "signal", "bell"));
  s = raise(s, a("1", "signal", "bell"));
  assert.equal(unreadCount(s), 1);
  assert.equal(s.get("1").count, 2);
});

test("stronger source wins, weaker is ignored", () => {
  let s = raise(emptyAttention, a("1", "idle"));
  s = raise(s, a("1", "hook", "need ok"));
  assert.equal(s.get("1").source, "hook");
  assert.equal(raise(s, a("1", "idle")), s);
  assert.equal(clearSource(s, "1", "idle"), s);
  assert.equal(unreadCount(clearSource(s, "1", "hook")), 0);
});

test("clear, prune, tabs and badge", () => {
  let s = raise(raise(emptyAttention, a("1", "signal")), a("2", "hook"));
  assert.equal(unreadCount(clear(s, "1")), 1);
  assert.equal(unreadCount(prune(s, (id) => id === "2")), 1);
  const tabs = tabsWithAlerts(s, (id) => "tab" + id);
  assert.equal(tabs.get("tab2").source, "hook");
  assert.equal(badgeText(5), "5");
  assert.equal(badgeText(120), "99+");
});

test("title spinner stop", () => {
  assert.ok(titleSpinnerStopped("⠂ Fix bug", "✳ Fix bug"));
  assert.ok(!titleSpinnerStopped("✳ Fix bug", "✳ Fix bug"));
  assert.ok(!titleSpinnerStopped("⠂ a", "⠐ a"));
});

const claudePlan = [
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "",
  "❯ 1. Yes, and use auto mode",
  "  2. Yes, manually approve edits",
  "  3. Tell Claude what to change",
  "     shift+tab to approve with this feedback",
];
test("menu detection by layout", () => {
  assert.ok(looksLikeMenu(claudePlan));
  assert.ok(looksLikeMenu(["Allow command? [y/N]"]));
  assert.ok(!looksLikeMenu(["1. first", "2. second"]));
  assert.ok(!looksLikeMenu(["❯ ls", "file"]));
});

test("idle detection needs change then quiet menu", () => {
  const menu = claudePlan.join("\n");
  let r = idleStep(undefined, "working…", 0);
  assert.ok(!r.waiting);
  r = idleStep(r.track, menu, 1000);
  assert.ok(!r.waiting);
  r = idleStep(r.track, menu, 1000 + QUIET_MS - 1);
  assert.ok(!r.waiting);
  r = idleStep(r.track, menu, 1000 + QUIET_MS);
  assert.ok(r.waiting);
  r = idleStep(r.track, menu + "\nmore", 9000);
  assert.ok(!r.waiting);
});

test("snapshot trims blank tail and limits lines", () => {
  assert.equal(snapshot("a\nb  \n\n\n"), "a\nb");
  assert.equal(snapshot("1\n2\n3\n4", 2), "3\n4");
});

test("attachScreen stores the captured screen and ignores cleared alerts", () => {
  const base = raise(emptyAttention, { surfaceId: "a", source: "signal", title: "響鈴", body: "", since: 1 });
  const withScreen = attachScreen(base, "a", "❯ 1. Yes\n  2. No");
  assert.equal(withScreen.get("a").screen, "❯ 1. Yes\n  2. No");
  assert.equal(attachScreen(withScreen, "a", "❯ 1. Yes\n  2. No"), withScreen);
  assert.equal(attachScreen(emptyAttention, "a", "x"), emptyAttention);
  assert.equal(attachScreen(base, "a", ""), base);
  const merged = raise(withScreen, { surfaceId: "a", source: "signal", title: "響鈴", body: "", since: 2 });
  assert.equal(merged.get("a").screen, "❯ 1. Yes\n  2. No");
  assert.equal(merged.get("a").count, 2);
});
