// Renderers for the kinds that need a library: code highlighting, pdf, word,
// slides. Each library is loaded on first use so the main bundle stays small.
// Anything that becomes HTML goes through DOMPurify before it reaches the DOM.
import DOMPurify from "dompurify";
import { t } from "./i18n";
import { isMermaidLang, mermaidTheme } from "./preview";

// Over this size highlighting is skipped: it blocks the UI thread on huge files.
export const MAX_HIGHLIGHT = 512 * 1024;

// `update` lets a renderer take new content for the same file without being rebuilt.
export type Rendered = { dispose(): void; update?(text: string): Promise<void> };
const none: Rendered = { dispose() {} };

let hljsReady: Promise<typeof import("highlight.js/lib/common").default> | undefined;
// `common` covers preview.ts' CODE_EXT except dockerfile, registered here; anything unknown falls back to plain text.
export async function highlightCode(text: string, language: string | undefined): Promise<string | undefined> {
  if (!language || text.length > MAX_HIGHLIGHT) return undefined;
  hljsReady ??= Promise.all([import("highlight.js/lib/common"), import("highlight.js/lib/languages/dockerfile")]).then(([common, dockerfile]) => {
    common.default.registerLanguage("dockerfile", dockerfile.default);
    return common.default;
  });
  const hljs = await hljsReady;
  if (!hljs.getLanguage(language)) return undefined;
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}

export async function renderCode(body: HTMLElement, text: string, language: string | undefined): Promise<Rendered> {
  const pre = document.createElement("pre");
  pre.className = "preview-text";
  const code = document.createElement("code");
  code.className = "hljs";
  const html = await highlightCode(text, language);
  if (html === undefined) code.textContent = text;
  // highlight.js escapes the source; sanitize anyway so no path leaves raw HTML unchecked.
  else code.innerHTML = DOMPurify.sanitize(html);
  pre.append(code);
  body.replaceChildren(pre);
  return none;
}

export async function renderPdf(body: HTMLElement, bytes: ArrayBuffer): Promise<Rendered> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const wrap = document.createElement("div");
  wrap.className = "preview-pdf";
  body.replaceChildren(wrap);

  const pages: HTMLCanvasElement[] = [];
  const drawn = new Map<HTMLCanvasElement, number>();
  let disposed = false;
  const draw = async (canvas: HTMLCanvasElement, number: number) => {
    const width = wrap.clientWidth;
    if (!width || drawn.get(canvas) === width) return;
    drawn.set(canvas, width);
    const page = await doc.getPage(number);
    if (disposed) return;
    const base = page.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (width / base.width) * ratio });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
    await page.render({ canvas, viewport }).promise;
  };
  // Only pages near the viewport are painted.
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const canvas = entry.target as HTMLCanvasElement;
          draw(canvas, pages.indexOf(canvas) + 1).catch(() => {});
        }
      }
    },
    { root: body, rootMargin: "600px 0px" },
  );
  for (let n = 1; n <= doc.numPages; n++) {
    const canvas = document.createElement("canvas");
    canvas.className = "preview-pdf-page";
    // Reserve height from the first page so the scrollbar is roughly right before painting.
    canvas.style.aspectRatio = "1 / 1.414";
    canvas.style.width = "100%";
    pages.push(canvas);
    wrap.append(canvas);
    seen.observe(canvas);
  }
  let timer: number | undefined;
  const resized = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      drawn.clear();
      pages.forEach((canvas, i) => {
        const r = canvas.getBoundingClientRect(), b = body.getBoundingClientRect();
        if (r.bottom > b.top - 600 && r.top < b.bottom + 600) draw(canvas, i + 1).catch(() => {});
      });
    }, 150);
  });
  resized.observe(wrap);
  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      seen.disconnect();
      resized.disconnect();
      task.destroy().catch(() => {});
    },
  };
}

export async function renderWord(body: HTMLElement, bytes: ArrayBuffer): Promise<Rendered> {
  const mammoth = (await import("mammoth/mammoth.browser")).default;
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes });
  const view = document.createElement("div");
  view.className = "preview-markdown";
  view.innerHTML = DOMPurify.sanitize(result.value);
  body.replaceChildren(view);
  return none;
}

