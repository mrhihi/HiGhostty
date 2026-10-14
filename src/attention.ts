// Pure state for "this terminal wants attention": bell, desktop notification,
// title spinner stop, or an agent TUI sitting at a recognised prompt. DOM-free
// so it can be tested directly; main.ts renders the result.
import type { CompiledRules, Prompt } from "./prompt-rules";
export type AlertSource = "signal" | "prompt";
export type Alert = {
  surfaceId: string;
  source: AlertSource;
  title: string;
  body: string;
  since: number;
  count: number;
  // Visible screen text captured when the alert was raised (frozen, so it
  // still shows what the agent asked after the screen moves on).
  screen?: string;
  // What the agent is asking, when a prompt was recognised on screen.
  prompt?: Prompt;
};
export type AttentionState = ReadonlyMap<string, Alert>;

const RANK: Record<AlertSource, number> = { signal: 1, prompt: 2 };

export const emptyAttention: AttentionState = new Map();

// One alert per surface; a more reliable source replaces a weaker one, and
// repeated alerts of the same source are merged into a count.
export function raise(state: AttentionState, next: Omit<Alert, "count">): AttentionState {
  const current = state.get(next.surfaceId);
  if (current && RANK[current.source] > RANK[next.source]) return state;
  const merged = current && current.source === next.source && current.title === next.title && current.body === next.body
    ? { ...current, count: current.count + 1, screen: next.screen ?? current.screen, prompt: next.prompt ?? current.prompt }
    : { ...next, count: 1 };
  return new Map(state).set(next.surfaceId, merged);
}
// Attach the captured screen to an existing alert; no-op if it was cleared meanwhile.
export function attachScreen(state: AttentionState, surfaceId: string, screen: string): AttentionState {
  const current = state.get(surfaceId);
  if (!current || !screen || current.screen === screen) return state;
  return new Map(state).set(surfaceId, { ...current, screen });
}
export function clear(state: AttentionState, surfaceId: string): AttentionState {
  if (!state.has(surfaceId)) return state;
  const map = new Map(state);
  map.delete(surfaceId);
  return map;
}
// Drop an alert only if it came from `source` (e.g. prompt detection must not
// erase a bell alert when the screen changes).
export function clearSource(state: AttentionState, surfaceId: string, source: AlertSource): AttentionState {
  return state.get(surfaceId)?.source === source ? clear(state, surfaceId) : state;
}
export function prune(state: AttentionState, alive: (surfaceId: string) => boolean): AttentionState {
  let next = state;
  for (const id of state.keys()) if (!alive(id)) next = clear(next, id);
  return next;
}
export function unreadCount(state: AttentionState): number {
  return state.size;
}
export function sorted(state: AttentionState): Alert[] {
  return [...state.values()].sort((a, b) => RANK[b.source] - RANK[a.source] || a.since - b.since);
}
export function tabsWithAlerts(state: AttentionState, tabOf: (surfaceId: string) => string | undefined): Map<string, Alert> {
  const out = new Map<string, Alert>();
  for (const alert of sorted(state)) {
    const tab = tabOf(alert.surfaceId);
    if (tab && !out.has(tab)) out.set(tab, alert);
  }
  return out;
}
export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

// Agents (Claude Code, Codex, Gemini, Copilot …) put a spinner glyph in the
// terminal title while working and drop it when they stop to ask something.
const BRAILLE = /^[⠀-⣿]/;
export function titleWorking(title: string): boolean {
  return BRAILLE.test(title.trimStart());
}
export function titleSpinnerStopped(previous: string, next: string): boolean {
  return titleWorking(previous) && !titleWorking(next);
}

// Prompt recognition. Wording lives in the rules (prompt-rules.json); the two
// layout parsers below read option lists that regexes cannot.
const MENU_CURSOR = /^\s*[❯›>▶●○◉]\s*\d+[.)]\s+\S/;
const MENU_OPTION = /^\s*(?:[❯›>▶●○◉]\s*)?\d+[.)]\s+\S/;
const CURSOR = /^[❯›>▶]/;
const LAYOUT_LINES = 25;
const TAIL_LINES = 12;
const QUESTION_END = /[?:？：]$/;
const clean = (line: string) => line.replace(/^[❯›>▶●○◉]\s*/, "").trim();

