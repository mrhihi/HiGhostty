import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sorted, attachScreen, raise, clear, clearSource, prune, unreadCount, tabsWithAlerts, badgeText, emptyAttention, titleSpinnerStopped, titleWorking, agentState, recognizePrompt, promptKey, snapshot, idleStep, QUIET_MS } from "../src/attention.ts";
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

test("Claude's half-circle busy spinner counts as working", () => {
  assert.ok(titleWorking("◐ Fix bug"));
  assert.ok(titleWorking("◓ Fix bug"));
  assert.ok(titleSpinnerStopped("◑ Fix bug", "✳ Fix bug"));
  assert.ok(!titleWorking("✳ Fix bug"));
});

test("Claude blocking screens: select form, MCP elicitation, review, permission", () => {
  const form = recognize(["Which option?", "❯ 1. Alpha", "  2. Beta", "Enter to select · ↑/↓ to navigate · Esc to cancel"]);
  assert.equal(form.kind, "menu");
  assert.deepEqual(form.options, ["1. Alpha", "2. Beta"]);
  assert.equal(recognize(["Pick one", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"]).label, "等待選擇");
  assert.equal(recognize(['MCP server "files" requests your input', "Accept", "Decline", "Esc to cancel"]).label, "等待 MCP 輸入");
  assert.equal(recognize(["Review your answers", "Ready to submit?", "Esc to cancel"]).label, "等待確認答案");
  assert.equal(recognize(["Claude needs your permission", "Esc to cancel · Tab to amend"]).label, "等待核准");
});

test("rule-relative scopes follow the prompt box", () => {
  const box = ["output above?", "────────", "> draft", "────────", "footer below"];
  const make = (scope, pattern) => buildRules("{}", JSON.stringify({ rules: [{ id: "t", kind: "input", label: "T", scope, pattern }] })).rules;
  const hit = (scope, pattern) => recognizePrompt(box, make(scope, pattern))?.label;
  assert.equal(hit("after-rule", "footer"), "T");
  assert.equal(hit("after-rule", "draft"), undefined);
  assert.equal(hit("box-body", "draft"), "T");
  assert.equal(hit("box-body", "footer"), undefined);
  assert.equal(hit("above-box", "output"), "T");
  assert.equal(hit("above-box", "draft"), undefined);
  // Without a box: after-rule is the whole screen, box-body empty.
  assert.equal(recognizePrompt(["plain text"], make("after-rule", "plain"))?.label, "T");
  assert.equal(recognizePrompt(["plain text"], make("box-body", "plain")), null);
  // A one-char dash is not a rule.
  assert.equal(recognizePrompt(["old prompt?", "─ x", "new text"], make("after-rule", "old"))?.label, "T");
});

test("not drops a rule when any of its lines match", () => {
  const { rules: custom, errors: problems } = buildRules("{}", JSON.stringify({ rules: [{ id: "t", kind: "input", label: "T", scope: "last", pattern: "ready\\?$", not: ["^idle box"] }] }));
  assert.deepEqual(problems, []);
  assert.equal(recognizePrompt(["Are you ready?"], custom)?.label, "T");
  assert.equal(recognizePrompt(["idle box", "Are you ready?"], custom), null);
});

test("agentState: blocked, working, idle", () => {
  const state = (text, title = "") => agentState(text, title, rules);
  assert.equal(state("Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel"), "blocked");
  assert.equal(state("thinking…\nesc to interrupt"), "working");
  assert.equal(state("plain output\n❯ ", "⠂ Fix bug"), "working");
  assert.equal(state("done\n❯ \n? for shortcuts"), "idle");
  assert.equal(state("done\n❯ ", "✳ Fix bug"), "idle");
  // Blocked wins over a stale spinner title.
  assert.equal(state("Do you want to proceed?\n❯ 1. Yes\n  2. No", "⠂ x"), "blocked");
});

test("an agent's own alert outranks a detected prompt and survives prompt clearing", () => {
  let s = raise(emptyAttention, a("1", "agent", "要你決定", "選哪個？"));
  assert.equal(raise(s, a("1", "prompt", "等待選擇")), s);
  assert.equal(raise(s, a("1", "signal", "響鈴")), s);
  assert.equal(clearSource(s, "1", "prompt"), s);
  assert.equal(clearSource(s, "1", "signal"), s);
  assert.equal(unreadCount(clearSource(s, "1", "agent")), 0);
  s = raise(emptyAttention, a("2", "prompt", "等待選擇"));
  assert.equal(raise(s, a("2", "agent", "要你決定")).get("2").source, "agent");
  assert.equal(sorted(raise(raise(emptyAttention, a("3", "prompt")), a("4", "agent"))).at(0).surfaceId, "4");
});

import { menuAnswerable, menuKeys, sameMenu } from "../src/attention.ts";
const menu = (over = {}) => ({ kind: "menu", label: "x", question: "Pick one?", options: ["1. A", "2. B", "3. C"], selected: 0, exact: true, ...over });

test("a plain single-choice menu is answered by arrows then Enter", () => {
  assert.deepEqual(menuKeys(menu(), 0), ["enter"]);
  assert.deepEqual(menuKeys(menu(), 2), ["down", "down", "enter"]);
  assert.deepEqual(menuKeys(menu({ selected: 2 }), 0), ["up", "up", "enter"]);
  assert.deepEqual(menuKeys(menu({ kind: "confirm", selected: 1 }), 2), ["down", "enter"]);
});

test("nothing is sent for what we cannot be sure of", () => {
  assert.equal(menuKeys(menu(), 3), undefined, "no such option");
  assert.equal(menuKeys(menu(), -1), undefined);
  assert.equal(menuKeys(menu({ low: true }), 0), undefined, "a low-confidence guess");
  for (const kind of ["password", "login", "input", "yesno", "press-enter"]) assert.equal(menuAnswerable(menu({ kind })), false, kind);
  assert.equal(menuAnswerable(menu({ selected: undefined })), false, "cursor not read from the screen");
  assert.equal(menuAnswerable(menu({ selected: -1 })), false);
  assert.equal(menuAnswerable(menu({ options: ["1. A"] })), false, "one option is not a choice");
  assert.equal(menuAnswerable(menu({ options: Array.from({ length: 10 }, (_, i) => `${i}. x`) })), false, "too long to trust relative moves");
  assert.equal(menuAnswerable(menu({ options: ["[ ] A", "[x] B"] })), false, "checkboxes: Enter would submit a selection");
  assert.equal(menuAnswerable(undefined), false);
});

test("the screen must still show the same menu with the cursor in the same place", () => {
  assert.equal(sameMenu(menu(), menu()), true);
  assert.equal(sameMenu(menu(), menu({ selected: 1 })), false, "the cursor moved");
  assert.equal(sameMenu(menu(), menu({ question: "Other?" })), false);
  assert.equal(sameMenu(menu(), menu({ options: ["1. A", "2. B"] })), false);
  assert.equal(sameMenu(menu(), null), false);
});

test("menuAnswerable needs a prompt read as one exact block", () => {
  assert.equal(menuAnswerable(menu({ exact: false })), false);
  assert.equal(menuAnswerable(menu({ exact: undefined })), false);
});

// Real screens: the parser must say "exact" only when row N on screen is options[N].
const screen = (...lines) => lines;
const read = (lines) => recognizePrompt(lines, rules);
test("a normal permission menu is exact and answerable", () => {
  const p = read(screen("Edit file src/a.ts", "Do you want to proceed?", "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No, and tell Claude what to do differently (esc)"));
  assert.equal(p.exact, true);
  assert.deepEqual(menuKeys(p, 2), ["down", "down", "enter"]);
});

test("an earlier numbered list in the output makes the menu inexact", () => {
  const p = read(screen("I suggest:", "1. Rewrite module", "2. Add tests", "3. Ship", "────────", "Do you want to proceed?", "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No"));
  assert.notEqual(p.exact, true);
  assert.equal(menuKeys(p, 0), undefined);
});

test("an echoed numbered input line before the menu makes it inexact", () => {
  const p = read(screen("> 1. fix the bug", "Do you want to proceed?", "1. Yes", "❯ 2. No"));
  assert.notEqual(p?.exact, true);
});

test("checkbox lists with numbers, radio dots on every row and type-it-yourself options are inexact", () => {
  const boxes = read(screen("Pick any?", "❯ 1. [ ] Alpha", "  2. [ ] Beta", "  3. [✔] Gamma", "  4. Type something", "Enter to select · ↑/↓ to navigate · Esc to cancel"));
  assert.notEqual(boxes?.exact, true);
  assert.equal(menuAnswerable(boxes), false);
  const radios = read(screen("Which one?", "○ 1. A", "● 2. B", "○ 3. C", "Enter to select · Esc to cancel"));
  assert.notEqual(radios?.exact, true);
  const typing = read(screen("Which?", "❯ 1. One", "  2. Two", "  3. Chat about this"));
  assert.notEqual(typing?.exact, true);
});

test("a confirm-style list with description lines is never answerable", () => {
  const p = read(screen("Choose a model?", "❯ Alpha", "  first desc", "  Beta", "  second desc", "Enter to confirm"));
  assert.equal(menuAnswerable(p), false);
});
