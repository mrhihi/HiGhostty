// Tab and split state of the standalone preview window (preview-window.ts).
// Pure and DOM-free: a tab is a "group" of 1–3 panes shown together, in columns or rows.
import type { Box } from "./preview.ts";

export const MAX_PANES = 3;
export const MIN_PANE_FRACTION = 0.12;
export type SplitLayout = "columns" | "rows";
export type Origin = { window: string; tab?: string | null };
export type Pane = { id: string; path: string; origin?: Origin | null };
export type Group = { id: string; panes: Pane[]; layout: SplitLayout; sizes: number[] };
// `uid` keeps ids unique across states: several terminal tabs each own one TabsState but share DOM caches.
export type TabsState = { groups: Group[]; active?: string; next: number; uid: string };

export const emptyTabs = (): TabsState => ({ groups: [], next: 1, uid: Math.random().toString(36).slice(2, 8) });
export const paneCount = (state: TabsState): number => state.groups.reduce((n, g) => n + g.panes.length, 0);
export const equalSizes = (count: number): number[] => Array.from({ length: count }, () => 1 / count);
export const baseName = (path: string): string => path.split("/").filter(Boolean).at(-1) || path;
export const groupTitle = (group: Group): string => group.panes.map((p) => baseName(p.path)).join(" ｜ ");

function nextId(state: TabsState, prefix: string): string {
  return `${state.uid}-${prefix}${state.next++}`;
}
const makeGroup = (state: TabsState, panes: Pane[], layout: SplitLayout = "columns"): Group => ({
  id: nextId(state, "g"),
  panes,
  layout,
  sizes: equalSizes(panes.length),
});

export function findPane(state: TabsState, path: string): { group: Group; pane: Pane } | undefined {
  for (const group of state.groups) {
    const pane = group.panes.find((p) => p.path === path);
    if (pane) return { group, pane };
  }
}
export const groupOf = (state: TabsState, paneId: string): Group | undefined =>
  state.groups.find((g) => g.panes.some((p) => p.id === paneId));

/** Same file asked again: its tab is activated instead of a second copy. */
export function openPath(state: TabsState, path: string, origin?: Origin | null): TabsState {
  const found = findPane(state, path);
  if (found) return { ...state, active: found.group.id };
  const next = { ...state, groups: [...state.groups] };
  const group = makeGroup(next, [{ id: nextId(next, "p"), path, origin }]);
  next.groups.push(group);
  next.active = group.id;
  return next;
}

export type MergeResult = { state: TabsState } | { error: "tooMany" | "missing" };
export function canMerge(state: TabsState, sourceId: string, targetId: string): boolean {
  const source = state.groups.find((g) => g.id === sourceId);
  const target = state.groups.find((g) => g.id === targetId);
  return !!source && !!target && source !== target && source.panes.length + target.panes.length <= MAX_PANES;
}
/** Source's panes join the end of target; the source tab disappears. */
export function mergeGroups(state: TabsState, sourceId: string, targetId: string): MergeResult {
  const source = state.groups.find((g) => g.id === sourceId);
  const target = state.groups.find((g) => g.id === targetId);
  if (!source || !target || source === target) return { error: "missing" };
  if (source.panes.length + target.panes.length > MAX_PANES) return { error: "tooMany" };
  const panes = [...target.panes, ...source.panes];
  const groups = state.groups
    .filter((g) => g !== source)
    .map((g) => (g === target ? { ...g, panes, sizes: equalSizes(panes.length) } : g));
  return { state: { ...state, groups, active: target.id } };
}

/** Every pane of the tab becomes its own tab, in place. */
export function splitGroup(state: TabsState, groupId: string): TabsState {
  const index = state.groups.findIndex((g) => g.id === groupId);
  if (index < 0 || state.groups[index].panes.length < 2) return state;
  const next = { ...state };
  const parts = state.groups[index].panes.map((pane) => makeGroup(next, [pane]));
  next.groups = [...state.groups.slice(0, index), ...parts, ...state.groups.slice(index + 1)];
  next.active = parts[0].id;
  return next;
}

