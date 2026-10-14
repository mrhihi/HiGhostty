import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attachScreen, raise, clear, clearSource, prune, unreadCount, tabsWithAlerts, badgeText, emptyAttention, titleSpinnerStopped, recognizePrompt, promptKey, snapshot, idleStep, QUIET_MS } from "../src/attention.ts";
import { buildRules } from "../src/prompt-rules.ts";

const { rules, errors } = buildRules(readFileSync(new URL("../src/prompt-rules.json", import.meta.url), "utf8"));
assert.deepEqual(errors, []);
const recognize = (lines) => recognizePrompt(lines, rules);

const a = (surfaceId, source, title = "t", body = "") => ({ surfaceId, source, title, body, since: 1 });

test("same alert repeats merge into a count", () => {
  let s = raise(emptyAttention, a("1", "signal", "bell"));
  s = raise(s, a("1", "signal", "bell"));
  assert.equal(unreadCount(s), 1);
  assert.equal(s.get("1").count, 2);
});

test("stronger source wins, weaker is ignored", () => {
  let s = raise(emptyAttention, a("1", "signal"));
  s = raise(s, a("1", "prompt", "等待選擇"));
  assert.equal(s.get("1").source, "prompt");
  assert.equal(raise(s, a("1", "signal")), s);
  assert.equal(clearSource(s, "1", "signal"), s);
  assert.equal(unreadCount(clearSource(s, "1", "prompt")), 0);
});

test("clear, prune, tabs and badge", () => {
  let s = raise(raise(emptyAttention, a("1", "signal")), a("2", "prompt"));
  assert.equal(unreadCount(clear(s, "1")), 1);
  assert.equal(unreadCount(prune(s, (id) => id === "2")), 1);
  const tabs = tabsWithAlerts(s, (id) => "tab" + id);
  assert.equal(tabs.get("tab2").source, "prompt");
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
test("numbered menu: kind, question, options and selection", () => {
  const prompt = recognize(claudePlan);
  assert.equal(prompt.kind, "confirm");
  assert.equal(prompt.label, "等待核准");
  assert.equal(prompt.question, "Claude has written up a plan and is ready to execute. Would you like to proceed?");
  assert.deepEqual(prompt.options, ["1. Yes, and use auto mode", "2. Yes, manually approve edits", "3. Tell Claude what to change"]);
  assert.equal(prompt.selected, 0);
  const plain = recognize(["Pick a theme:", "  1. Dark", "❯ 2. Light"]);
  assert.equal(plain.kind, "menu");
  assert.equal(plain.question, "Pick a theme:");
  assert.equal(plain.selected, 1);
});

test("trust prompt", () => {
  const prompt = recognize(["Do you trust the files in this folder?", "/Users/me/app", "", "❯ 1. Yes, proceed", "  2. No, exit", "", "Enter to confirm · Esc to exit"]);
  assert.equal(prompt.kind, "confirm");
  assert.equal(prompt.options.length >= 2, true);
  assert.equal(recognize(["Do you trust the files in this folder?", "(Y/n)"]).kind, "trust");
});

test("unnumbered menu with an enter-to-confirm footer", () => {
  const prompt = recognize(["Allow this tool?", "› Allow once", "  Allow always", "  Deny", "Enter to confirm · Esc to cancel"]);
  assert.equal(prompt.kind, "confirm");
  assert.deepEqual(prompt.options, ["Allow once", "Allow always", "Deny"]);
  assert.equal(prompt.selected, 0);
});

test("simple kinds", () => {
  assert.equal(recognize(["Overwrite file? [y/N]"]).kind, "yesno");
  assert.equal(recognize(["Press Enter to continue"]).kind, "press-enter");
  assert.equal(recognize(["Enter your password:"]).kind, "password");
  assert.equal(recognize(["Please sign in to continue"]).kind, "login");
  const ask = recognize(["What should the file be called?"]);
  assert.equal(ask.kind, "input");
  assert.equal(ask.low, true);
});

test("normal screens are not prompts", () => {
  assert.equal(recognize(["1. first", "2. second"]), null);
  assert.equal(recognize(["❯ ls", "file"]), null);
  assert.equal(recognize(["Would you like to proceed?", "✻ Working… (esc to interrupt)"]), null);
  assert.equal(recognize(["done", "  ? for shortcuts"]), null);
  assert.equal(recognize([]), null);
});

test("prompt key ignores nothing that changes the question", () => {
  const one = recognize(["Pick:", "❯ 1. a", "  2. b"]);
  const moved = recognize(["Pick:", "  1. a", "❯ 2. b"]);
  assert.notEqual(promptKey(one), promptKey(moved));
  assert.equal(promptKey(one), promptKey(recognize(["Pick:", "❯ 1. a", "  2. b"])));
});

test("idle detection needs change then a quiet prompt", () => {
  const menu = claudePlan.join("\n");
  let r = idleStep(undefined, "working…", 0, rules);
  assert.ok(!r.waiting);
  r = idleStep(r.track, menu, 1000, rules);
  assert.ok(!r.waiting);
  r = idleStep(r.track, menu, 1000 + QUIET_MS - 1, rules);
  assert.ok(!r.waiting);
  r = idleStep(r.track, menu, 1000 + QUIET_MS, rules);
  assert.ok(r.waiting);
  assert.equal(r.prompt.kind, "confirm");
  // Activity outside the prompt (spinner, clock) does not restart the timer.
  r = idleStep(r.track, "tick\n" + menu, 9000, rules);
  assert.ok(r.waiting);
  // Moving the cursor is a new prompt state.
  r = idleStep(r.track, menu.replace("❯ 1.", "  1.").replace("  2.", "❯ 2."), 9100, rules);
  assert.ok(!r.waiting);
});

test("a prompt already on screen at first sight waits for a change", () => {
  const r = idleStep(undefined, claudePlan.join("\n"), 0, rules);
  assert.ok(!idleStep(r.track, claudePlan.join("\n"), 99999, rules).waiting);
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
