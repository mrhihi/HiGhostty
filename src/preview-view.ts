// Renders one file and keeps it fresh. Shared by the pane inside a tab
// (preview-panel.ts) and the standalone preview window (preview-window.ts):
// each supplies its own buttons through `actions` and decides what following a
// markdown link to another file means.
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { t } from "./i18n";
import { applyI18n, onLocaleChange } from "./i18n-runtime";
import { marked } from "marked";
import { highlightCode, renderCode, renderDiagram, renderMermaid, renderPage, renderPdf, renderSheet, renderSlides, renderWord, type Rendered } from "./preview-render";
import { clampFontSize, codeLanguage, DEFAULT_FONT_SIZE, isBinaryKind, linkTarget, localImagePath, previewKind, clampWidth, MAX_WIDTH_PCT, measureFor, parseWidthInput, WIDTH_PRESETS, sameStamp, scrollAfterUpdate, stepFontSize, type PreviewKind, type Stamp } from "./preview";

type Content = { mtimeMs: number; size: number; text?: string; dataUrl?: string; truncated: boolean; unsupported?: string };
export type PreviewViewHost = {
  notify(error: unknown): void;
  // A markdown link to another local .md file was followed.
  openFile(path: string): void;
};

const POLL_MS = 500;
// Markdown and plain text/code keep their own size: they differ in default and in what reads well.
const FONT_KEYS = { markdown: "preview-font-size", text: "preview-text-font-size" } as const;
const TEXT_DEFAULT_FONT_SIZE = 12;
type FontGroup = keyof typeof FONT_KEYS;
function storedFontSize(group: FontGroup): number {
  const fallback = group === "text" ? TEXT_DEFAULT_FONT_SIZE : DEFAULT_FONT_SIZE;
  try { return clampFontSize(Number(localStorage.getItem(FONT_KEYS[group]) ?? fallback)); } catch { return fallback; }
}
// Background of markdown / text / code, per group like the font size. Markdown has always been white; text follows the app.
const THEME_KEYS = { markdown: "preview-theme", text: "preview-text-theme" } as const;
type Theme = "light" | "dark";
function storedTheme(group: FontGroup): Theme {
  const fallback: Theme = group === "markdown" ? "light" : "dark";
  try { const value = localStorage.getItem(THEME_KEYS[group]); return value === "light" || value === "dark" ? value : fallback; } catch { return fallback; }
}
const WIDTH_KEY = "preview-width";
function storedWidth(): number {
  try { return clampWidth(Number(localStorage.getItem(WIDTH_KEY) ?? MAX_WIDTH_PCT)); } catch { return MAX_WIDTH_PCT; }
}
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
export const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) || path;

