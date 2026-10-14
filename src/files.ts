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
export type FilesState = { open: boolean; full: boolean; path?: string; follow: boolean; expanded: string[] };
// "list" is a tree with size/date columns; "columns" shows parent | current | preview.
export type FilesView = "list" | "columns";
export type SortKey = "name" | "size" | "modified";
export type Sort = { key: SortKey; descending: boolean };

export const MIN_WIDTH = 240;
export const DEFAULT_WIDTH = 360;

export function initialFiles(): FilesState {
  return { open: false, full: false, follow: true, expanded: [] };
}
export function toggleOpen(state: FilesState): FilesState {
  return state.open ? { ...state, open: false, full: false } : { ...state, open: true };
}
export function toggleFull(state: FilesState): FilesState {
  return { ...state, open: true, full: !state.full };
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
export function clampWidth(width: number, viewport: number) {
  return Math.round(Math.max(MIN_WIDTH, Math.min(width, Math.max(MIN_WIDTH, viewport * 0.7))));
}
export const DEFAULT_PREVIEW_HEIGHT = 220;
const MIN_PREVIEW_HEIGHT = 80;
// Bottom preview height in columns view; leaves at least room for the heading and a few rows.
export function clampPreviewHeight(height: number, panelHeight: number) {
  const max = Math.max(MIN_PREVIEW_HEIGHT, panelHeight * 0.7);
  return Math.round(Math.max(MIN_PREVIEW_HEIGHT, Math.min(height, max)));
}
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
  if (ms >= startOfToday) return `今天 ${time}`;
  if (ms >= startOfToday - 86400000) return `昨天 ${time}`;
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
// Fallback when the system has no localized type description.
export function fileKindLabel(name: string, isDir: boolean) {
  if (isDir) return "資料夾";
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? `${name.slice(dot + 1).toUpperCase()} 檔案` : "檔案";
}
