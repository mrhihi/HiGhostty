import { activePane, emptyTabs, importGroups, openPath, type GroupSeed, type TabsState } from "./preview-tabs.ts";

// Pure state for the per-tab preview pane that sits in the right half of the files
// overlay. DOM lives in preview-panel.ts; nothing here touches the window.
// The pane holds a tab strip (preview-tabs.ts); `tabs` is that state.
export type PreviewState = { tabs: TabsState };
export type Box = { x: number; y: number; width: number; height: number };
export type PreviewKind = "markdown" | "code" | "text" | "image" | "pdf" | "sheet" | "word" | "slides" | "diagram" | "page" | "video";

export const DEFAULT_RATIO = 0.5;
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;
// Below this overlay width the preview is hidden instead of squeezed into a useless sliver.
export const MIN_OVERLAY_WIDTH = 560;
// Smallest width of either half while the divider is dragged.
export const MIN_HALF_WIDTH = 240;

export const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : DEFAULT_RATIO;

/** Share of the overlay width given to the preview, keeping both halves usable. */
export function clampPreviewRatio(ratio: number, width: number): number {
  const base = clampRatio(ratio);
  if (!(width > 0)) return base;
  const min = MIN_HALF_WIDTH / width;
  return Math.min(Math.max(base, min), Math.max(min, 1 - min));
}

/** The overlay is wide enough to show the preview next to the list. */
export const previewFits = (width: number): boolean => width >= MIN_OVERLAY_WIDTH;

/** Ratio after dragging the divider to `pointer` (client x), in an overlay spanning `left`..`left + width`. */
export function ratioFromPointer(left: number, width: number, pointer: number): number {
  return clampPreviewRatio(1 - (pointer - left) / Math.max(1, width), width);
}

export function openPreview(path: string): PreviewState {
  return { tabs: openPath(emptyTabs(), path) };
}

/** Path of the file shown first (the active tab's first pane). */
export const previewPath = (state: PreviewState): string | undefined => activePane(state.tabs)?.path;

/** An explicitly opened file gets its own tab; the same file only activates its tab. */
export function addPreviewFile(state: PreviewState | undefined, path: string): PreviewState {
  return state ? { ...state, tabs: openPath(state.tabs, path) } : openPreview(path);
}

/** Tabs sent back from the preview window join the pane as they were (merged groups included). */
export function importPreviewGroups(state: PreviewState | undefined, seeds: GroupSeed[], activeIndex = 0): PreviewState {
  const base: PreviewState = state ?? { tabs: emptyTabs() };
  return { ...base, tabs: importGroups(base.tabs, seeds, activeIndex) };
}

const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
// Formats WKWebView plays natively (no mkv/avi).
const VIDEO = new Set(["mp4", "m4v", "mov", "webm"]);
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
  if (VIDEO.has(ext)) return "video";
  if (BINARY_KINDS[ext]) return BINARY_KINDS[ext];
  return codeLanguage(path) ? "code" : "text";
}

// Kinds read as raw bytes (preview_bytes) and rendered by a library.
export const isBinaryKind = (kind: PreviewKind): boolean =>
  kind === "pdf" || kind === "sheet" || kind === "word" || kind === "slides";

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
