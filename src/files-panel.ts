// Per-tab files panel shown beside (or instead of) the terminal. Pure state
// lives in files.ts; this module owns the DOM and talks to the native layer.
import { invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import {
  clampPreviewHeight,
  clampWidth,
  DEFAULT_PREVIEW_HEIGHT,
  DEFAULT_WIDTH,
  fileKindLabel,
  formatDate,
  formatSize,
  initialFiles,
  moveSelection,
  navigate,
  onCwd,
  parentOf,
  previewTarget,
  pruneSelection,
  returnToCwd,
  select,
  shellQuote,
  sortEntries,
  stemLength,
  toggleExpanded,
  toggleFull,
  toggleOpen,
  topLevelPaths,
  type FileEntry,
  type FilesState,
  type FilesView,
  type Selection,
  type Sort,
  type SortKey,
} from "./files";

export type FilesTab = { files?: FilesState };
export type FilesHost = {
  native: <T = Record<string, unknown>>(request: Record<string, unknown>) => Promise<T>;
  activeTab(): FilesTab | undefined;
  // cwd of the active tab's focused terminal.
  cwd(): string | undefined;
  home(): string;
  displayPath(path: string): string;
  openTerminal(path: string): Promise<void>;
  editInTerminal(directory: string, command: string): Promise<void>;
  insertIntoTerminal(text: string): Promise<void>;
  focusTerminal(): void;
  layoutChanged(): void;
  notify(error: unknown): void;
  icons: Record<"folder" | "file" | "chevron" | "up" | "eye" | "close", string>;
};
type OpResult = { paths: string[]; errors: string[] };
type App = { name: string; path: string; isDefault: boolean };
type MenuEntry = { text: string; action?: () => unknown; enabled?: boolean; items?: MenuEntry[] } | { item: "Separator" };

const extraIcons = {
  follow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
  shrink: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  columns: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
};

export function initFilesPanel(host: FilesHost) {
  const { icons } = host;
  const workspace = document.getElementById("workspace")!;
  const panel = document.getElementById("files")!;
  const resizer = document.getElementById("files-resizer")!;
  panel.innerHTML = `<div class="files-heading">
<button id="files-up" class="icon-btn" title="上層（⌘↑）" aria-label="上層">${icons.up}</button>
<nav id="files-crumbs" class="files-crumbs" aria-label="目前位置"></nav>
<button id="files-follow" class="icon-btn" title="回到終端機目前目錄" aria-label="回到終端機目前目錄" hidden>${extraIcons.follow}</button>
<div class="files-view-switch" role="group" aria-label="檢視模式"><button id="files-view-list" class="icon-btn" title="清單" aria-label="清單">${extraIcons.list}</button><button id="files-view-columns" class="icon-btn" title="三欄" aria-label="三欄">${extraIcons.columns}</button></div>
<button id="files-hidden" class="icon-btn" title="顯示隱藏檔" aria-label="顯示隱藏檔" aria-pressed="false">${icons.eye}</button>
<button id="files-full" class="icon-btn" title="滿版（⇧⌘F）" aria-label="滿版">${extraIcons.expand}</button>
<button id="files-close" class="icon-btn" title="關閉（⌘O／⌘0）" aria-label="關閉檔案面板">${icons.close}</button>
</div>
<div class="files-columns"><button data-sort="name">名稱</button><button data-sort="size">大小</button><button data-sort="modified">修改日期</button></div>
<div id="files-split"><div id="files-body"><div class="col-parent" aria-label="上層"></div><div id="files-list" role="tree" tabindex="0" aria-label="檔案" aria-multiselectable="true"></div><div class="col-child" aria-label="資料夾內容"></div></div><div id="files-preview-resizer" role="separator" aria-orientation="horizontal" aria-label="調整預覽高度"></div><div class="col-preview" aria-label="預覽"></div></div>
<div id="files-status" role="status" hidden></div>`;
  const $ = (id: string) => document.getElementById(id)!;
  const list = $("files-list");
  const parentColumn = panel.querySelector<HTMLElement>(".col-parent")!;
  const childColumn = panel.querySelector<HTMLElement>(".col-child")!;
  const previewColumn = panel.querySelector<HTMLElement>(".col-preview")!;
  const previewResizer = $("files-preview-resizer");

  let cache = new Map<string, FileEntry[]>();
  let entries = new Map<string, FileEntry>();
  let order: string[] = [];
  let selection: Selection = { paths: [] };
  let generation = 0;
  let renderedPath: string | undefined;
  let renaming: string | undefined;
  let shownTab: FilesTab | undefined;
  let quickLook = false;
  let cutPaths = new Set<string>();
  let stampKey = "";
  let showHidden = false;
  let sort: Sort = { key: "name", descending: false };
  let width = DEFAULT_WIDTH;
  let previewHeight = DEFAULT_PREVIEW_HEIGHT;
  let view: FilesView = "list";
  // Selected after the next load: a path, or "first" for the first row.
  let pendingSelect: string | undefined;
  let previewToken = 0;
  let childPick: FileEntry | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const previewCache = new Map<string, FileEntry[]>();
  const thumbnails = new Map<string, { image: string; kind: string }>();
  try {
    view = localStorage.getItem("files-view") === "columns" ? "columns" : "list";
    showHidden = localStorage.getItem("show-hidden") === "true";
    sort = { ...sort, ...JSON.parse(localStorage.getItem("files-sort") || "{}") };
    width = Number(localStorage.getItem("files-width")) || DEFAULT_WIDTH;
    previewHeight = Number(localStorage.getItem("files-preview-height")) || DEFAULT_PREVIEW_HEIGHT;
  } catch {}

  const state = () => host.activeTab()?.files;
  const update = (next: FilesState) => {
    const tab = host.activeTab();
    if (tab) tab.files = next;
  };
  const isOpen = () => !!state()?.open;
  const hasFocus = () => document.hasFocus() && panel.contains(document.activeElement);

  function status(text: string, error = true) {
    const line = $("files-status");
    line.textContent = text;
    line.hidden = !text;
    line.classList.toggle("error", error);
  }
  function report(result: OpResult | undefined, error?: unknown) {
    if (error) status(String(error));
    else if (result?.errors.length) status(result.errors.join("；"));
    else status("");
  }

  function applyLayout(notifyHost = true) {
    const files = state();
    const open = !!files?.open, full = open && !!files?.full;
    workspace.classList.toggle("files-open", open);
    workspace.classList.toggle("files-full", full);
    panel.hidden = !open;
    resizer.hidden = !open || full;
    width = clampWidth(width, window.innerWidth);
    workspace.style.setProperty("--files-width", width + "px");
    previewHeight = clampPreviewHeight(previewHeight, panel.clientHeight || window.innerHeight);
    panel.style.setProperty("--preview-height", previewHeight + "px");
    $("files-full").innerHTML = full ? extraIcons.shrink : extraIcons.expand;
    $("files-full").title = full ? "結束滿版（⇧⌘F）" : "滿版（⇧⌘F）";
    panel.classList.toggle("view-columns", view === "columns");
    $("files-view-list").classList.toggle("active", view === "list");
    $("files-view-columns").classList.toggle("active", view === "columns");
    $("files-view-list").setAttribute("aria-pressed", String(view === "list"));
    $("files-view-columns").setAttribute("aria-pressed", String(view === "columns"));
    $("files-hidden").classList.toggle("active", showHidden);
    $("files-hidden").setAttribute("aria-pressed", String(showHidden));
    const toggleButton = document.getElementById("files-toggle");
    if (toggleButton) {
      toggleButton.classList.toggle("active", open);
      toggleButton.setAttribute("aria-pressed", String(open));
      (toggleButton as HTMLButtonElement).disabled = !host.activeTab();
    }
    if (notifyHost) host.layoutChanged();
  }

  // Re-read the root folder and every expanded folder, then redraw.
  async function load() {
    const files = state();
    if (!files?.open) return;
    if (!files.path) {
      const cwd = host.cwd() || host.home();
      update(returnToCwd(files, cwd));
    }
    const root = state()!.path!;
    const token = ++generation;
    const next = new Map<string, FileEntry[]>();
    try {
      const parentListing = view === "columns" && root !== "/"
        ? invoke<FileEntry[]>("list_files", { path: parentOf(root), showHidden }).catch(() => [] as FileEntry[])
        : undefined;
      next.set(root, await invoke<FileEntry[]>("list_files", { path: root, showHidden }));
      if (parentListing) next.set(parentOf(root), await parentListing);
      // Columns mode never expands folders in place.
      const expanded = new Set(view === "columns" ? [] : state()!.expanded);
      // Breadth-first so only folders that are still visible get listed.
      let level = [root];
      while (level.length) {
        const children = level.flatMap((dir) => (next.get(dir) || []).filter((entry) => entry.is_dir && expanded.has(entry.path)).map((entry) => entry.path));
        const listed = await Promise.all(children.map((dir) => invoke<FileEntry[]>("list_files", { path: dir, showHidden }).catch(() => [] as FileEntry[])));
        children.forEach((dir, index) => next.set(dir, listed[index]));
        level = children;
      }
      if (token !== generation) return;
      if (renderedPath !== root) { selection = { paths: [] }; list.scrollTop = 0; }
      renderedPath = root;
      cache = next;
      stampKey = "";
      previewCache.clear();
      draw();
      if (pendingSelect && !renaming) {
        const target = pendingSelect === "first" ? order[0] : pendingSelect;
        if (target && entries.has(target)) setSelection({ paths: [target], anchor: target });
      }
      pendingSelect = undefined;
    } catch (error) {
      if (token !== generation) return;
      cache = new Map();
      renderedPath = root;
      draw();
      status(String(error));
    }
  }

  function draw() {
    const files = state();
    if (!files?.open || !files.path || renaming) return;
    renderCrumbs(files.path);
    $("files-follow").hidden = files.follow;
    for (const button of panel.querySelectorAll<HTMLElement>(".files-columns button")) {
      const key = button.dataset.sort as SortKey;
      button.classList.toggle("sorted", sort.key === key);
      button.dataset.direction = sort.key === key ? (sort.descending ? "desc" : "asc") : "";
    }
    entries = new Map();
    order = [];
    const fragment = document.createDocumentFragment();
    const expanded = new Set(files.expanded);
    const walk = (dir: string, depth: number) => {
      for (const entry of sortEntries(cache.get(dir) || [], sort)) {
        entries.set(entry.path, entry);
        order.push(entry.path);
        fragment.append(row(entry, depth, expanded.has(entry.path)));
        if (entry.is_dir && expanded.has(entry.path) && cache.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(files.path, 0);
    selection = pruneSelection(selection, order);
    list.replaceChildren(fragment);
    drawParent(files.path);
    if (!order.length) {
      const empty = document.createElement("p");
      empty.className = "files-empty";
      empty.textContent = cache.has(files.path) ? "此資料夾是空的" : "";
      list.append(empty);
    }
    syncSelection();
  }
  function row(entry: FileEntry, depth: number, expanded: boolean) {
    const element = document.createElement("div");
    element.className = "file-row" + (entry.is_dir ? " is-dir" : "") + (cutPaths.has(entry.path) ? " cut" : "");
    element.setAttribute("role", "treeitem");
    element.dataset.path = entry.path;
    element.style.setProperty("--depth", String(depth));
    element.title = host.displayPath(entry.path);
    if (entry.is_dir) element.setAttribute("aria-expanded", String(expanded));
    const nameCell = document.createElement("span");
    nameCell.className = "file-name-cell";
    const disclosure = document.createElement("span");
    disclosure.className = "file-disclosure" + (expanded ? " expanded" : "");
    if (entry.is_dir && entry.has_children) disclosure.innerHTML = icons.chevron;
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.innerHTML = entry.is_dir ? icons.folder : icons.file;
    const label = document.createElement("span");
    label.className = "file-name";
    label.textContent = entry.name;
    nameCell.append(disclosure, icon, label);
    if (entry.is_symlink) {
      const link = document.createElement("span");
      link.className = "file-link";
      link.title = "替身／符號連結";
      link.innerHTML = extraIcons.link;
      nameCell.append(link);
    }
    if (entry.is_dir) {
      const chevron = document.createElement("span");
      chevron.className = "file-chevron";
      chevron.innerHTML = icons.chevron;
      nameCell.append(chevron);
    }
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatSize(entry.size, entry.is_dir);
    const date = document.createElement("span");
    date.className = "file-date";
    date.textContent = formatDate(entry.modified_ms);
    element.append(nameCell, size, date);
    return element;
  }
  // Read-only rows for the parent and preview columns.
  function miniRow(entry: FileEntry, selected: boolean, onClick: () => void) {
    const element = document.createElement("div");
    element.className = "file-row mini" + (entry.is_dir ? " is-dir" : "") + (selected ? " current" : "");
    element.title = host.displayPath(entry.path);
    element.innerHTML = `<span class="file-name-cell"><span class="file-icon">${entry.is_dir ? icons.folder : icons.file}</span><span class="file-name"></span>${entry.is_dir ? `<span class="file-chevron">${icons.chevron}</span>` : ""}</span>`;
    element.querySelector(".file-name")!.textContent = entry.name;
    // Keep the keyboard on the current column after clicking a side column.
    element.onclick = () => { onClick(); list.focus(); };
    return element;
  }
  function drawParent(path: string) {
    if (view !== "columns") { parentColumn.replaceChildren(); return; }
    const up = parentOf(path);
    const fragment = document.createDocumentFragment();
    if (path !== "/")
      for (const entry of sortEntries(cache.get(up) || [], sort))
        fragment.append(miniRow(entry, entry.path === path, () => (entry.is_dir ? go(entry.path) : go(up, entry.path))));
    parentColumn.replaceChildren(fragment);
    parentColumn.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }
  function schedulePreview() {
    if (view !== "columns") return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => drawPreview().catch(host.notify), 120);
  }
  async function drawPreview() {
    const token = ++previewToken;
    const target = previewTarget(selection, entries);
    // The child column lists a selected folder; the bottom pane describes the selection.
    const child = document.createElement("div");
    const box = document.createElement("div");
    const addFacts = (name: string, rows: [string, string][]) => {
      const title = document.createElement("strong");
      title.textContent = name;
      const facts = document.createElement("dl");
      for (const [term, value] of rows) {
        const dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = term;
        dd.textContent = value;
        facts.append(dt, dd);
      }
      const info = document.createElement("div");
      info.className = "preview-info";
      info.append(title, facts);
      box.append(info);
    };
    // Fills the bottom pane with a file preview; false when a newer draw superseded this one.
    const showFile = async (entry: FileEntry) => {
      const key = `${entry.path}|${entry.modified_ms}`;
      let info = thumbnails.get(key);
      if (!info) {
        try { info = await invoke<{ image: string; kind: string }>("file_op", { request: { op: "preview", path: entry.path } }); }
        catch { info = { image: "", kind: "" }; }
        if (token !== previewToken) return false;
        thumbnails.set(key, info);
        // Keep the cache small; Map iterates oldest first.
        if (thumbnails.size > 64) thumbnails.delete(thumbnails.keys().next().value!);
      }
      box.className = "preview-file";
      if (info.image) {
        const image = document.createElement("img");
        image.src = info.image;
        image.alt = "";
        box.append(image);
      }
      const rows: [string, string][] = [
        ["種類", info.kind || fileKindLabel(entry.name, false)],
        ["大小", formatSize(entry.size, false)],
        ["修改日期", formatDate(entry.modified_ms)],
      ];
      if (entry.is_symlink) rows.push(["", "替身／符號連結"]);
      addFacts(entry.name, rows);
      return true;
    };
    if (target.kind === "many") {
      box.className = "preview-note";
      box.textContent = `已選取 ${target.count} 個項目`;
    } else if (target.kind === "dir") {
      const dir = target.entry.path;
      let listing = previewCache.get(dir);
      if (!listing) {
        try { listing = await invoke<FileEntry[]>("list_files", { path: dir, showHidden }); }
        catch (error) { listing = []; child.className = "preview-note"; child.textContent = String(error); }
        if (token !== previewToken) return;
        previewCache.set(dir, listing);
      }
      // A file picked in the child column stays there and is previewed below; folders still open.
      const picked = childPick && parentOf(childPick.path) === dir ? listing.find((entry) => entry.path === childPick!.path) : undefined;
      childPick = picked;
      for (const entry of sortEntries(listing, sort))
        child.append(miniRow(entry, entry.path === picked?.path, () => {
          if (entry.is_dir) { go(dir, entry.path); return; }
          childPick = entry;
          if (quickLook) previewSelection(true).catch(host.notify);
          drawPreview().catch(host.notify);
        }));
      if (!listing.length && !child.textContent) { child.className = "preview-note"; child.textContent = "此資料夾是空的"; }
      if (picked) { if (!(await showFile(picked))) return; }
      else {
        box.className = "preview-file";
        addFacts(target.entry.name, [
          ["種類", "資料夾"],
          ["項目", `${listing.length} 個`],
          ["修改日期", formatDate(target.entry.modified_ms)],
        ]);
      }
    } else if (target.kind === "file") {
      if (!(await showFile(target.entry))) return;
    }
    if (token === previewToken) {
      childColumn.replaceChildren(child);
      previewColumn.replaceChildren(box);
      childColumn.querySelector(".current")?.scrollIntoView({ block: "nearest" });
    }
  }
  function setView(next: FilesView) {
    if (view === next) return;
    view = next;
    try { localStorage.setItem("files-view", view); } catch {}
    childColumn.replaceChildren();
    previewColumn.replaceChildren();
    applyLayout();
    load().catch(host.notify);
    list.focus();
  }
  function renderCrumbs(path: string) {
    const nav = $("files-crumbs");
    nav.replaceChildren();
    const home = host.home();
    const inHome = !!home && (path === home || path.startsWith(home + "/"));
    const base = inHome ? home : "";
    const crumbs: [string, string][] = [[inHome ? "~" : "/", base || "/"]];
    let current = base;
    for (const part of path.slice(base.length).split("/").filter(Boolean)) {
      current += "/" + part;
      crumbs.push([part, current]);
    }
    crumbs.forEach(([label, target], index) => {
      if (index) nav.append(Object.assign(document.createElement("span"), { className: "crumb-sep", textContent: "›" }));
      const crumb = document.createElement("button");
      crumb.className = "crumb";
      crumb.textContent = label;
      crumb.title = target;
      crumb.onclick = () => go(target);
      nav.append(crumb);
    });
    nav.scrollLeft = nav.scrollWidth;
  }
  function syncSelection() {
    const chosen = new Set(selection.paths);
    for (const element of list.querySelectorAll<HTMLElement>(".file-row")) {
      const on = chosen.has(element.dataset.path!);
      element.classList.toggle("selected", on);
      element.setAttribute("aria-selected", String(on));
    }
    if (quickLook) previewSelection(true).catch(host.notify);
    schedulePreview();
  }
  function setSelection(next: Selection, reveal = true) {
    selection = next;
    syncSelection();
    if (reveal && selection.paths.length) rowFor(selection.paths.at(-1)!)?.scrollIntoView({ block: "nearest" });
  }
  const rowFor = (path: string) => list.querySelector<HTMLElement>(`.file-row[data-path="${CSS.escape(path)}"]`);
  const selectedEntries = () => selection.paths.map((path) => entries.get(path)).filter((entry): entry is FileEntry => !!entry);

  // selectAfter: path to select once listed, or "first" for the first row.
  function go(path: string, selectAfter?: string) {
    const files = state();
    if (!files) return;
    pendingSelect = selectAfter;
    update(navigate(files, path, host.cwd()));
    status("");
    load().catch(host.notify);
  }
  // Going up selects the folder we came from.
  function goUp() {
    const path = state()?.path;
    if (path && path !== "/") go(parentOf(path), path);
  }
  async function setExpanded(path: string, expanded?: boolean) {
    const files = state();
    if (!files) return;
    update(toggleExpanded(files, path, expanded));
    await load();
  }

  // ---- Commands -------------------------------------------------------------
  function targetDirectory(entry?: FileEntry) {
    return entry ? (entry.is_dir ? entry.path : parentOf(entry.path)) : state()?.path || host.home();
  }
  async function run(request: Record<string, unknown>) {
    return invoke<OpResult>("file_op", { request });
  }
  async function afterChange(result: OpResult | undefined, error?: unknown) {
    report(result, error);
    await load();
    if (result?.paths.length) setSelection({ paths: result.paths.filter((path) => entries.has(path)), anchor: result.paths[0] });
  }
  async function copy(cut: boolean) {
    const paths = topLevelPaths(selection.paths);
    if (!paths.length) return;
    await host.native({ op: "files-pasteboard-write", paths, cut });
    cutPaths = new Set(cut ? paths : []);
    for (const element of list.querySelectorAll<HTMLElement>(".file-row")) element.classList.toggle("cut", cutPaths.has(element.dataset.path!));
    status(cut ? `已剪下 ${paths.length} 個項目，貼上時會搬移` : "", false);
  }
  async function paste(destination = targetDirectory()) {
    const board = await host.native<{ paths: string[]; cut: boolean }>({ op: "files-pasteboard-read" });
    if (!board.cut) cutPaths = new Set();
    if (!board.paths.length) { status("剪貼簿沒有檔案"); return; }
    let result: OpResult | undefined, error: unknown;
    try {
      result = await run({ op: board.cut ? "move" : "copy", sources: board.paths, destination });
      if (board.cut) {
        // The cut is used up; leave the moved files on the clipboard as a plain copy.
        cutPaths = new Set();
        if (result.paths.length) await host.native({ op: "files-pasteboard-write", paths: result.paths, cut: false });
      }
    } catch (e) { error = e; }
    await afterChange(result, error);
  }
  async function duplicate() {
    const paths = topLevelPaths(selection.paths);
    const merged: OpResult = { paths: [], errors: [] };
    let error: unknown;
    try {
      for (const dir of new Set(paths.map(parentOf))) {
        const result = await run({ op: "copy", sources: paths.filter((path) => parentOf(path) === dir), destination: dir });
        merged.paths.push(...result.paths);
        merged.errors.push(...result.errors);
      }
    } catch (e) { error = e; }
    await afterChange(merged, error);
  }
  async function trash() {
    const paths = topLevelPaths(selection.paths);
    if (!paths.length) return;
    // Select the row after the last trashed one, like Finder.
    const after = order.slice(order.indexOf(selection.paths.at(-1)!) + 1).find((path) => !paths.some((gone) => path === gone || path.startsWith(gone + "/")));
    let result: OpResult | undefined, error: unknown;
    try { result = await run({ op: "trash", paths }); } catch (e) { error = e; }
    report(result, error);
    await load();
    setSelection(after && entries.has(after) ? { paths: [after], anchor: after } : { paths: [] });
  }
  async function create(kind: "folder" | "file", entry?: FileEntry) {
    // Columns mode only shows the current folder, so new items go there.
    const directory = view === "columns" ? targetDirectory() : targetDirectory(entry);
    let result: OpResult | undefined;
    try {
      result = await run({ op: kind === "folder" ? "create-folder" : "create-file", directory, name: kind === "folder" ? "未命名檔案夾" : "未命名.txt" });
    } catch (error) { report(undefined, error); return; }
    const files = state();
    if (files && directory !== files.path) update(toggleExpanded(files, directory, true));
    await afterChange(result);
    if (result.paths[0]) rename(result.paths[0]);
  }
  function rename(path = selection.paths.at(-1)) {
    const entry = path ? entries.get(path) : undefined;
    const element = path ? rowFor(path) : undefined;
    if (!entry || !element) return;
    setSelection({ paths: [entry.path], anchor: entry.path });
    renaming = entry.path;
    const label = element.querySelector<HTMLElement>(".file-name")!;
    const input = document.createElement("input");
    input.className = "file-rename";
    input.value = entry.name;
    input.spellcheck = false;
    label.replaceWith(input);
    element.classList.add("renaming");
    input.focus();
    input.setSelectionRange(0, stemLength(entry.name, entry.is_dir));
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      renaming = undefined;
      const name = input.value.trim();
      if (!save || !name || name === entry.name) { draw(); list.focus(); return; }
      let result: OpResult | undefined, error: unknown;
      try { result = await run({ op: "rename", path: entry.path, name }); } catch (e) { error = e; }
      await afterChange(result, error);
      list.focus();
    };
    input.onkeydown = (event) => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); finish(true).catch(host.notify); }
      if (event.key === "Escape") { event.preventDefault(); finish(false).catch(host.notify); }
    };
    input.onblur = () => { finish(true).catch(host.notify); };
    input.onmousedown = input.ondblclick = (event) => event.stopPropagation();
  }
  async function open(targets = selectedEntries()) {
    if (targets.length === 1 && targets[0].is_dir) { go(targets[0].path, "first"); return; }
    if (targets.length) await host.native({ op: "files-open", paths: targets.map((entry) => entry.path) });
  }
  async function openWith(app: string) {
    await host.native({ op: "files-open", paths: selection.paths, app });
  }
  async function editInTerminal(entry: FileEntry) {
    const files = state();
    if (files?.full) { update(toggleFull(files)); applyLayout(); }
    // Run through sh so ${EDITOR} works the same under zsh, bash and fish.
    await host.editInTerminal(parentOf(entry.path), `sh -c '\${EDITOR:-vi} "$1"' sh ${shellQuote(entry.path)}`);
  }
  async function previewSelection(updateOnly = false) {
    // A file picked in the child column is what the user is looking at, so preview that.
    const picked = childPick && selection.paths.length === 1 && selection.paths[0] === parentOf(childPick.path) ? childPick.path : undefined;
    const paths = picked ? [picked] : selection.paths;
    if (!paths.length) { if (quickLook) await host.native({ op: "files-quicklook-close" }); return; }
    await host.native({ op: updateOnly ? "files-quicklook-update" : "files-quicklook", paths, index: 0 });
    if (!updateOnly) quickLook = true;
  }
  async function toggleQuickLook() {
    if (quickLook) { quickLook = false; await host.native({ op: "files-quicklook-close" }); }
    else await previewSelection();
  }

  // ---- Context menu (native NSMenu, so it never hides behind a terminal) ----
  async function popup(items: MenuEntry[]) {
    const menu = await Menu.new({ items });
    await menu.popup();
    // Item actions are delivered asynchronously; release the menu afterwards.
    setTimeout(() => menu.close().catch(() => {}), 5000);
  }
  const act = (fn: () => unknown) => () => { Promise.resolve().then(fn).catch((error) => status(String(error))); };
  async function itemMenu(entry: FileEntry) {
    const many = selection.paths.length > 1;
    const sep = { item: "Separator" as const };
    let apps: App[] = [];
    if (!entry.is_dir && !many) {
      try { apps = (await host.native<{ apps: App[] }>({ op: "files-open-with-apps", path: entry.path })).apps; } catch {}
    }
    const openWithItems: MenuEntry[] = apps.map((app) => ({ text: app.isDefault ? `${app.name}（預設）` : app.name, action: act(() => openWith(app.path)) }));
    if (apps.length > 1 && apps[0].isDefault) openWithItems.splice(1, 0, sep);
    const items: MenuEntry[] = [
      { text: entry.is_dir && !many ? "打開" : "用預設 App 打開", action: act(() => open()) },
      ...(openWithItems.length ? [{ text: "打開方式", items: openWithItems }] : []),
      ...(!entry.is_dir && !many ? [{ text: "在終端機中編輯", action: act(() => editInTerminal(entry)) }] : []),
      { text: "Quick Look", action: act(() => previewSelection()) },
      sep,
      ...(entry.is_dir && !many ? [{ text: "在新頁籤開啟終端機", action: act(() => host.openTerminal(entry.path)) }] : []),
      { text: "插入路徑到終端機", action: act(() => host.insertIntoTerminal(selection.paths.map(shellQuote).join(" ") + " ")) },
      { text: "拷貝路徑", action: act(() => host.native({ op: "files-pasteboard-text", text: selection.paths.join("\n") })) },
      sep,
      { text: "剪下", action: act(() => copy(true)) },
      { text: "拷貝", action: act(() => copy(false)) },
      { text: entry.is_dir && !many ? "貼到此資料夾" : "貼上", action: act(() => paste(targetDirectory(many ? undefined : entry))) },
      { text: "複製一份", action: act(duplicate) },
      { text: "重新命名", enabled: !many, action: act(() => rename(entry.path)) },
      sep,
      { text: "新增資料夾", action: act(() => create("folder", many ? undefined : entry)) },
      { text: "新增檔案", action: act(() => create("file", many ? undefined : entry)) },
      { text: "在 Finder 中顯示", action: act(() => host.native({ op: "files-reveal", paths: selection.paths })) },
      sep,
      { text: "丟到垃圾桶", action: act(trash) },
    ];
    await popup(items);
  }
  async function backgroundMenu() {
    const dir = targetDirectory();
    await popup([
      { text: "新增資料夾", action: act(() => create("folder")) },
      { text: "新增檔案", action: act(() => create("file")) },
      { text: "貼上", action: act(() => paste(dir)) },
      { item: "Separator" },
      { text: "在新頁籤開啟終端機", action: act(() => host.openTerminal(dir)) },
      { text: "在 Finder 中打開", action: act(() => host.native({ op: "files-open", paths: [dir] })) },
      { text: "重新整理", action: act(load) },
    ]);
  }

  // ---- Events ---------------------------------------------------------------
  list.addEventListener("mousedown", (event) => {
    const element = (event.target as Element).closest<HTMLElement>(".file-row");
    if (event.button !== 0) return;
    if (!element) { setSelection({ paths: [] }); return; }
    const path = element.dataset.path!;
    if ((event.target as Element).closest(".file-disclosure") && entries.get(path)?.has_children) {
      event.preventDefault();
      list.focus();
      setExpanded(path).catch(host.notify);
      return;
    }
    // The second click of a double-click keeps the selection it is about to open.
    if (event.detail > 1) return;
    setSelection(select(selection, path, order, { toggle: event.metaKey, range: event.shiftKey }), false);
  });
  list.addEventListener("dblclick", (event) => {
    const element = (event.target as Element).closest<HTMLElement>(".file-row");
    const entry = element ? entries.get(element.dataset.path!) : undefined;
    if (entry && !(event.target as Element).closest(".file-disclosure")) open([entry]).catch((error) => status(String(error)));
  });
  list.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const element = (event.target as Element).closest<HTMLElement>(".file-row");
    const entry = element ? entries.get(element.dataset.path!) : undefined;
    if (entry && !selection.paths.includes(entry.path)) setSelection({ paths: [entry.path], anchor: entry.path }, false);
    (entry ? itemMenu(entry) : backgroundMenu()).catch((error) => status(String(error)));
  });
  list.addEventListener("keydown", (event) => {
    if (event.isComposing || event.target !== list) return;
    const key = event.key, meta = event.metaKey, single = selectedEntries().length === 1 ? selectedEntries()[0] : undefined;
    const handled = () => event.preventDefault();
    const commands: Record<string, () => unknown> = {
      ArrowDown: () => (meta ? open() : setSelection(moveSelection(selection, order, 1, event.shiftKey))),
      ArrowUp: () => (meta ? goUp() : setSelection(moveSelection(selection, order, -1, event.shiftKey))),
      // Columns: → enters the selected folder and ← returns to the parent.
      ArrowRight: () => single?.is_dir && (view === "columns" ? go(single.path, "first") : setExpanded(single.path, true)),
      ArrowLeft: () => {
        if (view === "columns") return goUp();
        if (!single) return;
        if (state()!.expanded.includes(single.path)) return setExpanded(single.path, false);
        const up = parentOf(single.path);
        if (entries.has(up)) setSelection({ paths: [up], anchor: up });
      },
      " ": toggleQuickLook,
      Enter: () => rename(),
      Escape: () => (selection.paths.length ? setSelection({ paths: [] }) : host.focusTerminal()),
    };
    const metaCommands: Record<string, () => unknown> = {
      c: () => copy(false),
      x: () => copy(true),
      v: () => paste(),
      d: duplicate,
      a: () => setSelection({ paths: [...order], anchor: order[0] }, false),
      Backspace: trash,
    };
    let fn: (() => unknown) | undefined;
    if (meta && event.shiftKey && key.toLowerCase() === "n") fn = () => create("folder");
    else if (meta && event.shiftKey && key.toLowerCase() === "f") fn = toggleFullMode;
    else if (meta && !event.shiftKey && !event.altKey && !event.ctrlKey && (key.length === 1 ? key.toLowerCase() : key) in metaCommands) fn = metaCommands[key.length === 1 ? key.toLowerCase() : key];
    else if (key in commands && !event.altKey && !event.ctrlKey && (!meta || key.startsWith("Arrow"))) fn = commands[key];
    if (!fn) return;
    handled();
    event.stopPropagation();
    Promise.resolve().then(fn).catch((error) => status(String(error)));
  });
  for (const button of panel.querySelectorAll<HTMLElement>(".files-columns button"))
    button.onclick = () => {
      const key = button.dataset.sort as SortKey;
      sort = { key, descending: sort.key === key ? !sort.descending : key !== "name" };
      try { localStorage.setItem("files-sort", JSON.stringify(sort)); } catch {}
      draw();
    };
  for (const column of [parentColumn, childColumn, previewColumn]) column.addEventListener("contextmenu", (event) => event.preventDefault());
  $("files-up").onclick = goUp;
  $("files-view-list").onclick = () => setView("list");
  $("files-view-columns").onclick = () => setView("columns");
  $("files-follow").onclick = () => {
    const files = state(), cwd = host.cwd();
    if (files && cwd) { update(returnToCwd(files, cwd)); load().catch(host.notify); }
  };
  $("files-hidden").onclick = () => {
    showHidden = !showHidden;
    try { localStorage.setItem("show-hidden", String(showHidden)); } catch {}
    applyLayout();
    load().catch(host.notify);
  };
  $("files-full").onclick = () => toggleFullMode();
  $("files-close").onclick = () => close();
  resizer.addEventListener("pointerdown", (event) => {
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");
    const right = workspace.getBoundingClientRect().right;
    const move = (e: PointerEvent) => {
      width = clampWidth(right - e.clientX, window.innerWidth);
      workspace.style.setProperty("--files-width", width + "px");
      host.layoutChanged();
    };
    const up = () => {
      resizer.classList.remove("dragging");
      resizer.removeEventListener("pointermove", move);
      try { localStorage.setItem("files-width", String(width)); } catch {}
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up, { once: true });
    resizer.addEventListener("pointercancel", up, { once: true });
  });
  previewResizer.addEventListener("pointerdown", (event) => {
    previewResizer.setPointerCapture(event.pointerId);
    previewResizer.classList.add("dragging");
    const bottom = panel.getBoundingClientRect().bottom;
    const move = (e: PointerEvent) => {
      previewHeight = clampPreviewHeight(bottom - e.clientY, panel.clientHeight);
      panel.style.setProperty("--preview-height", previewHeight + "px");
    };
    const up = () => {
      previewResizer.classList.remove("dragging");
      previewResizer.removeEventListener("pointermove", move);
      try { localStorage.setItem("files-preview-height", String(previewHeight)); } catch {}
    };
    previewResizer.addEventListener("pointermove", move);
    previewResizer.addEventListener("pointerup", up, { once: true });
    previewResizer.addEventListener("pointercancel", up, { once: true });
  });
  window.addEventListener("focus", () => { if (isOpen()) load().catch(host.notify); });
  // Pick up changes made elsewhere (for example by commands in the terminal).
  setInterval(async () => {
    const files = state();
    if (!files?.open || !files.path || renaming || document.visibilityState !== "visible") return;
    const dirs = view === "columns" ? [files.path, parentOf(files.path)] : [files.path, ...files.expanded];
    const stamps = await Promise.all(dirs.map((dir) => invoke<number>("dir_stamp", { path: dir }).catch(() => 0)));
    const key = stamps.join(",");
    if (stampKey && key !== stampKey) load().catch(host.notify);
    else stampKey = key;
  }, 2000);

  // ---- Public API -----------------------------------------------------------
  async function focusList() {
    await host.native({ op: "focus-web" });
    list.focus();
    if (!selection.paths.length && order.length) setSelection({ paths: [order[0]], anchor: order[0] });
  }
  async function openPanel(focus: boolean) {
    const tab = host.activeTab();
    if (!tab) return;
    tab.files = { ...(tab.files || initialFiles()), open: true };
    applyLayout();
    await load();
    if (focus) await focusList();
  }
  function close() {
    const files = state();
    if (!files?.open) return;
    update(toggleOpen(files));
    if (quickLook) toggleQuickLook().catch(host.notify);
    applyLayout();
    host.focusTerminal();
  }
  function toggleFullMode() {
    const files = state();
    if (!files) return;
    update(toggleFull(files));
    applyLayout();
    if (state()!.full) focusList().catch(host.notify);
    else host.focusTerminal();
    if (renderedPath !== state()!.path) load().catch(host.notify);
  }
  return {
    // ⌘O: open and focus, focus if already open, close when already focused.
    async toggle() {
      if (!host.activeTab()) return;
      if (!isOpen()) await openPanel(true);
      else if (hasFocus()) close();
      else await focusList();
    },
    // Header button: a plain open/close switch (the click itself moves focus).
    async toggleOpen() {
      if (isOpen()) close();
      else await openPanel(true);
    },
    toggleFull: toggleFullMode,
    isFull: () => !!state()?.open && !!state()?.full,
    // Called before every terminal layout: when the active tab changed, show
    // that tab's panel. Classes apply synchronously so the layout sees them.
    sync() {
      const tab = host.activeTab();
      if (tab === shownTab) return;
      shownTab = tab;
      if (quickLook) toggleQuickLook().catch(host.notify);
      applyLayout(false);
      if (isOpen()) {
        const cwd = host.cwd();
        if (cwd) update(onCwd(state()!, cwd));
        // In full mode the terminals are hidden, so the list takes the keyboard.
        load().then(() => (state()?.full ? focusList() : undefined)).catch(host.notify);
      }
    },
    // The focused terminal of the active tab changed directory.
    async cwdChanged(cwd: string) {
      const files = state();
      if (!files) return;
      const next = onCwd(files, cwd);
      if (next === files) return;
      update(next);
      if (next.open) await load();
    },
    handleEvent(event: { type: string; key?: string; shift?: boolean }) {
      if (event.type === "quicklook-closed") quickLook = false;
      if (event.type === "quicklook-key" && event.key) setSelection(moveSelection(selection, order, event.key === "ArrowDown" ? 1 : -1, !!event.shift));
    },
    // Finder drops: copy into the folder under the pointer, or the panel's folder.
    dropTarget(element: Element | null): string | undefined {
      if (!isOpen() || !element?.closest("#files")) return undefined;
      const entry = entries.get(element.closest<HTMLElement>(".file-row")?.dataset.path || "");
      return entry?.is_dir ? entry.path : state()?.path;
    },
    async drop(paths: string[], destination: string) {
      let result: OpResult | undefined, error: unknown;
      try { result = await run({ op: "copy", sources: paths, destination }); } catch (e) { error = e; }
      await afterChange(result, error);
    },
    highlightDrop(destination: string | undefined) {
      panel.classList.toggle("drop-target-list", !!destination && destination === state()?.path);
      for (const element of list.querySelectorAll<HTMLElement>(".file-row.is-dir")) element.classList.toggle("drop-target", element.dataset.path === destination);
    },
  };
}