/** One pane leaves its tab and becomes a new tab right after it. */
export function detachPane(state: TabsState, paneId: string): TabsState {
  const group = groupOf(state, paneId);
  if (!group || group.panes.length < 2) return state;
  const pane = group.panes.find((p) => p.id === paneId)!;
  const next = { ...state };
  const rest = group.panes.filter((p) => p !== pane);
  const alone = makeGroup(next, [pane]);
  next.groups = state.groups.flatMap((g) =>
    g === group ? [{ ...g, panes: rest, sizes: equalSizes(rest.length) }, alone] : [g]);
  next.active = alone.id;
  return next;
}

function activeAfterRemoval(groups: Group[], removedIndex: number, wasActive: boolean, current?: string): string | undefined {
  if (!wasActive) return current;
  return (groups[removedIndex] ?? groups[removedIndex - 1])?.id;
}
export function closeGroup(state: TabsState, groupId: string): TabsState {
  const index = state.groups.findIndex((g) => g.id === groupId);
  if (index < 0) return state;
  const groups = state.groups.filter((g) => g.id !== groupId);
  return { ...state, groups, active: activeAfterRemoval(groups, index, state.active === groupId, state.active) };
}
/** Removes one pane; the tab goes away with its last pane. */
export function closePane(state: TabsState, paneId: string): TabsState {
  const group = groupOf(state, paneId);
  if (!group) return state;
  if (group.panes.length === 1) return closeGroup(state, group.id);
  const panes = group.panes.filter((p) => p.id !== paneId);
  return { ...state, groups: state.groups.map((g) => (g === group ? { ...g, panes, sizes: equalSizes(panes.length) } : g)) };
}

/** Pane swaps places with its neighbour (`delta` -1 earlier, +1 later); its size goes with it. */
export function movePane(state: TabsState, paneId: string, delta: -1 | 1): TabsState {
  const group = groupOf(state, paneId);
  if (!group) return state;
  const from = group.panes.findIndex((p) => p.id === paneId);
  const to = from + delta;
  if (to < 0 || to >= group.panes.length) return state;
  const panes = [...group.panes];
  const sizes = [...group.sizes];
  [panes[from], panes[to]] = [panes[to], panes[from]];
  [sizes[from], sizes[to]] = [sizes[to], sizes[from]];
  return { ...state, groups: state.groups.map((g) => (g === group ? { ...g, panes, sizes } : g)) };
}

export type GroupSeed = { paths: string[]; layout?: SplitLayout; sizes?: number[] };
/** Tabs popped out of a pane arrive as they were; files already open here are skipped, not duplicated. */
export function importGroups(state: TabsState, seeds: GroupSeed[], activeIndex = 0, origin?: Origin | null): TabsState {
  const next = { ...state, groups: [...state.groups] };
  const seen = new Set(next.groups.flatMap((g) => g.panes.map((p) => p.path)));
  let active: string | undefined;
  seeds.forEach((seed, i) => {
    const paths = seed.paths.filter((p, at) => !seen.has(p) && seed.paths.indexOf(p) === at).slice(0, MAX_PANES);
    if (!paths.length) return;
    paths.forEach((p) => seen.add(p));
    const panes = paths.map((path) => ({ id: nextId(next, "p"), path, origin }));
    const sizes = seed.sizes?.length === paths.length && seed.sizes.every((n) => n > 0) ? seed.sizes : equalSizes(paths.length);
    const group = { ...makeGroup(next, panes, seed.layout === "rows" ? "rows" : "columns"), sizes };
    next.groups.push(group);
    if (i === activeIndex || !active) active = group.id;
  });
  if (active) next.active = active;
  return next;
}

