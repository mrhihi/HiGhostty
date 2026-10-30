// Per-tab files panel: a drop-down overlay at the top of the workspace (or its own window). Pure state
// lives in files.ts; this module owns the DOM and talks to the native layer.
import { invoke } from "@tauri-apps/api/core";
import { popupMenu } from "./context-menu";
import { t } from "./i18n";
import { previewFits } from "./preview";
import { applyI18n, onLocaleChange } from "./i18n-runtime";
import {
  clampColumnWidth,
  clampDropHeight,
  defaultDropHeight,
  columnChain,
  columnRootFor,
  DEFAULT_COLUMN_WIDTH,
  effectiveCollapsed,
  formatDate,
  formatSize,
  initialFiles,
  sameSaved,
  saveFiles,
  moveSelection,
  navigate,
  onCwd,
  parentOf,
  previewTarget,
  pruneColumnWidths,
  pruneSelection,
  rememberColumnWidth,
  returnToCwd,
  select,
  shownInTab,
  shellQuote,
  sortEntries,
  stemLength,
  toggleExpanded,
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
  previewFile(path: string): void;
  // Swaps the tab's preview pane to this file, opening the pane when there is none.
  followPreview(path: string): void;
  // The active tab has a preview pane (shown in the right half while the overlay is wide enough).
  hasPreview(): boolean;
  insertIntoTerminal(text: string): Promise<void>;
  focusTerminal(): void;
  layoutChanged(): void;
  // The tab's panel was opened, closed, moved or its folders expanded: remember it for next launch.
  visibilityChanged(tab: FilesTab): void;
  notify(error: unknown): void;
  // The panel runs in its own window (files-window.ts) instead of beside a terminal.
  standalone?: boolean;
  // Pop the panel out into its own window, or (standalone) back into its tab.
  popOut?(): void;
  // The tab's panel is popped out: bring that window forward.
  focusDetached?(): void;
  // Standalone close button.
  closeWindow?(): void;
  // The tab's terminal changed directory while the panel is popped out.
  detachedCwd?(cwd: string): void;
  icons: Record<"folder" | "file" | "chevron" | "up" | "eye" | "close", string>;
};
type OpResult = { paths: string[]; errors: string[] };
type App = { name: string; path: string; isDefault: boolean };
type MenuEntry = { text: string; action?: () => unknown; enabled?: boolean; items?: MenuEntry[] } | { item: "Separator" };

const extraIcons = {
  follow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  popOut: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
  dock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 20H4v-6M4 20l9-9M6 10V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4"/></svg>',
  sidebar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  columns: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
};