export function createPreviewView(host: PreviewViewHost) {
  const root = document.createElement("section");
  root.id = "preview";
  root.setAttribute("data-i18n-aria-label", "preview.label");
  root.innerHTML = `<header class="preview-head"><strong class="preview-name"></strong><span class="preview-time"></span><span class="preview-font"><button type="button" class="icon-btn" data-font="-1" data-i18n-title="preview.fontSmaller" data-i18n-aria-label="preview.fontSmaller">A−</button><button type="button" class="icon-btn" data-font="1" data-i18n-title="preview.fontLarger" data-i18n-aria-label="preview.fontLarger">A+</button></span><button type="button" class="icon-btn preview-theme" data-i18n-aria-label="preview.toggleBackground"></button><span class="preview-font preview-measure"><input type="text" inputmode="numeric" class="preview-width" value="100" size="3" data-i18n-title="preview.widthTitle" data-i18n-aria-label="preview.widthLabel"><span class="preview-pct">%</span><select class="preview-width-menu" data-i18n-title="preview.widthMenu" data-i18n-aria-label="preview.widthMenu">${WIDTH_PRESETS.map((n) => `<option value="${n}">${n}%</option>`).join("")}</select></span><button type="button" class="icon-btn preview-export" data-i18n-title="preview.exportPdfTitle" data-i18n-aria-label="preview.exportPdf">PDF</button><span class="preview-actions"></span></header><div class="preview-body" tabindex="0"></div>`;
  const name = root.querySelector<HTMLElement>(".preview-name")!;
  const time = root.querySelector<HTMLElement>(".preview-time")!;
  const actions = root.querySelector<HTMLElement>(".preview-actions")!;
  const body = root.querySelector<HTMLElement>(".preview-body")!;

  // Text size of rendered markdown, shared by every preview view through localStorage.
  const setFont = (group: FontGroup, size: number) => {
    body.style.setProperty(group === "text" ? "--preview-text-font" : "--preview-font", `${size}px`);
  };
  const widthInput = root.querySelector<HTMLInputElement>(".preview-width")!;
  const widthMenu = root.querySelector<HTMLSelectElement>(".preview-width-menu")!;
  const setWidth = (pct: number) => {
    body.style.setProperty("--preview-measure", measureFor(pct));
    widthInput.value = String(pct);
    widthMenu.selectedIndex = -1;
  };
  const themes: Record<FontGroup, Theme> = { markdown: storedTheme("markdown"), text: storedTheme("text") };
  const themeBtn = root.querySelector<HTMLButtonElement>(".preview-theme")!;
  const currentGroup = (): FontGroup => (root.classList.contains("is-text") ? "text" : "markdown");
  // Only markdown/word/text/code have a choice; PDF, slides and images keep their own look.
  const applyTheme = () => {
    const group = currentGroup();
    const choosable = root.classList.contains("is-markdown") || root.classList.contains("is-text");
    if (choosable) body.classList.toggle("light", themes[group] === "light");
    themeBtn.textContent = themes[group] === "light" ? "☀" : "☾";
    const label = t(themes[group] === "light" ? "preview.themeLight" : "preview.themeDark");
    themeBtn.title = label; themeBtn.setAttribute("aria-label", label);
    if (root.classList.contains("is-markdown")) void renderMermaid(body, themes.markdown === "light");
  };
  themeBtn.addEventListener("click", () => {
    const group = currentGroup();
    themes[group] = themes[group] === "light" ? "dark" : "light";
    try { localStorage.setItem(THEME_KEYS[group], themes[group]); } catch { /* the choice just is not remembered */ }
    applyTheme();
  });
  // 切換語系：重套靜態標籤、主題按鈕說明與「更新」時間。
  onLocaleChange(() => {
    applyI18n(root);
    applyTheme();
    if (updatedAt) time.textContent = t("preview.updated", { time: clock(updatedAt) });
  });
  applyI18n(root);
  let width = storedWidth();
  setWidth(width);
  const fontSizes: Record<FontGroup, number> = { markdown: storedFontSize("markdown"), text: storedFontSize("text") };
  setFont("markdown", fontSizes.markdown);
  setFont("text", fontSizes.text);
  root.querySelector(".preview-font")!.addEventListener("click", (event) => {
    const delta = Number((event.target as HTMLElement).closest<HTMLElement>("[data-font]")?.dataset.font);
    if (!delta) return;
    const group: FontGroup = root.classList.contains("is-text") ? "text" : "markdown";
    fontSizes[group] = stepFontSize(fontSizes[group], delta);
    setFont(group, fontSizes[group]);
    try { localStorage.setItem(FONT_KEYS[group], String(fontSizes[group])); } catch { /* the size just is not remembered */ }
  });
  const commitWidth = (pct: number) => {
    width = clampWidth(pct);
    setWidth(width);
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* the width just is not remembered */ }
  };
  widthInput.addEventListener("change", () => commitWidth(parseWidthInput(widthInput.value, width)));
  widthInput.addEventListener("keydown", (event) => { if (event.key === "Enter") widthInput.blur(); });
  widthMenu.addEventListener("change", () => commitWidth(Number(widthMenu.value)));
  window.addEventListener("storage", (event) => {
    const themeGroup = (Object.keys(THEME_KEYS) as FontGroup[]).find((key) => THEME_KEYS[key] === event.key);
    if (themeGroup) { themes[themeGroup] = storedTheme(themeGroup); applyTheme(); return; }
    const group = (Object.keys(FONT_KEYS) as FontGroup[]).find((key) => FONT_KEYS[key] === event.key);
    if (group) { fontSizes[group] = storedFontSize(group); setFont(group, fontSizes[group]); }
    else if (event.key === WIDTH_KEY) { width = storedWidth(); setWidth(width); }
  });

  // Export: a print-only copy of the rendered document goes into #print-root (hidden on
  // screen, the only thing shown when printing), then the native print sheet opens.
  root.querySelector(".preview-export")!.addEventListener("click", async () => {
    const doc = body.querySelector<HTMLElement>(".preview-markdown");
    if (!doc || !shownPath) return;
    let target = document.getElementById("print-root");
    if (!target) {
      target = document.createElement("div");
      target.id = "print-root";
      document.body.append(target);
    }
    const clone = doc.cloneNode(true) as HTMLElement;
    clone.removeAttribute("style");
    target.replaceChildren(clone);
    const title = document.title;
    document.title = baseName(shownPath).replace(/\.[^.]+$/, "");
    await renderMermaid(clone, true).catch(() => {}); // print is always on white
    window.addEventListener("afterprint", () => { document.title = title; target!.replaceChildren(); }, { once: true });
    invoke("preview_print").catch((error) => { document.title = title; host.notify(error); });
  });

  let shownPath: string | undefined;
  let updatedAt: Date | undefined;
  let stamp: Stamp | undefined;
  let missing = false;
  let timer: number | undefined;
  let busy = false;
  // Bumped whenever the target changes so a slow read never paints an old file.
  let generation = 0;

  let rendered: Rendered | undefined;
  const disposeRendered = () => { rendered?.dispose(); rendered = undefined; };
  function stop() {
    disposeRendered();
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    shownPath = undefined;
    stamp = undefined;
    missing = false;
    generation++;
  }
  function note(text: string) {
    body.replaceChildren();
    const p = document.createElement("p");
    p.className = "preview-note";
    p.textContent = text;
    body.append(p);
  }
  // Content is either text/image data from preview_read or raw bytes for library-rendered kinds.
  // Renders run one at a time and a stale one never starts, so an old file cannot paint over a newer one.
  let renderChain: Promise<void> = Promise.resolve();
  function render(path: string, kind: PreviewKind, content: Content | ArrayBuffer, mine: number, reset = false): Promise<void> {
    const run = renderChain.then(() => (mine === generation ? paint(path, kind, content, mine, reset) : undefined));
    renderChain = run.catch(() => {});
    return run;
  }
  async function paint(path: string, kind: PreviewKind, content: Content | ArrayBuffer, mine: number, reset = false) {
    const before = { top: body.scrollTop, height: body.scrollHeight, client: body.clientHeight };
    // Same diagram file refreshed: hand the new XML to the live viewer instead of rebuilding it.
    if ((kind === "diagram" || kind === "page") && !reset && rendered?.update && !(content instanceof ArrayBuffer) && content.text !== undefined) {
      try {
        await rendered.update(content.text);
      } catch (error) {
        disposeRendered(); // the caller shows the error in place of the frame
        throw error;
      }
      return;
    }
    disposeRendered();
    const bytes = content instanceof ArrayBuffer ? content : undefined;
    const data = bytes ? undefined : (content as Content);
    let next: Rendered | undefined;
    if (bytes) {
      next = kind === "pdf" ? await renderPdf(body, bytes) : kind === "word" ? await renderWord(body, bytes) : kind === "sheet" ? await renderSheet(body, bytes) : await renderSlides(body, bytes);
    } else if (data!.unsupported) note(data!.unsupported);
    else if (data!.dataUrl) {
      const img = document.createElement("img");
      img.className = "preview-image";
      img.alt = baseName(path);
      img.src = data!.dataUrl;
      body.replaceChildren(img);
    } else {
      const text = data!.text ?? "";
      if (kind === "markdown") {
        const view = document.createElement("div");
        view.className = "preview-markdown";
        view.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }) as string);
        body.replaceChildren(view);
        await loadLocalImages(view, path, mine);
        await renderMermaid(view, themes.markdown === "light");
        await highlightFences(view);
      } else if (kind === "diagram") {
        next = await renderDiagram(body, text);
      } else if (kind === "page") {
        next = await renderPage(body, path);
      } else if (kind === "code") {
        next = await renderCode(body, text, codeLanguage(path));
      } else {
        const pre = document.createElement("pre");
        pre.className = "preview-text";
        pre.textContent = text;
        body.replaceChildren(pre);
      }
      if (data!.truncated) {
        const warning = document.createElement("p");
        warning.className = "preview-note";
        warning.textContent = t("preview.truncated");
        body.append(warning);
      }
    }
    if (mine !== generation) { next?.dispose(); return; }
    rendered = next;
    const failed = !bytes && !!data!.unsupported;
    const light = !failed && (kind === "slides" || kind === "pdf" || kind === "diagram" || kind === "page");
    body.classList.toggle("light", light && !(data && data.dataUrl));
    root.classList.toggle("is-markdown", (kind === "markdown" || kind === "word") && !failed);
    root.classList.toggle("is-text", (kind === "text" || kind === "code") && !failed);
    applyTheme();
    // A newly opened file starts at the top; only later refreshes follow the bottom.
    body.scrollTop = reset ? 0 : scrollAfterUpdate(before, body.scrollHeight, body.clientHeight);
  }
  // Relative image paths resolve against the Markdown file's folder; the app origin cannot serve them.
  async function loadLocalImages(view: HTMLElement, path: string, mine: number) {
    await Promise.all([...view.querySelectorAll<HTMLImageElement>("img")].map(async (img) => {
      const file = localImagePath(img.getAttribute("src") ?? "", path);
      if (!file) return;
      try {
        const got = await invoke<Content>("preview_read", { path: file, kind: "image" });
        if (mine === generation && got.dataUrl) img.src = got.dataUrl;
      } catch { /* leave the broken image; alt text shows */ }
    }));
  }
  // Fenced blocks (```ts) get highlighted after sanitizing; the highlighted HTML is sanitized again.
  async function highlightFences(view: HTMLElement) {
    for (const code of view.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
      const lang = /language-([\w+-]+)/.exec(code.className)?.[1];
      const html = await highlightCode(code.textContent ?? "", lang).catch(() => undefined);
      if (html !== undefined) { code.innerHTML = DOMPurify.sanitize(html); code.classList.add("hljs"); }
    }
  }
  async function load(path: string, first: boolean) {
    const mine = generation;
    const kind = previewKind(path);
    try {
      let content: Content | ArrayBuffer;
      if (isBinaryKind(kind)) {
        const next = await invoke<Stamp>("preview_stat", { path });
        content = await invoke<ArrayBuffer>("preview_bytes", { path });
        if (mine !== generation) return;
        stamp = next;
      } else {
        const text = await invoke<Content>("preview_read", { path, kind });
        if (mine !== generation) return;
        stamp = { mtimeMs: text.mtimeMs, size: text.size };
        content = text;
      }
      missing = false;
      try {
        await render(path, kind, content, mine, first);
      } catch (error) {
        if (mine !== generation) return;
        note(t("preview.cannotPreview", { error: String(error) }));
      }
      if (mine !== generation) return;
      updatedAt = new Date();
      time.textContent = t("preview.updated", { time: clock(updatedAt) });
    } catch (error) {
      if (mine !== generation) return;
      stamp = undefined;
      missing = true;
      note(t("preview.waiting", { error: String(error) }));
    }
  }
  async function poll() {
    const path = shownPath;
    if (!path || busy) return;
    busy = true;
    const mine = generation;
    try {
      const next = await invoke<Stamp>("preview_stat", { path });
      if (mine !== generation) return;
      if (!sameStamp(stamp, next)) await load(path, false);
    } catch (error) {
      if (mine !== generation) return;
      if (!missing) {
        missing = true;
        stamp = undefined;
        note(t("preview.waiting", { error: String(error) }));
      }
    } finally {
      busy = false;
    }
  }
  function show(path: string) {
    stop();
    shownPath = path;
    name.textContent = baseName(path);
    name.title = path;
    time.textContent = "";
    updatedAt = undefined;
    note(t("preview.loading"));
    load(path, true).catch(host.notify);
    timer = window.setInterval(() => poll().catch(host.notify), POLL_MS);
  }

  function followLink(href: string) {
    if (!shownPath) return;
    const next = linkTarget(href, shownPath);
    if (next.kind === "web") invoke("preview_open_url", { url: next.url }).catch(host.notify);
    else if (next.kind === "file") host.openFile(next.path);
  }
  body.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    event.preventDefault();
    followLink(link.getAttribute("href") || "");
  });

  return { root, actions, shown: () => shownPath, show, stop };
}
