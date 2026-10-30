import { t } from "./i18n.ts";
// Pure state for the per-tab files panel; main.ts owns the DOM.
export type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified_ms: number;
  has_children: boolean;
};
// columnRoot: leftmost folder shown in columns view (memory only).
// detached: the panel lives in its own window (open stays true); the tab's own panel stays hidden.
export type FilesState = { open: boolean; path?: string; follow: boolean; expanded: string[]; columnRoot?: string; view?: FilesView; detached?: boolean };
// The panel is showing inside the tab (not closed, not popped out).
export const shownInTab = (state: FilesState | undefined): boolean => !!state?.open && !state.detached;
// "list" is a tree with size/date columns; "columns" is a row of columns, one per folder level.
export type FilesView = "list" | "columns";
export type SortKey = "name" | "size" | "modified";
export type Sort = { key: SortKey; descending: boolean };

export const MIN_HEIGHT = 160;
export const DEFAULT_HEIGHT_RATIO = 0.5;

export function initialFiles(): FilesState {
  return { open: false, follow: true, expanded: [] };
}
// What survives a restart: panel visibility, where it was browsing and which folders were open.
export type SavedFiles = { open: true; path?: string; follow?: boolean; expanded?: string[]; columnRoot?: string; view?: FilesView; detached?: true };
export function saveFiles(state: FilesState | undefined): SavedFiles | undefined {
  if (!state?.open) return undefined;
  return { open: true, path: state.path, follow: state.follow, expanded: state.expanded.length ? state.expanded : undefined, columnRoot: state.columnRoot, view: state.view, ...(state.detached ? { detached: true as const } : {}) };
}
// Saved data may be old or hand-edited: keep only well-formed fields.
export function restoreFiles(saved: Partial<SavedFiles> | undefined): FilesState | undefined {
  if (!saved?.open) return undefined;
  const path = typeof saved.path === "string" && saved.path.startsWith("/") ? saved.path : undefined;
  const expanded = path && Array.isArray(saved.expanded) ? saved.expanded.filter((item): item is string => typeof item === "string" && item.startsWith(path)) : [];
  const columnRoot = path && typeof saved.columnRoot === "string" && path.startsWith(saved.columnRoot) ? saved.columnRoot : undefined;
  const view = saved.view === "list" || saved.view === "columns" ? saved.view : undefined;
  return { open: true, path, follow: path ? saved.follow !== false : true, expanded, columnRoot, view, ...(saved.detached === true ? { detached: true } : {}) };
}
export const sameSaved = (a: SavedFiles | undefined, b: SavedFiles | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function toggleOpen(state: FilesState): FilesState {
  return state.open ? withoutDetached({ ...state, open: false }) : { ...state, open: true };
}
// Pop the panel out into its own window, or bring it back into the tab.
const withoutDetached = (state: FilesState): FilesState => { const { detached: _detached, ...rest } = state; return rest; };
export function setDetached(state: FilesState, detached: boolean): FilesState {
  return detached ? { ...state, open: true, detached: true } : withoutDetached({ ...state, open: true });
}
// The panel follows the terminal's cwd until the user browses elsewhere.
export function onCwd(state: FilesState, cwd: string): FilesState {
  if (!state.follow || state.path === cwd) return state;
  return { ...state, path: cwd, expanded: [] };
}
export function navigate(state: FilesState, path: string, cwd: string | undefined): FilesState {
  if (state.path === path) return state;
  return { ...state, path, follow: !!cwd && path === cwd, expanded: [] };
}
export function returnToCwd(state: FilesState, cwd: string): FilesState {
  return { ...state, path: cwd, follow: true, expanded: [] };
}
export function toggleExpanded(state: FilesState, path: string, expanded?: boolean): FilesState {
  const has = state.expanded.includes(path);
  const next = expanded ?? !has;
  if (next === has) return state;
  return {
    ...state,
    expanded: next
      ? [...state.expanded, path]
      // Collapsing a folder also forgets the folders expanded inside it.
      : state.expanded.filter((item) => item !== path && !item.startsWith(path + "/")),
  };
}

export type Selection = { paths: string[]; anchor?: string };
// `order` is the visible row order; it resolves shift ranges.
export function select(
  selection: Selection,
  path: string,
  order: string[],
  modifiers: { toggle?: boolean; range?: boolean } = {},
): Selection {
  if (modifiers.range && selection.anchor && order.includes(selection.anchor)) {
    const a = order.indexOf(selection.anchor), b = order.indexOf(path);
    const [from, to] = a < b ? [a, b] : [b, a];
    return { paths: order.slice(from, to + 1), anchor: selection.anchor };
  }
  if (modifiers.toggle) {
    const paths = selection.paths.includes(path)
      ? selection.paths.filter((item) => item !== path)
      : [...selection.paths, path];
    return { paths, anchor: path };
  }
  return { paths: [path], anchor: path };
}
export function moveSelection(selection: Selection, order: string[], delta: number, extend = false): Selection {
  if (!order.length) return { paths: [] };
  const current = selection.paths.length ? selection.paths.at(-1)! : undefined;
  const index = current === undefined ? (delta > 0 ? -1 : order.length) : order.indexOf(current);
  const target = order[Math.max(0, Math.min(order.length - 1, index + delta))];
  if (!extend) return { paths: [target], anchor: target };
  const anchor = selection.anchor ?? target;
  const a = order.indexOf(anchor), b = order.indexOf(target);
  const [from, to] = a < b ? [a, b] : [b, a];
  const range = order.slice(from, to + 1);
  // Keep the moving end last so the next arrow continues from it.
  return { paths: [...range.filter((item) => item !== target), target], anchor };
}
// Drop paths that no longer exist after a refresh.
export function pruneSelection(selection: Selection, order: string[]): Selection {
  const paths = selection.paths.filter((path) => order.includes(path));
  return { paths, anchor: selection.anchor && order.includes(selection.anchor) ? selection.anchor : paths[0] };
}

export function sortEntries(entries: FileEntry[], sort: Sort): FileEntry[] {
  const sign = sort.descending ? -1 : 1;
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    const diff =
      sort.key === "size" ? a.size - b.size
      : sort.key === "modified" ? a.modified_ms - b.modified_ms
      : byName(a, b);
    return sign * (diff || byName(a, b));
  });
}

