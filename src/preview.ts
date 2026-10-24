import { activePane, emptyTabs, importGroups, openPath, replacePanePath, type GroupSeed, type TabsState } from "./preview-tabs.ts";

// Pure state for the per-tab preview pane that sits beside (or below) the
// terminals. DOM lives in preview-panel.ts; nothing here touches the window.
export type PreviewSide = "right" | "bottom";
// The pane beside the terminals holds a tab strip (preview-tabs.ts); `tabs` is that state.
export type PreviewState = { side: PreviewSide; ratio: number; tabs: TabsState };
export type Box = { x: number; y: number; width: number; height: number };
export type PreviewKind = "markdown" | "code" | "text" | "image" | "pdf" | "sheet" | "word" | "slides" | "diagram" | "page";

export const DEFAULT_RATIO = 0.45;
export const DEFAULT_SIDE: PreviewSide = "bottom";
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;
// Below this the pane is hidden instead of shrunk to a useless sliver.
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

export const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : DEFAULT_RATIO;

export function isPreviewSide(value: unknown): value is PreviewSide {
  return value === "right" || value === "bottom";
}

export function openPreview(path: string, side: PreviewSide = DEFAULT_SIDE, ratio = DEFAULT_RATIO): PreviewState {
  return { side, ratio: clampRatio(ratio), tabs: openPath(emptyTabs(), path) };
}

/** Path of the file shown first (the active tab's first pane). */
export const previewPath = (state: PreviewState): string | undefined => activePane(state.tabs)?.path;

/** An explicitly opened file gets its own tab; the same file only activates its tab. */
export function addPreviewFile(state: PreviewState, path: string, side?: PreviewSide): PreviewState {
  return { ...state, side: side ?? state.side, tabs: openPath(state.tabs, path) };
}

/** Tabs sent back from the preview window join the pane as they were (merged groups included). */
export function importPreviewGroups(state: PreviewState | undefined, seeds: GroupSeed[], activeIndex = 0, side: PreviewSide = DEFAULT_SIDE): PreviewState {
  const base: PreviewState = state ?? { side, ratio: DEFAULT_RATIO, tabs: emptyTabs() };
  return { ...base, tabs: importGroups(base.tabs, seeds, activeIndex) };
}

/** Files-panel navigation: the active pane shows the other file instead of piling up tabs. */
export function followPreviewFile(state: PreviewState, path: string): PreviewState {
  const pane = activePane(state.tabs);
  if (!pane || pane.path === path) return state;
  return { ...state, tabs: replacePanePath(state.tabs, pane.id, path) };
}

export function togglePreviewSide(state: PreviewState): PreviewState {
  return { ...state, side: state.side === "right" ? "bottom" : "right" };
}

const DIAGRAM = new Set(["drawio", "dio"]);
const PAGE = new Set(["html", "htm", "xhtml"]);
const BINARY_KINDS: Record<string, PreviewKind> = { pdf: "pdf", xlsx: "sheet", xlsm: "sheet", docx: "word", pptx: "slides" };
// File extension (lowercase) or undefined; a leading dot alone is not an extension.
function extensionOf(path: string): string {
  const name = path.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// highlight.js language per extension; whole file names (Makefile...) are matched first.
const CODE_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  rs: "rust", py: "python", go: "go", swift: "swift", m: "objectivec", mm: "objectivec",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", java: "java", kt: "kotlin", kts: "kotlin",
  rb: "ruby", sh: "bash", bash: "bash", zsh: "bash", json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", css: "css", html: "xml", htm: "xml",
  xml: "xml", plist: "xml", sql: "sql", lua: "lua", php: "php", cs: "csharp", diff: "diff", patch: "diff",
};
const CODE_NAME: Record<string, string> = { makefile: "makefile", dockerfile: "dockerfile" };

export function codeLanguage(path: string): string | undefined {
  const name = (path.split("/").pop() || "").toLowerCase();
  return CODE_NAME[name] ?? CODE_EXT[extensionOf(path)];
}

export const isMermaidLang = (className: string): boolean => /(?:^|\s)language-mermaid(?:\s|$)/.test(className);
export const mermaidTheme = (light: boolean): "default" | "dark" => (light ? "default" : "dark");

export function previewKind(path: string): PreviewKind {
  const ext = extensionOf(path);
  if (MARKDOWN.has(ext)) return "markdown";
  if (IMAGE.has(ext)) return "image";
  if (DIAGRAM.has(ext)) return "diagram";
  if (PAGE.has(ext)) return "page";
  if (BINARY_KINDS[ext]) return BINARY_KINDS[ext];
  return codeLanguage(path) ? "code" : "text";
}

// Kinds read as raw bytes (preview_bytes) and rendered by a library.
export const isBinaryKind = (kind: PreviewKind): boolean =>
  kind === "pdf" || kind === "sheet" || kind === "word" || kind === "slides";