export async function renderSlides(body: HTMLElement, bytes: ArrayBuffer): Promise<Rendered> {
  const { init } = await import("pptx-preview");
  const holder = document.createElement("div");
  holder.className = "preview-slides";
  body.replaceChildren(holder);
  const width = Math.max(320, body.clientWidth - 32);
  const previewer = init(holder, { width, height: Math.round((width * 9) / 16), mode: "list" });
  await previewer.preview(bytes);
  return { dispose: () => { try { previewer.destroy(); } catch { /* already gone */ } } };
}

const MAX_ROWS = 5000;
const MAX_COLS = 200;
const cell = (value: unknown): string =>
  value == null ? "" : value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);

// .xlsx: one table per sheet, tabs on top. Cells are set with textContent, so nothing in the
// file can become markup. Values only: formulas show their cached result, no cell styling.
export async function renderSheet(body: HTMLElement, bytes: ArrayBuffer): Promise<Rendered> {
  const { default: readExcel } = await import("read-excel-file/universal");
  const sheets = (await readExcel(bytes)) as { sheet: string; data: unknown[][] }[];
  const wrap = document.createElement("div");
  wrap.className = "preview-sheet";
  if (!sheets.length) {
    wrap.textContent = t("preview.emptyWorkbook");
    body.replaceChildren(wrap);
    return none;
  }
  const tabs = document.createElement("div");
  tabs.className = "preview-sheet-tabs";
  const scroller = document.createElement("div");
  scroller.className = "preview-sheet-body";
  const show = (index: number) => {
    const { data } = sheets[index];
    const rows = data.slice(0, MAX_ROWS);
    const cols = Math.min(MAX_COLS, rows.reduce((n, row) => Math.max(n, row.length), 0));
    const table = document.createElement("table");
    const head = document.createElement("tr");
    head.append(document.createElement("th"));
    for (let c = 0; c < cols; c++) {
      const th = document.createElement("th");
      th.textContent = columnName(c);
      head.append(th);
    }
    const thead = document.createElement("thead");
    thead.append(head);
    const tbody = document.createElement("tbody");
    rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      const num = document.createElement("th");
      num.textContent = String(r + 1);
      tr.append(num);
      for (let c = 0; c < cols; c++) {
        const td = document.createElement("td");
        td.textContent = cell(row[c]);
        tr.append(td);
      }
      tbody.append(tr);
    });
    table.append(thead, tbody);
    scroller.replaceChildren(table);
    if (data.length > MAX_ROWS) {
      const note = document.createElement("p");
      note.className = "preview-note";
      note.textContent = t("preview.rowsLimited", { max: MAX_ROWS, total: data.length });
      scroller.append(note);
    }
    tabs.querySelectorAll("button").forEach((b, i) => b.classList.toggle("active", i === index));
  };
  sheets.forEach((sheet, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = sheet.sheet;
    button.addEventListener("click", () => show(index));
    tabs.append(button);
  });
  wrap.append(tabs, scroller);
  body.replaceChildren(wrap);
  show(0);
  return none;
}
function columnName(index: number): string {
  let name = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) name = String.fromCharCode(65 + (n % 26)) + name;
  return name;
}

// .drawio: the official viewer runs inside an iframe (public/drawio) so its globals stay out of the app.
// Later refreshes go through `update`, which keeps the iframe (and the page being viewed) alive.
export async function renderDiagram(body: HTMLElement, xml: string): Promise<Rendered> {
  const frame = document.createElement("iframe");
  frame.className = "preview-diagram";
  frame.src = "/drawio/frame.html";
  let ready: () => void = () => {};
  const loaded = new Promise<void>((resolve) => (ready = resolve));
  let pending: { resolve(): void; reject(error: Error): void } | undefined;
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || !event.data) return;
    if (event.data.type === "ready") ready();
    else if (event.data.type === "rendered") pending?.resolve();
    else if (event.data.type === "error") pending?.reject(new Error(String(event.data.message)));
  };
  window.addEventListener("message", onMessage);
  body.replaceChildren(frame);
  const send = async (text: string) => {
    await loaded;
    await new Promise<void>((resolve, reject) => {
      pending = { resolve, reject };
      frame.contentWindow?.postMessage({ type: "render", xml: text }, "*");
    });
  };
  const rendered: Rendered = { dispose: () => window.removeEventListener("message", onMessage), update: send };
  try {
    await send(xml);
  } catch (error) {
    rendered.dispose();
    throw error;
  }
  return rendered;
}

