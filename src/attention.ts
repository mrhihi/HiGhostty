// Pure state for "this terminal wants attention": bell, desktop notification,
// agent hook, or an agent TUI sitting at an interactive menu. DOM-free so it
// can be tested directly; main.ts renders the result.
export type AlertSource = "hook" | "signal" | "idle";
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
};
export type AttentionState = ReadonlyMap<string, Alert>;

const RANK: Record<AlertSource, number> = { idle: 1, signal: 2, hook: 3 };

export const emptyAttention: AttentionState = new Map();

// One alert per surface; a more reliable source replaces a weaker one, and
// repeated alerts of the same source are merged into a count.
export function raise(state: AttentionState, next: Omit<Alert, "count">): AttentionState {
  const current = state.get(next.surfaceId);
  if (current && RANK[current.source] > RANK[next.source]) return state;
  const merged = current && current.source === next.source && current.title === next.title && current.body === next.body
    ? { ...current, count: current.count + 1, screen: next.screen ?? current.screen }
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
// Drop an alert only if it came from `source` (e.g. idle detection must not
// erase an explicit hook alert when the screen changes).
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

// Layout-based, wording-independent signs of an interactive question:
// a cursor next to a numbered option, or a y/n choice.
const MENU_CURSOR = /^\s*[❯›>▶●○◉]\s*\d+[.)]\s+\S/;
const MENU_OPTION = /^\s*(?:[❯›>▶]\s*)?\d+[.)]\s+\S/;
const YES_NO = /[\[(]\s*(?:y\/n|y\/N|Y\/n|yes\/no)\s*[\])]/i;
export function looksLikeMenu(lines: string[]): boolean {
  const tail = lines.slice(-25);
  if (tail.some((line) => YES_NO.test(line))) return true;
  const cursor = tail.some((line) => MENU_CURSOR.test(line));
  return cursor && tail.filter((line) => MENU_OPTION.test(line)).length >= 2;
}
// The visible question: last non-empty lines of the screen, for display.
export function snapshot(text: string, max = 15): string {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-max).join("\n");
}

export type IdleTrack = { hash: string; since: number; changed: boolean };
export const QUIET_MS = 3000;
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h) + ":" + text.length;
}
// One poll of a surface running an agent. `waiting` becomes true once the
// screen was alive, then stayed unchanged for QUIET_MS while showing a menu.
export function idleStep(previous: IdleTrack | undefined, text: string, now: number): { track: IdleTrack; waiting: boolean } {
  const hash = hashText(text);
  const track: IdleTrack = !previous
    ? { hash, since: now, changed: false }
    : previous.hash !== hash
      ? { hash, since: now, changed: true }
      : previous;
  const waiting = track.changed && now - track.since >= QUIET_MS && looksLikeMenu(text.split("\n"));
  return { track, waiting };
}