// Splits the terminal area in two. `gap` is the divider between them. When the
// box is too small for a usable pane the preview is dropped and the terminals
// keep everything.
export function splitBox(box: Box, preview: PreviewState | undefined, gap = 6): { terminals: Box; preview?: Box } {
  if (!preview) return { terminals: box };
  const ratio = clampRatio(preview.ratio);
  if (preview.side === "right") {
    const span = Math.max(0, box.width - gap);
    const width = Math.round(span * ratio);
    if (width < MIN_WIDTH || span - width < MIN_WIDTH) return { terminals: box };
    const terminalWidth = span - width;
    return {
      terminals: { ...box, width: terminalWidth },
      preview: { x: box.x + terminalWidth + gap, y: box.y, width, height: box.height },
    };
  }
  const span = Math.max(0, box.height - gap);
  const height = Math.round(span * ratio);
  if (height < MIN_HEIGHT || span - height < MIN_HEIGHT) return { terminals: box };
  const terminalHeight = span - height;
  return {
    terminals: { ...box, height: terminalHeight },
    preview: { x: box.x, y: box.y + terminalHeight + gap, width: box.width, height },
  };
}

// Ratio after dragging the divider to `pointer` (pixel offset inside `box`).
export function ratioFromPointer(box: Box, side: PreviewSide, pointer: number, gap = 6): number {
  const span = Math.max(1, (side === "right" ? box.width : box.height) - gap);
  const start = side === "right" ? box.x : box.y;
  return clampRatio(1 - (pointer - start - gap / 2) / span);
}

export type Scroll = { top: number; height: number; client: number };
const NEAR_BOTTOM = 24;
// Where to scroll after the content changed: stay glued to the bottom if the
// reader was at the bottom (follows an agent that keeps appending), otherwise
// keep the same offset.
export function scrollAfterUpdate(before: Scroll, afterHeight: number, afterClient: number): number {
  const atBottom = before.height - before.top - before.client <= NEAR_BOTTOM;
  const max = Math.max(0, afterHeight - afterClient);
  return atBottom ? max : Math.min(before.top, max);
}

export const DEFAULT_FONT_SIZE = 16;
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 32;
// Markdown text size in px: anything unusable falls back to the default.
export function clampFontSize(size: number): number {
  return Number.isFinite(size) ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size))) : DEFAULT_FONT_SIZE;
}
// Markdown column width as a percent of the pane, independent of text size. Defaults to the full width.
export const MIN_WIDTH_PCT = 30;
export const MAX_WIDTH_PCT = 100;
export function clampWidth(pct: number): number {
  return Number.isFinite(pct) && pct > 0 ? Math.min(MAX_WIDTH_PCT, Math.max(MIN_WIDTH_PCT, Math.round(pct))) : MAX_WIDTH_PCT;
}
export const WIDTH_PRESETS = [30, 40, 50, 60, 70, 80, 90, 100];
// Typed width: digits with an optional % sign; anything else keeps the current width.
export function parseWidthInput(text: string, current: number): number {
  const m = /^\s*(\d{1,3})\s*%?\s*$/.exec(text);
  return m ? clampWidth(Number(m[1])) : current;
}
export const measureFor = (pct: number): string => `${clampWidth(pct)}%`;
export const stepFontSize = (size: number, delta: number): number => clampFontSize(size + delta);

export type Stamp = { mtimeMs: number; size: number };
export const sameStamp = (a: Stamp | undefined, b: Stamp | undefined): boolean =>
  !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;

// Resolves a markdown link. Web links open in the browser, other markdown
// files open in the pane itself; everything else is ignored.
export type LinkTarget = { kind: "web"; url: string } | { kind: "file"; path: string } | { kind: "none" };
export function linkTarget(href: string, currentPath: string): LinkTarget {
  if (/^https?:\/\//i.test(href)) return { kind: "web", url: href };
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "none" };
  const clean = decodeURIComponent(href.split("#")[0].split("?")[0]);
  if (!clean || previewKind(clean) !== "markdown") return { kind: "none" };
  return { kind: "file", path: resolveRelative(clean, currentPath) };
}

// Joins a relative (or absolute) path against the folder of the file that references it.
export function resolveRelative(clean: string, currentPath: string): string {
  const base = clean.startsWith("/") ? [] : currentPath.split("/").slice(0, -1);
  const parts = [...base];
  for (const part of clean.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.filter(Boolean).join("/");
}

// Local image path for a Markdown <img src>; web, data: and other schemes are left alone.
export function localImagePath(src: string, currentPath: string): string | undefined {
  if (!src || src.startsWith("#") || src.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(src)) return undefined;
  let clean: string;
  try { clean = decodeURIComponent(src.split("#")[0].split("?")[0]); } catch { return undefined; }
  return clean && previewKind(clean) === "image" ? resolveRelative(clean, currentPath) : undefined;
}

// A favorite's default preview is stored relative to the tab's working directory.
export function relativeToDir(dir: string, path: string): string | undefined {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  if (!path.startsWith(base) || path.length === base.length) return undefined;
  const rel = path.slice(base.length);
  return rel.split("/").includes("..") ? undefined : rel;
}
export function resolveInDir(dir: string, rel: string): string | undefined {
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return undefined;
  return `${dir.endsWith("/") ? dir : `${dir}/`}${rel}`;
}