function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  // Dotfiles such as ".env" have no extension.
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}
// Selects the stem of a file name, like Finder's rename field.
export function stemLength(name: string, isDir: boolean) {
  return isDir ? name.length : splitExtension(name)[0].length;
}
export function shellQuote(path: string) {
  return `'${path.replaceAll("'", "'\\''")}'`;
}
// Height of the drop-down panel; leaves some terminal visible below it (drag targets).
export function clampDropHeight(height: number, workspaceHeight: number) {
  return Math.round(Math.max(MIN_HEIGHT, Math.min(height, Math.max(MIN_HEIGHT, workspaceHeight * 0.85))));
}
export function defaultDropHeight(workspaceHeight: number) {
  return clampDropHeight(workspaceHeight * DEFAULT_HEIGHT_RATIO, workspaceHeight);
}
// Backslash-escaped path for pasting into a shell (what dropping a file on a terminal inserts).
// Keep in sync with escapePath in src-tauri/native/bridge.m.
export function shellEscape(path: string) {
  if (/[\u0000-\u001f\u007f]/.test(path)) return `$'${path.replace(/[\\']/g, "\\$&").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}'`;
  return path.replace(/[^A-Za-z0-9_@%+=:,./~\-\u0080-\uffff]/g, "\\$&");
}
// The list collapses to an icon rail only while a preview is showing next to it; with no preview
// (closed, or the overlay too narrow for it) the list is always expanded.
export const effectiveCollapsed = (collapsed: boolean, previewVisible: boolean): boolean => collapsed && previewVisible;
export function formatSize(size: number, isDir: boolean) {
  if (isDir) return "—";
  if (size < 1000) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
export function formatDate(ms: number, now = Date.now()) {
  if (!ms) return "—";
  const date = new Date(ms), today = new Date(now);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday) return t("files.date.today", { time });
  if (ms >= startOfToday - 86400000) return t("files.date.yesterday", { time });
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
// Paths whose parent folder is also listed act on the folder only.
export function topLevelPaths(paths: string[]) {
  return paths.filter((path) => !paths.some((other) => other !== path && path.startsWith(other + "/")));
}
export function parentOf(path: string) {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed.slice(0, trimmed.lastIndexOf("/")) || "/";
}
// What the preview column shows for the current selection.
export function previewTarget(selection: Selection, entries: Map<string, FileEntry>):
  | { kind: "none" }
  | { kind: "many"; count: number }
  | { kind: "dir" | "file"; entry: FileEntry } {
  const chosen = selection.paths.filter((path) => entries.has(path));
  if (!chosen.length) return { kind: "none" };
  if (chosen.length > 1) return { kind: "many", count: chosen.length };
  const entry = entries.get(chosen[0])!;
  return { kind: entry.is_dir ? "dir" : "file", entry };
}
// Leftmost column folder: kept while the path stays below it, otherwise the
// parent of the path (parent | current | child at the start).
export function columnRootFor(root: string | undefined, path: string) {
  if (root && root !== path && path.startsWith(root === "/" ? "/" : root + "/")) return root;
  return parentOf(path);
}
// Folders listed in the columns left of the current one, leftmost first.
export function columnChain(root: string | undefined, path: string) {
  if (path === "/") return [];
  const top = columnRootFor(root, path);
  const chain: string[] = [];
  for (let dir = parentOf(path); ; dir = parentOf(dir)) {
    chain.unshift(dir);
    if (dir === top || dir === "/") break;
  }
  return chain;
}
export const DEFAULT_COLUMN_WIDTH = 200;
const MIN_COLUMN_WIDTH = 120, MAX_COLUMN_WIDTH = 800;
export function clampColumnWidth(width: number) {
  return Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(width, MAX_COLUMN_WIDTH)));
}
// Remembered width per folder; the default width is not stored, and the
// oldest entries go once the map passes `limit`.
export function rememberColumnWidth(widths: Record<string, number>, path: string, width: number, limit = 300) {
  const next = { ...widths };
  delete next[path];
  const clamped = clampColumnWidth(width);
  if (clamped !== DEFAULT_COLUMN_WIDTH) next[path] = clamped;
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) delete next[key];
  return next;
}
// Forgets widths of folders that are gone. `listing` is the folder's entries,
// or undefined when it could not be read (then it and everything below it goes).
// Hidden folders are kept while hidden files are not listed.
export function pruneColumnWidths(widths: Record<string, number>, dir: string, listing: FileEntry[] | undefined, showHidden: boolean) {
  const prefix = dir === "/" ? "/" : dir + "/";
  const names = new Set((listing || []).map((entry) => entry.path));
  const gone = (path: string) => {
    if (!listing) return path === dir || path.startsWith(prefix);
    if (!path.startsWith(prefix)) return false;
    const child = prefix + path.slice(prefix.length).split("/")[0];
    return !names.has(child) && (showHidden || !child.slice(prefix.length).startsWith("."));
  };
  const keys = Object.keys(widths).filter(gone);
  if (!keys.length) return widths;
  const next = { ...widths };
  for (const key of keys) delete next[key];
  return next;
}