// .html: served by the Rust `hgpage` protocol into an iframe whose sandbox has allow-scripts but not
// allow-same-origin, so the page's scripts run with an opaque origin and cannot reach the app or its IPC.
// Relative css/js/images load from the file's folder. Refreshes reload the frame (`update`).
export const pageUrl = (path: string, version: number): string => {
  const base = navigator.userAgent.includes("Windows") ? "http://hgpage.localhost" : "hgpage://localhost";
  return `${base}${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}?v=${version}`;
};
export async function renderPage(body: HTMLElement, path: string): Promise<Rendered> {
  const frame = document.createElement("iframe");
  frame.className = "preview-page";
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
  let version = 0;
  const load = () => new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    frame.src = pageUrl(path, ++version);
  });
  body.replaceChildren(frame);
  await load();
  return { dispose() {}, update: () => load() };
}

// Video: a <video> streaming from the same hgpage protocol (it answers Range requests, so seeking works).
export async function renderVideo(body: HTMLElement, path: string, failed: (message: string) => string): Promise<Rendered> {
  const video = document.createElement("video");
  video.className = "preview-video";
  video.controls = true;
  video.preload = "metadata";
  video.src = pageUrl(path, Date.now());
  video.addEventListener("error", () => {
    const note = document.createElement("p");
    note.className = "preview-note";
    note.textContent = failed(path);
    body.replaceChildren(note);
  }, { once: true });
  body.replaceChildren(video);
  return { dispose() { video.pause(); video.removeAttribute("src"); video.load(); } };
}

let mermaidReady: Promise<typeof import("mermaid").default> | undefined;
// mermaid.initialize is global, so renders run one at a time to keep each one's theme.
let mermaidQueue: Promise<unknown> = Promise.resolve();
let mermaidSeq = 0;

// Turns ```mermaid blocks (and already drawn diagrams, for a theme change) under `root` into sanitized SVG.
// A diagram that fails keeps its source block and gets a note; the rest of the document is unaffected.
export async function renderMermaid(root: HTMLElement, light: boolean): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code")].filter((code) => isMermaidLang(code.className));
  const drawn = [...root.querySelectorAll<HTMLElement>(".mermaid-diagram[data-source]")];
  if (!blocks.length && !drawn.length) return;
  mermaidReady ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidReady;
  const draw = async (source: string): Promise<string> => {
    const run = mermaidQueue.then(async () => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: mermaidTheme(light), htmlLabels: false, flowchart: { htmlLabels: false } }); // SVG text labels survive DOMPurify; foreignObject does not
      const id = `mermaid-${++mermaidSeq}`;
      try {
        return (await mermaid.render(id, source)).svg;
      } finally {
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove(); // mermaid leaves its error node here
      }
    });
    mermaidQueue = run.catch(() => undefined);
    return DOMPurify.sanitize(await run, { USE_PROFILES: { svg: true, svgFilters: true, html: true } });
  };
  const place = (target: Element, source: string, svg: string) => {
    const div = document.createElement("div");
    div.className = "mermaid-diagram";
    div.dataset.source = source;
    div.innerHTML = svg;
    target.replaceWith(div);
  };
  for (const code of blocks) {
    const source = code.textContent ?? "";
    const pre = code.parentElement!;
    try {
      place(pre, source, await draw(source));
    } catch (error) {
      console.error("mermaid", error);
      const note = document.createElement("p");
      note.className = "preview-note";
      note.textContent = t("preview.mermaidError");
      pre.after(note);
    }
  }
  for (const div of drawn) {
    try { div.innerHTML = await draw(div.dataset.source ?? ""); } catch { /* keep the previous drawing */ }
  }
}