/** The file a tab strip currently shows: the first pane of the active tab. */
export function activePane(state: TabsState): Pane | undefined {
  return (state.groups.find((g) => g.id === state.active) ?? state.groups[0])?.panes[0];
}

export function moveGroup(state: TabsState, groupId: string, index: number): TabsState {
  const from = state.groups.findIndex((g) => g.id === groupId);
  if (from < 0) return state;
  const groups = [...state.groups];
  const [group] = groups.splice(from, 1);
  groups.splice(Math.max(0, Math.min(groups.length, index)), 0, group);
  return { ...state, groups };
}
export function setLayout(state: TabsState, groupId: string, layout: SplitLayout): TabsState {
  if (state.groups.find((g) => g.id === groupId)?.layout === layout) return state;
  return { ...state, groups: state.groups.map((g) => (g.id === groupId && g.layout !== layout ? { ...g, layout, sizes: equalSizes(g.panes.length) } : g)) };
}
export function setSizes(state: TabsState, groupId: string, sizes: number[]): TabsState {
  return { ...state, groups: state.groups.map((g) => (g.id === groupId && sizes.length === g.panes.length ? { ...g, sizes } : g)) };
}
/** A markdown link inside a pane was followed: that pane shows the other file. */
export function replacePanePath(state: TabsState, paneId: string, path: string): TabsState {
  return { ...state, groups: state.groups.map((g) => (g.panes.some((p) => p.id === paneId) ? { ...g, panes: g.panes.map((p) => (p.id === paneId ? { ...p, path } : p)) } : g)) };
}

/** Pane rectangles inside `area`, separated by `gap` (the divider width). */
export function paneBoxes(area: Box, layout: SplitLayout, sizes: number[], gap = 6): Box[] {
  const count = sizes.length;
  const total = (layout === "columns" ? area.width : area.height) - gap * (count - 1);
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  let offset = 0;
  return sizes.map((size) => {
    const length = (size / sum) * total;
    const box = layout === "columns"
      ? { x: area.x + offset, y: area.y, width: length, height: area.height }
      : { x: area.x, y: area.y + offset, width: area.width, height: length };
    offset += length + gap;
    return box;
  });
}

/** New sizes after dragging the divider between pane `index` and `index + 1` to `pointer` (client coordinate). */
export function sizesFromDrag(area: Box, layout: SplitLayout, sizes: number[], index: number, pointer: number, gap = 6): number[] {
  if (index < 0 || index >= sizes.length - 1) return sizes;
  const count = sizes.length;
  const length = (layout === "columns" ? area.width : area.height) - gap * (count - 1);
  if (length <= 0) return sizes;
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  const fractions = sizes.map((s) => s / sum);
  const start = layout === "columns" ? area.x : area.y;
  const before = fractions.slice(0, index).reduce((a, b) => a + b, 0);
  const pair = fractions[index] + fractions[index + 1];
  const wanted = (pointer - start - gap * index - gap / 2) / length - before;
  const min = Math.min(MIN_PANE_FRACTION, pair / 2);
  const first = Math.max(min, Math.min(pair - min, wanted));
  const next = [...fractions];
  next[index] = first;
  next[index + 1] = pair - first;
  return next;
}

/** Dropping a dragged tab on tab `rects[i]`: the middle 40% merges, the outer 30% on each side reorder (before / after). */
export type DropAction = { kind: "merge"; index: number } | { kind: "move"; index: number };
export function dropTarget(rects: { left: number; width: number }[], x: number): DropAction | undefined {
  for (let i = 0; i < rects.length; i++) {
    const { left, width } = rects[i];
    if (x < left || x > left + width) continue;
    const at = (x - left) / width;
    if (at < 0.3) return { kind: "move", index: i };
    if (at > 0.7) return { kind: "move", index: i + 1 };
    return { kind: "merge", index: i };
  }
  if (rects.length && x < rects[0].left) return { kind: "move", index: 0 };
  if (rects.length) return { kind: "move", index: rects.length };
}