export function initFilesPanel(host: FilesHost) {
  const { icons } = host;
  const workspace = document.getElementById("workspace")!;
  const panel = document.getElementById("files")!;
  panel.innerHTML = `<div class="files-heading">
<button id="files-up" class="icon-btn" title="Enclosing Folder (⌘↑)" aria-label="Enclosing Folder" data-i18n-title="files.up.title" data-i18n-aria-label="files.up.label">${icons.up}</button>
<nav id="files-crumbs" class="files-crumbs" aria-label="Current Location" data-i18n-aria-label="files.crumbs.label"></nav>
<button id="files-follow" class="icon-btn" title="Return to Terminal's Directory" aria-label="Return to Terminal's Directory" data-i18n-title="files.follow" data-i18n-aria-label="files.follow" hidden>${extraIcons.follow}</button>
<div class="files-view-switch" role="group" aria-label="View Mode" data-i18n-aria-label="files.viewMode"><button id="files-view-list" class="icon-btn" title="List" aria-label="List" data-i18n-title="files.viewList" data-i18n-aria-label="files.viewList">${extraIcons.list}</button><button id="files-view-columns" class="icon-btn" title="Columns" aria-label="Columns" data-i18n-title="files.viewColumns" data-i18n-aria-label="files.viewColumns">${extraIcons.columns}</button></div>
<button id="files-hidden" class="icon-btn" title="Show Hidden Files" aria-label="Show Hidden Files" data-i18n-title="files.showHidden" data-i18n-aria-label="files.showHidden" aria-pressed="false">${icons.eye}</button>
<button id="files-list-toggle" class="icon-btn" title="Collapse File List" aria-label="Collapse File List" data-i18n-title="files.listCollapse" data-i18n-aria-label="files.listCollapse" hidden>${extraIcons.sidebar}</button>
<button id="files-popout" class="icon-btn" title="Open in Window" aria-label="Open in Window" data-i18n-title="files.popOut" data-i18n-aria-label="files.popOut">${extraIcons.popOut}</button>
<button id="files-close" class="icon-btn" title="Collapse (⌘O / ⌘0)" aria-label="Collapse Files Panel" data-i18n-title="${host.standalone ? "files.close.title" : "files.collapse.title"}" data-i18n-aria-label="${host.standalone ? "files.close.label" : "files.collapse.label"}">${host.standalone ? icons.close : extraIcons.collapse}</button>
</div>
<div id="files-main"><div id="files-left"><div class="files-rail" role="toolbar" aria-orientation="vertical" aria-label="File list" data-i18n-aria-label="files.rail.label"><button id="files-rail-expand" class="icon-btn" title="Show File List" aria-label="Show File List" data-i18n-title="files.listExpand" data-i18n-aria-label="files.listExpand">${extraIcons.sidebar}</button><button id="files-rail-up" class="icon-btn" title="Enclosing Folder (⌘↑)" aria-label="Enclosing Folder" data-i18n-title="files.up.title" data-i18n-aria-label="files.up.label">${icons.up}</button><span id="files-rail-folder" class="files-rail-icon">${icons.folder}</span></div>
<div class="files-columns"><button data-sort="name" data-i18n="files.col.name">Name</button><button data-sort="size" data-i18n="files.col.size">Size</button><button data-sort="modified" data-i18n="files.col.modified">Date Modified</button></div>
<div id="files-split"><div id="files-body"><div id="files-list" role="tree" tabindex="0" aria-label="Files" data-i18n-aria-label="files.list.label" aria-multiselectable="true"></div><div class="col-resizer" role="separator" aria-orientation="vertical" aria-label="Resize Column" data-i18n-aria-label="files.resizeColumn"></div><div class="col-child" aria-label="Folder Contents" data-i18n-aria-label="files.folderContents"></div><div class="col-resizer" role="separator" aria-orientation="vertical" aria-label="Resize Column" data-i18n-aria-label="files.resizeColumn"></div></div></div>
<div id="files-status" role="status" hidden></div></div>
<div id="files-pv-resizer" role="separator" aria-orientation="vertical" aria-label="Resize Preview Width" data-i18n-aria-label="files.resizePreviewWidth"></div><div id="files-pv"></div></div>
<div id="files-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize Files Panel" data-i18n-aria-label="files.resizeHeight"></div>`;
  const resizer = document.getElementById("files-resizer")!;
  const $ = (id: string) => document.getElementById(id)!;
  const list = $("files-list");
  const body = $("files-body");
  const childColumn = panel.querySelector<HTMLElement>(".col-child")!;
  let columnWidths: Record<string, number> = {};

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
  let height = 0;
  // Icon rail instead of the list while a preview is showing (UI preference, shared by all tabs).
  let listCollapsed = false;
  let previewShown = false;
  let view: FilesView = "list";
  // Last view the user picked; new tabs and tabs without a saved view start with it.
  let defaultView: FilesView = "list";
  // Selected after the next load: a path, or "first" for the first row.
  let pendingSelect: string | undefined;
  let childToken = 0;
  let childPick: FileEntry | undefined;
  let childTimer: ReturnType<typeof setTimeout> | undefined;
  const childCache = new Map<string, FileEntry[]>();
  // Entries behind the read-only rows in the parent and child columns, for their context menus.
  const miniEntries = new WeakMap<Element, FileEntry>();
  try {
    view = defaultView = localStorage.getItem("files-view") === "columns" ? "columns" : "list";
    showHidden = localStorage.getItem("show-hidden") === "true";
    sort = { ...sort, ...JSON.parse(localStorage.getItem("files-sort") || "{}") };
    height = Number(localStorage.getItem("files-height")) || 0;
    listCollapsed = localStorage.getItem("files-list-collapsed") === "true";
    const saved = JSON.parse(localStorage.getItem("files-column-widths") || "{}");
    if (saved && typeof saved === "object") columnWidths = saved;
  } catch {}

  const state = () => host.activeTab()?.files;
  const update = (next: FilesState) => {
    const tab = host.activeTab();
    if (!tab) return;
    const before = tab.files;
    tab.files = next;
    if (!sameSaved(saveFiles(before), saveFiles(next))) host.visibilityChanged(tab);
  };
  const isOpen = () => shownInTab(state());
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

  // The drop-down covers the native terminals, so the native layer is told where the hole is (slot "files").
  let cutoutKey = "";
  function reportCutout(restoreFocus = false) {
    if (host.standalone) return;
    const box = panel.getBoundingClientRect();
    const open = !panel.hidden && box.height > 0;
    const key = open ? [box.x, box.y, box.width, box.height].join(",") : "";
    if (!restoreFocus && key === cutoutKey) return;
    cutoutKey = key;
    host.native({ op: "overlay-cutout", slot: "files", x: box.x - 8, y: box.y - 8, width: open ? box.width + 16 : 0, height: open ? box.height + 16 : 0, viewportWidth: window.innerWidth, restoreFocus }).catch(host.notify);
  }
  // The right half (preview) shows while the overlay is open, the tab has a preview and there is room for it.
  // Returns whether it shows; updateLayout hands that to the preview pane.
  function refreshPreview(): boolean {
    const shown = !host.standalone && isOpen() && host.hasPreview() && previewFits(panel.clientWidth);
    previewShown = shown;
    const collapsed = effectiveCollapsed(listCollapsed, shown);
    const main = $("files-main");
    main.classList.toggle("has-preview", shown);
    main.classList.toggle("list-collapsed", collapsed);
    const toggle = $("files-list-toggle");
    toggle.hidden = !shown;
    const label = t(collapsed ? "files.listExpand" : "files.listCollapse");
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.classList.toggle("active", collapsed);
    toggle.setAttribute("aria-pressed", String(collapsed));
    return shown;
  }
  function setListCollapsed(next: boolean) {
    listCollapsed = next;
    try { localStorage.setItem("files-list-collapsed", String(next)); } catch {}
    refreshPreview();
    if (!next && previewShown) list.focus();
  }
  if (!host.standalone) {
    new ResizeObserver(() => {
      reportCutout();
      const was = previewShown;
      refreshPreview();
      if (was !== previewShown) host.layoutChanged();
    }).observe(panel);
  }
  const workspaceHeight = () => workspace.clientHeight || window.innerHeight;

  function applyLayout(notifyHost = true) {
    const files = state();
    const open = shownInTab(files);
    workspace.classList.toggle("files-open", open);
    panel.hidden = !open;
    resizer.hidden = !!host.standalone;
    height = height ? clampDropHeight(height, workspaceHeight()) : defaultDropHeight(workspaceHeight());
    panel.style.setProperty("--files-height", height + "px");
    $("files-popout").innerHTML = host.standalone ? extraIcons.dock : extraIcons.popOut;
    $("files-popout").title = t(host.standalone ? "files.dock" : "files.popOut");
    $("files-popout").setAttribute("aria-label", t(host.standalone ? "files.dock" : "files.popOut"));
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
    refreshPreview();
    reportCutout();
    if (notifyHost) host.layoutChanged();
  }

  // Re-read the root folder and every expanded folder, then redraw.
  async function load() {
    const files = state();
    if (!files || !shownInTab(files)) return;
    if (!files.path) {
      const cwd = host.cwd() || host.home();
      update(returnToCwd(files, cwd));
    }
    const root = state()!.path!;
    const token = ++generation;
    const next = new Map<string, FileEntry[]>();
    try {
      let chain: string[] = [];
      if (view === "columns") {
        update({ ...state()!, columnRoot: columnRootFor(state()!.columnRoot, root) });
        chain = columnChain(state()!.columnRoot, root);
      }
      const ancestors = chain.map((dir) => invoke<FileEntry[]>("list_files", { path: dir, showHidden }).catch(() => undefined));
      next.set(root, await invoke<FileEntry[]>("list_files", { path: root, showHidden }));
      const listed = await Promise.all(ancestors);
      listed.forEach((listing, index) => {
        next.set(chain[index], listing || []);
        if (!listing) forgetWidths(chain[index], undefined);
      });
      forgetWidths(root, next.get(root));
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
      childCache.clear();
      draw();
      if (pendingSelect && !renaming) {
        const target = pendingSelect === "first" ? order[0] : pendingSelect;
        if (target && entries.has(target)) setSelection({ paths: [target], anchor: target });
      }
      pendingSelect = undefined;
    } catch (error) {
      if (token !== generation) return;
      forgetWidths(root, undefined);
      cache = new Map();
      renderedPath = root;
      draw();
      status(String(error));
    }
  }

  function draw() {
    const files = state();
    if (!files || !shownInTab(files) || !files.path || renaming) return;
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
    drawAncestors(files);
    if (!order.length) {
      const empty = document.createElement("p");
      empty.className = "files-empty";
      empty.textContent = cache.has(files.path) ? t("files.empty") : "";
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
      link.title = t("files.alias");
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
    miniEntries.set(element, entry);
    // Keep the keyboard on the current column after clicking a side column.
    element.onclick = (event) => {
      // ⌘+click on a file: open the auto-updating preview window instead of selecting.
      if (event.metaKey && !event.shiftKey && !entry.is_dir) { host.previewFile(entry.path); list.focus(); return; }
      onClick(); list.focus();
    };
    return element;
  }
  // One column per folder level left of the current one; each remembers its own width.
  function drawAncestors(files: FilesState) {
    for (const element of body.querySelectorAll(".col-ancestor, .col-ancestor + .col-resizer")) element.remove();
    list.dataset.dir = files.path!;
    if (view === "columns") {
      const chain = columnChain(files.columnRoot, files.path!);
      chain.forEach((dir, index) => {
        const current = chain[index + 1] ?? files.path!;
        const column = document.createElement("div");
        column.className = "col-ancestor";
        column.setAttribute("aria-label", t("files.up.label"));
        column.dataset.dir = dir;
        const fragment = document.createDocumentFragment();
        for (const entry of sortEntries(cache.get(dir) || [], sort))
          fragment.append(miniRow(entry, entry.path === current, () => (entry.is_dir ? go(entry.path) : go(dir, entry.path))));
        column.append(fragment);
        const handle = document.createElement("div");
        handle.className = "col-resizer";
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-label", t("files.resizeColumn"));
        list.before(column, handle);
        column.querySelector(".current")?.scrollIntoView({ block: "nearest" });
      });
    }
    applyColumnWidths();
    revealColumns();
  }
  // Drops remembered widths of folders that no longer exist (see pruneColumnWidths).
  function forgetWidths(dir: string, listing: FileEntry[] | undefined) {
    const next = pruneColumnWidths(columnWidths, dir, listing, showHidden);
    if (next === columnWidths) return;
    columnWidths = next;
    try { localStorage.setItem("files-column-widths", JSON.stringify(columnWidths)); } catch {}
  }
  function applyColumnWidths() {
    for (const column of body.querySelectorAll<HTMLElement>(".col-ancestor, #files-list, .col-child"))
      column.style.setProperty("--col-width", (columnWidths[column.dataset.dir || ""] ?? DEFAULT_COLUMN_WIDTH) + "px");
  }
  // Scroll sideways so the current column's left edge and the child column's right edge are visible.
  function revealColumns() {
    if (view !== "columns") return;
    let left = body.scrollLeft;
    const right = childColumn.offsetLeft + childColumn.offsetWidth;
    if (right > left + body.clientWidth) left = right - body.clientWidth;
    if (list.offsetLeft < left) left = list.offsetLeft;
    body.scrollLeft = left;
  }
  function scheduleChild() {
    if (view !== "columns") return;
    clearTimeout(childTimer);
    childTimer = setTimeout(() => drawChild().catch(host.notify), 120);
  }
  async function drawChild() {
    const token = ++childToken;
    const target = previewTarget(selection, entries);
    // The child column lists a selected folder; the file itself is previewed in the overlay's right half.
    const child = document.createElement("div");
    if (target.kind === "dir") {
      const dir = target.entry.path;
      let listing = childCache.get(dir);
      if (!listing) {
        try { listing = await invoke<FileEntry[]>("list_files", { path: dir, showHidden }); }
        catch (error) { listing = []; child.className = "preview-note"; child.textContent = String(error); }
        if (token !== childToken) return;
        childCache.set(dir, listing);
      }
      // A file picked in the child column stays highlighted there; folders still open.
      const picked = childPick && parentOf(childPick.path) === dir ? listing.find((entry) => entry.path === childPick!.path) : undefined;
      childPick = picked;
      for (const entry of sortEntries(listing, sort))
        child.append(miniRow(entry, entry.path === picked?.path, () => {
          if (entry.is_dir) { go(dir, entry.path); return; }
          childPick = entry;
          followPreview();
          if (quickLook) previewSelection(true).catch(host.notify);
          drawChild().catch(host.notify);
        }));
      if (!listing.length && !child.textContent) { child.className = "preview-note"; child.textContent = t("files.empty"); }
    }
    if (token === childToken) {
      childColumn.replaceChildren(child);
      childColumn.dataset.dir = target.kind === "dir" ? target.entry.path : "";
      applyColumnWidths();
      revealColumns();
      childColumn.querySelector(".current")?.scrollIntoView({ block: "nearest" });
    }
  }
  function setView(next: FilesView) {
    if (view === next) return;
    view = defaultView = next;
    const files = state();
    if (files) update({ ...files, view: next });
    try { localStorage.setItem("files-view", view); } catch {}
    childColumn.replaceChildren();
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
    $("files-rail-folder").title = host.displayPath(path);
  }
  function syncSelection() {
    const chosen = new Set(selection.paths);
    for (const element of list.querySelectorAll<HTMLElement>(".file-row")) {
      const on = chosen.has(element.dataset.path!);
      element.classList.toggle("selected", on);
      element.setAttribute("aria-selected", String(on));
    }
    if (quickLook) previewSelection(true).catch(host.notify);
    scheduleChild();
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
    if (!files) return Promise.resolve();
    pendingSelect = selectAfter;
    update(navigate(files, path, host.cwd()));
    status("");
    const loaded = load();
    loaded.catch(host.notify);
    return loaded;
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
    // Results in a side column keep the current selection, so that column stays put.
    const shown = result?.paths.filter((path) => entries.has(path)) || [];
    if (shown.length) setSelection({ paths: shown, anchor: shown[0] });
  }
  async function copy(cut: boolean, targets = selection.paths) {
    const paths = topLevelPaths(targets);
    if (!paths.length) return;
    await host.native({ op: "files-pasteboard-write", paths, cut });
    cutPaths = new Set(cut ? paths : []);
    for (const element of list.querySelectorAll<HTMLElement>(".file-row")) element.classList.toggle("cut", cutPaths.has(element.dataset.path!));
    status(cut ? t("files.cut", { n: paths.length }) : "", false);
  }
  async function paste(destination = targetDirectory()) {
    const board = await host.native<{ paths: string[]; cut: boolean }>({ op: "files-pasteboard-read" });
    if (!board.cut) cutPaths = new Set();
    if (!board.paths.length) { status(t("files.clipboardEmpty")); return; }
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
  async function duplicate(targets = selection.paths) {
    const paths = topLevelPaths(targets);
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
  async function trash(targets = selection.paths) {
    const paths = topLevelPaths(targets);
    if (!paths.length) return;
    // Items in a side column leave the current selection alone.
    const side = !paths.some((path) => entries.has(path));
    // Select the row after the last trashed one, like Finder.
    const after = order.slice(order.indexOf(targets.at(-1)!) + 1).find((path) => !paths.some((gone) => path === gone || path.startsWith(gone + "/")));
    let result: OpResult | undefined, error: unknown;
    try { result = await run({ op: "trash", paths }); } catch (e) { error = e; }
    report(result, error);
    await load();
    if (!side) setSelection(after && entries.has(after) ? { paths: [after], anchor: after } : { paths: [] });
  }
  // at: a folder from a side column's menu.
  async function create(kind: "folder" | "file", entry?: FileEntry, at?: string) {
    // Columns mode only shows the current folder, so new items go there.
    const directory = at || (view === "columns" ? targetDirectory() : targetDirectory(entry));
    let result: OpResult | undefined;
    try {
      result = await run({ op: kind === "folder" ? "create-folder" : "create-file", directory, name: kind === "folder" ? t("files.newFolderName") : t("files.newFileName") });
    } catch (error) { report(undefined, error); return; }
    const files = state();
    if (view === "columns" && files && directory !== files.path) {
      // Renaming happens in the current column, so move into that folder first.
      report(result);
      await go(directory, result.paths[0]);
    } else {
      if (files && directory !== files.path) update(toggleExpanded(files, directory, true));
      await afterChange(result);
    }
    if (result.paths[0]) rename(result.paths[0]);
  }
  // Renames an item from either the current column or a side column.
  async function renameItem(path: string) {
    if (!entries.has(path)) await go(parentOf(path), path);
    rename(path);
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
  async function openWith(app: string, paths = selection.paths) {
    await host.native({ op: "files-open", paths, app });
  }
  async function editInTerminal(entry: FileEntry) {
    // Run through sh so ${EDITOR} works the same under zsh, bash and fish.
    await host.editInTerminal(parentOf(entry.path), `sh -c '\${EDITOR:-vi} "$1"' sh ${shellQuote(entry.path)}`);
  }
  // A user-driven pick moves an already open preview pane to that file (never opens one).
  function followPreview() {
    const picked = childPick && selection.paths.length === 1 && selection.paths[0] === parentOf(childPick.path) ? childPick.path : undefined;
    if (picked) { host.followPreview(picked); return; }
    const target = previewTarget(selection, entries);
    if (target.kind === "file") host.followPreview(target.entry.path);
  }
  async function previewSelection(updateOnly = false, targets?: string[]) {
    // A file picked in the child column is what the user is looking at, so preview that.
    const picked = childPick && selection.paths.length === 1 && selection.paths[0] === parentOf(childPick.path) ? childPick.path : undefined;
    const paths = targets || (picked ? [picked] : selection.paths);
    if (!paths.length) { if (quickLook) await host.native({ op: "files-quicklook-close" }); return; }
    await host.native({ op: updateOnly ? "files-quicklook-update" : "files-quicklook", paths, index: 0 });
    if (!updateOnly) quickLook = true;
  }
  async function toggleQuickLook() {
    if (quickLook) { quickLook = false; await host.native({ op: "files-quicklook-close" }); }
    else await previewSelection();
  }

  // ---- Context menu (native NSMenu, so it never hides behind a terminal) ----
  const popup = (items: MenuEntry[]) => popupMenu({ items });
  const act = (fn: () => unknown) => () => { Promise.resolve().then(fn).catch((error) => status(String(error))); };
  // targets: the selection, or a single row from a side column.
  async function itemMenu(entry: FileEntry, targets = selectedEntries()) {
    const paths = targets.map((target) => target.path);
    const many = paths.length > 1;
    // New items from a side row go next to it, in the folder that column lists.
    const at = entries.has(entry.path) ? undefined : parentOf(entry.path);
    const sep = { item: "Separator" as const };
    let apps: App[] = [];
    if (!entry.is_dir && !many) {
      try { apps = (await invoke<{ apps: App[] }>("file_op", { request: { op: "open-with-apps", path: entry.path } })).apps; } catch {}
    }
    const openWithItems: MenuEntry[] = apps.map((app) => ({ text: app.isDefault ? t("files.menu.defaultApp", { name: app.name }) : app.name, action: act(() => openWith(app.path, paths)) }));
    if (apps.length > 1 && apps[0].isDefault) openWithItems.splice(1, 0, sep);
    const items: MenuEntry[] = [
      { text: entry.is_dir && !many ? t("files.menu.open") : t("files.menu.openDefault"), action: act(() => open(targets)) },
      ...(openWithItems.length ? [{ text: t("files.menu.openWith"), items: openWithItems }] : []),
      ...(!entry.is_dir && !many ? [{ text: t("files.menu.editInTerminal"), action: act(() => editInTerminal(entry)) }] : []),
      ...(!entry.is_dir && !many ? [{ text: t("files.menu.openInPreview"), action: act(() => host.previewFile(entry.path)) }] : []),
      { text: "Quick Look", action: act(() => previewSelection(false, at ? paths : undefined)) },
      sep,
      ...(entry.is_dir && !many ? [{ text: t("files.menu.openTerminalNewTab"), action: act(() => host.openTerminal(entry.path)) }] : []),
      { text: t("files.menu.insertPath"), action: act(() => host.insertIntoTerminal(paths.map(shellQuote).join(" ") + " ")) },
      { text: t("files.menu.copyPath"), action: act(() => host.native({ op: "files-pasteboard-text", text: paths.join("\n") })) },
      sep,
      { text: t("files.menu.cut"), action: act(() => copy(true, paths)) },
      { text: t("files.menu.copy"), action: act(() => copy(false, paths)) },
      { text: entry.is_dir && !many ? t("files.menu.pasteInto") : t("files.menu.paste"), action: act(() => paste(targetDirectory(many ? undefined : entry))) },
      { text: t("files.menu.duplicate"), action: act(() => duplicate(paths)) },
      { text: t("files.menu.rename"), enabled: !many, action: act(() => renameItem(entry.path)) },
      sep,
      { text: t("files.menu.newFolder"), action: act(() => create("folder", many ? undefined : entry, at)) },
      { text: t("files.menu.newFile"), action: act(() => create("file", many ? undefined : entry, at)) },
      { text: t("files.menu.reveal"), action: act(() => host.native({ op: "files-reveal", paths })) },
      sep,
      { text: t("files.menu.trash"), action: act(() => trash(paths)) },
    ];
    await popup(items);
  }
  async function backgroundMenu(dir = targetDirectory()) {
    const at = dir === state()?.path ? undefined : dir;
    await popup([
      { text: t("files.menu.newFolder"), action: act(() => create("folder", undefined, at)) },
      { text: t("files.menu.newFile"), action: act(() => create("file", undefined, at)) },
      { text: t("files.menu.paste"), action: act(() => paste(dir)) },
      { item: "Separator" },
      { text: t("files.menu.openTerminalNewTab"), action: act(() => host.openTerminal(dir)) },
      { text: t("files.menu.openInFinder"), action: act(() => host.native({ op: "files-open", paths: [dir] })) },
      { text: t("files.menu.refresh"), action: act(load) },
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
    // ⌘+click on a file opens it in the auto-updating preview window (same as the context menu entry).
    const clicked = entries.get(path);
    if (event.metaKey && !event.shiftKey && clicked && !clicked.is_dir) {
      setSelection({ paths: [path], anchor: path }, false);
      host.previewFile(path);
      return;
    }
    setSelection(select(selection, path, order, { toggle: event.metaKey, range: event.shiftKey }), false);
    followPreview();
  });
  // Dragging rows out of the panel starts a native drag session (files-drag) carrying file URLs:
  // a terminal pastes the escaped paths, Finder copies. The WebView's own HTML5 drag can't do that.
  panel.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.detail > 1 || renaming) return;
    const target = event.target as Element;
    const element = target.closest<HTMLElement>(".file-row");
    if (!element || target.closest(".file-disclosure, input")) return;
    const path = element.dataset.path ?? miniEntries.get(element)?.path;
    if (!path) return;
    const startX = event.clientX, startY = event.clientY;
    const move = (e: MouseEvent) => {
      if (!(e.buttons & 1)) { stop(); return; }
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
      stop();
      // The mousedown above already selected a list row; side-column rows drag alone.
      const paths = element.dataset.path && selection.paths.includes(path) ? [...selection.paths] : [path];
      host.native({ op: "files-drag", paths }).catch(host.notify);
    };
    const stop = () => { document.removeEventListener("mousemove", move, true); document.removeEventListener("mouseup", stop, true); };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", stop, true);
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
      ArrowDown: () => (meta ? open() : (setSelection(moveSelection(selection, order, 1, event.shiftKey)), followPreview())),
      ArrowUp: () => (meta ? goUp() : (setSelection(moveSelection(selection, order, -1, event.shiftKey)), followPreview())),
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
      Escape: () => (host.standalone ? (selection.paths.length ? setSelection({ paths: [] }) : undefined) : close()),
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
  // Side columns: a row acts on that item, empty space on the folder the column lists.
  function sideMenu(event: MouseEvent, folder: () => string | undefined) {
    event.preventDefault();
    const element = (event.target as Element).closest(".file-row");
    const entry = element ? miniEntries.get(element) : undefined;
    if (entry) {
      // Highlight a file in the child column like a click does, without moving the columns.
      if (childColumn.contains(element) && !entry.is_dir && childPick?.path !== entry.path) {
        childPick = entry;
        drawChild().catch(host.notify);
      }
      itemMenu(entry, [entry]).catch((error) => status(String(error)));
      return;
    }
    const dir = folder();
    if (dir) backgroundMenu(dir).catch((error) => status(String(error)));
  }
  body.addEventListener("contextmenu", (event) => {
    const column = (event.target as Element).closest<HTMLElement>(".col-ancestor");
    if (column) sideMenu(event, () => column.dataset.dir);
  });
  childColumn.addEventListener("contextmenu", (event) => sideMenu(event, () => {
    const target = previewTarget(selection, entries);
    return target.kind === "dir" ? target.entry.path : undefined;
  }));
  $("files-up").onclick = goUp;
  $("files-rail-up").onclick = goUp;
  $("files-rail-expand").onclick = () => setListCollapsed(false);
  $("files-list-toggle").onclick = () => setListCollapsed(!effectiveCollapsed(listCollapsed, previewShown));
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
  $("files-popout").onclick = () => host.popOut?.();
  $("files-close").onclick = () => (host.standalone ? host.closeWindow?.() : close());
  resizer.addEventListener("pointerdown", (event) => {
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");
    const top = panel.getBoundingClientRect().top;
    const move = (e: PointerEvent) => {
      height = clampDropHeight(e.clientY - top, workspaceHeight());
      panel.style.setProperty("--files-height", height + "px");
    };
    const up = () => {
      resizer.classList.remove("dragging");
      resizer.removeEventListener("pointermove", move);
      try { localStorage.setItem("files-height", String(height)); } catch {}
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up, { once: true });
    resizer.addEventListener("pointercancel", up, { once: true });
  });
  // Each column's width is remembered per folder; double-click a handle to reset it.
  body.addEventListener("pointerdown", (event) => {
    const handle = (event.target as Element).closest<HTMLElement>(".col-resizer");
    const column = handle?.previousElementSibling as HTMLElement | null;
    if (!handle || !column || event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    const startX = event.clientX, startWidth = column.offsetWidth;
    let width = startWidth;
    const move = (e: PointerEvent) => {
      width = clampColumnWidth(startWidth + e.clientX - startX);
      column.style.setProperty("--col-width", width + "px");
    };
    const up = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      const dir = column.dataset.dir;
      if (!dir || width === startWidth) return;
      columnWidths = rememberColumnWidth(columnWidths, dir, width);
      try { localStorage.setItem("files-column-widths", JSON.stringify(columnWidths)); } catch {}
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  body.addEventListener("dblclick", (event) => {
    const handle = (event.target as Element).closest<HTMLElement>(".col-resizer");
    const dir = (handle?.previousElementSibling as HTMLElement | null)?.dataset.dir;
    if (!dir) return;
    columnWidths = rememberColumnWidth(columnWidths, dir, DEFAULT_COLUMN_WIDTH);
    try { localStorage.setItem("files-column-widths", JSON.stringify(columnWidths)); } catch {}
    applyColumnWidths();
  });
  window.addEventListener("focus", () => { if (isOpen()) load().catch(host.notify); });
  // Esc collapses the drop-down; losing focus does not (the panel can stay open as a reference).
  if (!host.standalone) {
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.isComposing && !renaming && !quickLook && event.target !== list) { event.preventDefault(); close(); }
    });
  }
  // Pick up changes made elsewhere (for example by commands in the terminal).
  setInterval(async () => {
    const files = state();
    if (!files || !shownInTab(files) || !files.path || renaming || document.visibilityState !== "visible") return;
    const dirs = view === "columns" ? [files.path, ...columnChain(files.columnRoot, files.path)] : [files.path, ...files.expanded];
    const stamps = await Promise.all(dirs.map((dir) => invoke<number>("dir_stamp", { path: dir }).catch(() => 0)));
    const key = stamps.join(",");
    if (stampKey && key !== stampKey) load().catch(host.notify);
    else stampKey = key;
  }, 2000);

  // ---- Public API -----------------------------------------------------------
  async function focusList() {
    if (listCollapsed && previewShown) setListCollapsed(false);
    await host.native({ op: "focus-web" });
    list.focus();
    if (!selection.paths.length && order.length) setSelection({ paths: [order[0]], anchor: order[0] });
  }
  async function openPanel(focus: boolean) {
    const tab = host.activeTab();
    if (!tab) return;
    if (tab.files?.detached) { host.focusDetached?.(); return; }
    update({ ...(tab.files || initialFiles()), open: true });
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
    reportCutout(true);
    host.focusTerminal();
  }
  onLocaleChange(() => {
    applyI18n(panel);
    applyLayout(false);
    if (isOpen()) { draw(); drawChild().catch(host.notify); }
  });
  return {
    // ⌘O: open and focus, focus if already open, close when already focused.
    async toggle() {
      if (!host.activeTab()) return;
      if (state()?.detached) { host.focusDetached?.(); return; }
      if (!isOpen()) await openPanel(true);
      else if (hasFocus()) close();
      else await focusList();
    },
    // Esc from outside the panel (body, header button): collapse it if it is showing.
    collapse(): boolean {
      if (host.standalone || !isOpen()) return false;
      close();
      return true;
    },
    // Header button: a plain open/close switch (the click itself moves focus).
    async toggleOpen() {
      if (state()?.detached) host.focusDetached?.();
      else if (isOpen()) close();
      else await openPanel(true);
    },
    // Whether the right half shows now (sets the has-preview / list-collapsed classes); called after sync().
    refreshPreview,
    // A preview was opened from outside the panel: show the tab's overlay without taking focus.
    async reveal(tab: FilesTab) {
      if (tab.files?.detached) return;
      if (tab === host.activeTab()) { if (!isOpen()) await openPanel(false); return; }
      if (tab.files?.open) return;
      tab.files = { ...(tab.files || initialFiles()), open: true };
      host.visibilityChanged(tab);
    },
    // A tab's saved panel state was applied after it became active: show it on the next sync.
    invalidate() { shownTab = undefined; },
    // Called before every terminal layout: when the active tab changed, show
    // that tab's panel. Classes apply synchronously so the layout sees them.
    sync() {
      const tab = host.activeTab();
      if (tab === shownTab) return;
      shownTab = tab;
      if (quickLook) toggleQuickLook().catch(host.notify);
      // Each tab remembers its own view; tabs that never chose one use the last choice.
      view = state()?.view ?? defaultView;
      childColumn.replaceChildren();
        applyLayout(false);
      if (isOpen()) {
        const cwd = host.cwd();
        if (cwd) update(onCwd(state()!, cwd));
        load().catch(host.notify);
      }
    },
    // The focused terminal of the active tab changed directory.
    async cwdChanged(cwd: string) {
      const files = state();
      if (!files) return;
      if (files.detached) { host.detachedCwd?.(cwd); return; }
      const next = onCwd(files, cwd);
      if (next === files) return;
      update(next);
      if (next.open) await load();
    },
    handleEvent(event: { type: string; key?: string; shift?: boolean }) {
      if (event.type === "quicklook-closed") quickLook = false;
      if (event.type === "files-drag-ended" && isOpen()) load().catch((error) => status(String(error)));
      if (event.type === "quicklook-key" && event.key) {
        setSelection(moveSelection(selection, order, event.key === "ArrowDown" ? 1 : -1, !!event.shift));
        followPreview();
      }
    },
    // Finder drops: copy into the folder under the pointer, or the panel's folder.
    dropTarget(element: Element | null): string | undefined {
      if (!isOpen() || !element?.closest("#files")) return undefined;
      const row = element.closest<HTMLElement>(".file-row");
      const entry = row ? entries.get(row.dataset.path || "") ?? miniEntries.get(row) : undefined;
      if (entry?.is_dir) return entry.path;
      // Blank space in a column drops into the folder that column lists (not the current folder).
      return element.closest<HTMLElement>("[data-dir]")?.dataset.dir || state()?.path;
    },
    async drop(paths: string[], destination: string) {
      let result: OpResult | undefined, error: unknown;
      try {
        // Finder's rule (⌥ copy, ⌘ move, same volume moves), decided natively from the modifier keys.
        const mode = await host.native({ op: "files-drop-mode", sources: paths, destination }).catch(() => undefined) as { move?: boolean } | undefined;
        result = await run({ op: mode?.move ? "move" : "copy", sources: paths, destination });
      } catch (e) { error = e; }
      await afterChange(result, error);
    },
    highlightDrop(destination: string | undefined) {
      const columns = [...body.querySelectorAll<HTMLElement>("[data-dir]")];
      const column = destination ? columns.find((c) => c.dataset.dir === destination) : undefined;
      for (const c of columns) c.classList.toggle("drop-target-list", c === column && columns.length > 1);
      panel.classList.toggle("drop-target-list", !!destination && destination === state()?.path && columns.length <= 1);
      for (const element of list.querySelectorAll<HTMLElement>(".file-row.is-dir")) element.classList.toggle("drop-target", element.dataset.path === destination);
    },
  };
}