type Menu = { question: string; options: string[]; selected?: number };
// Numbered options with a cursor on one of them (Claude, Codex, Gemini menus).
function numberedMenu(lines: string[]): Menu | undefined {
  const tail = lines.slice(-LAYOUT_LINES);
  const cursor = tail.findLastIndex((line) => MENU_CURSOR.test(line));
  if (cursor < 0) return undefined;
  const found = tail.map((line, index) => (MENU_OPTION.test(line) ? index : -1)).filter((index) => index >= 0);
  if (found.length < 2) return undefined;
  const first = found[0];
  const question = tail.slice(Math.max(0, first - 6), first).reverse().find((line) => QUESTION_END.test(line)) ?? tail[first - 1] ?? "";
  return { question: clean(question), options: found.map((index) => clean(tail[index])), selected: found.indexOf(cursor) };
}
// "Enter to confirm" footer with an unnumbered list above it.
function confirmMenu(lines: string[], confirmText: string): Menu | undefined {
  if (!lines.at(-1)?.toLowerCase().includes(confirmText)) return undefined;
  const selected = lines.findLastIndex((line) => CURSOR.test(line));
  if (selected < 0) return undefined;
  const above = lines.slice(0, selected).findLastIndex((line) => QUESTION_END.test(line));
  const start = above >= 0 ? above + 1 : Math.max(0, selected - 1);
  const end = lines.length - 1;
  if (end - start < 2 || end - start > 6) return undefined;
  return { question: clean(lines[start - 1] ?? ""), options: lines.slice(start, end).map(clean), selected: selected - start };
}
const nonEmpty = (lines: string[]) => lines.map((line) => line.trim()).filter(Boolean);

// The first matching rule wins; null when the screen shows a normal running
// footer or nothing recognisable.
export function recognizePrompt(lines: string[], rules: CompiledRules): Prompt | null {
  const all = nonEmpty(lines);
  const last = all.at(-1) ?? "";
  if (!last || rules.footers.some((footer) => footer.test(last))) return null;
  const tail = all.slice(-TAIL_LINES);
  for (const rule of rules.rules) {
    let prompt: Prompt | undefined;
    if (rule.layout === "cursor-menu") {
      const menu = numberedMenu(all);
      if (menu) prompt = { kind: rule.kind, label: rule.label, ...menu };
    } else if (rule.layout === "confirm-menu") {
      const menu = confirmMenu(all, rule.confirmText ?? "enter to confirm");
      if (menu) prompt = { kind: rule.kind, label: rule.label, ...menu };
    } else if (rule.re) {
      const hit = rule.scope === "last" ? (rule.re.test(last) ? last : undefined) : tail.findLast((line) => rule.re!.test(line));
      if (hit !== undefined) {
        const menu = numberedMenu(all);
        prompt = { kind: rule.kind, label: rule.label, question: menu?.question || hit, options: menu?.options ?? [], selected: menu?.selected };
      }
    }
    if (prompt) return rule.low ? { ...prompt, low: true } : prompt;
  }
  return null;
}
// Identity of a prompt, so a repeat scan of the same question is not a new alert.
export function promptKey(prompt: Prompt | undefined): string {
  return prompt ? JSON.stringify([prompt.kind, prompt.question, prompt.options, prompt.selected]) : "";
}
// The visible question: last non-empty lines of the screen, for display.
export function snapshot(text: string, max = 15): string {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-max).join("\n");
}

export type IdleTrack = { hash: string; since: number; changed: boolean };
export const QUIET_MS = 1400;
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h) + ":" + text.length;
}
// One poll of a surface running an agent. The track follows the recognised
// prompt (not the whole screen), so a spinner or clock elsewhere does not
// restart the timer. `waiting` becomes true once the screen was alive, then the
// same prompt stayed for QUIET_MS.
export function idleStep(previous: IdleTrack | undefined, text: string, now: number, rules: CompiledRules): { track: IdleTrack; waiting: boolean; prompt: Prompt | null } {
  const prompt = recognizePrompt(text.split("\n"), rules);
  const hash = prompt ? "p:" + promptKey(prompt) : hashText(text);
  const track: IdleTrack = !previous
    ? { hash, since: now, changed: false }
    : previous.hash !== hash
      ? { hash, since: now, changed: true }
      : previous;
  const waiting = !!prompt && track.changed && now - track.since >= QUIET_MS;
  return { track, waiting, prompt };
}
