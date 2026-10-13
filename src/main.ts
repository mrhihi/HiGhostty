import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  leaves,
  split,
  remove as removeLeaf,
  equalize,
  rectangles,
  resizeSplit,
  neighbor,
  orderGroupedItems,
  moveGroupedItem,
  dissolveGroup,
  recentFavoriteInstance,
  moveItemBefore,
  migrateFavorites,
  type FavoriteFolder,
  type StoredFavorite,
  type TabFavoriteItem,
  type Node,
  type Rect,
} from "./model";
import { closeAll, onGroupRemoved, openPanel, popDetail, pushDetail, replaceDetail, togglePanel, type Detail, type DrawerState, type Panel } from "./drawer";
import "./style.css";

type SavedTab = { paths: string[]; tree: Node; focused: number; title?: string; groupId?: string; command?: string; favoriteId?: string };
// Groups organize favorites; an open tab shows the group of the favorite it came from.
type WorkspaceFavorite = TabFavoriteItem<SavedTab>;
type FavoritesDocument = { revision: number; items: StoredFavorite<SavedTab>[] };
type Directory = { name: string; path: string; has_children: boolean; is_dir: boolean };
type Info = {
  cwd: string;
  running: string[];
  exited: boolean;
  needsConfirm: boolean;
};
type Surface = { id: string; cwd: string; title: string; exited: boolean };
type Tab = {
  id: string;
  tree: Node;
  focused: string;
  title?: string;
  zoom?: string;
  command?: string;
  favoriteId?: string;
};
type NativeConfig = {
  version: string;
  path: string;
  background: string;
  foreground: string;
  opacity: number;
  fontSize: number;
  diagnostics: string[];
};
type NativeEvent = {
  type: string;
  id?: string;
  path?: string;
  title?: string;
  value?: number;
  direction?: number;
  amount?: number;
  mode?: number;
  message?: string;
  needle?: string;
  config?: NativeConfig;
  kind?: number;
  color?: string;
};
const win = getCurrentWindow();
const icons = {
  folder:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
  folderOpen:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V6h6l2 2h10v3H7L3 19h16l3-8H7z"/></svg>',
  chevron:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  folderPlus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
  tab: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 10 3 2-3 2M12 15h4"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  go: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3-5 5 5 5"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/></svg>',
  workspace: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 3.1-.2-.1a1.7 1.7 0 0 0-1.8.1l-.2.1h-3.6l-.1-.2a1.7 1.7 0 0 0-1.5-1l-.3.1-3.1-1.8.1-.2a1.7 1.7 0 0 0-.1-1.8l-.1-.2v-3.6l.2-.1a1.7 1.7 0 0 0 1-1.5l-.1-.3 1.8-3.1.2.1a1.7 1.7 0 0 0 1.8-.1l.2-.1h3.6l.1.2a1.7 1.7 0 0 0 1.5 1l.3-.1 3.1 1.8-.1.2a1.7 1.7 0 0 0 .1 1.8l.1.2z"/></svg>',
};
const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `<header data-tauri-drag-region="deep"><b>◈ HiGhostty</b><span id="current">…</span></header>
<main><nav id="rail" aria-label="側欄">
<button id="rail-workspace" class="rail-btn" title="工作區（⌘⇧B）" aria-label="工作區（⌘⇧B）">${icons.workspace}<span id="rail-exited" hidden></span></button>
<button id="rail-favorites" class="rail-btn" title="收藏" aria-label="收藏">${icons.star}</button>
<button id="rail-directories" class="rail-btn" title="目錄（⌘O）" aria-label="目錄（⌘O）">${icons.folder}</button>
<span class="rail-spacer"></span><button id="rail-settings" class="rail-btn" title="設定" aria-label="設定">${icons.settings}</button></nav>
<section id="drawer-primary" aria-label="側欄面板"><div class="drawer-inner">
<section id="panel-workspace" class="panel-content"><div class="drawer-heading"><strong>工作區</strong><button id="new" class="icon-btn" title="新增頁籤" aria-label="新增頁籤">${icons.plus}</button></div><div id="tabs" role="tree" aria-label="工作區"></div></section>
<section id="panel-favorites" class="panel-content"><div class="drawer-heading"><strong>收藏</strong><button id="favorite-add" class="icon-btn" title="新增收藏" aria-label="新增收藏">${icons.plus}</button><button id="favorite-group-add" class="icon-btn" title="新增群組" aria-label="新增群組">${icons.folderPlus}</button></div><div id="favorite-add-options" class="inline-actions" hidden><button id="favorite-current-tab" class="ghost-btn wide-button"></button><button id="favorite-from-dir" class="ghost-btn wide-button">從目錄建立收藏…</button></div><div id="favorites"></div></section>
<section id="panel-directories" class="panel-content"><div class="drawer-heading"><strong>目錄</strong><div class="segmented" role="group" aria-label="瀏覽模式"><button id="layout-tree" aria-label="目錄樹">樹</button><button id="layout-columns" aria-label="直欄">欄</button></div><button id="show-hidden" class="icon-btn" title="顯示隱藏檔" aria-label="顯示隱藏檔" aria-pressed="false">${icons.eye}</button></div><div class="directory-tools"><div class="path-row"><button id="up" class="icon-btn" title="上層" aria-label="上層">${icons.up}</button><input id="path" aria-label="目錄路徑" placeholder="支援 ~/目錄"><button id="go" class="icon-btn" title="前往" aria-label="前往">${icons.go}</button></div><div class="action-row"><button id="pick" class="ghost-btn">選擇資料夾…</button><button id="open" class="primary-btn">在此開啟終端機</button></div><nav id="breadcrumb" class="breadcrumb" aria-label="目前位置" hidden></nav></div><div id="directories"></div></section>
<section id="panel-settings" class="panel-content"><div class="drawer-heading"><strong>設定</strong></div><div class="settings-content"><h4>Ghostty</h4><p id="config-summary"></p><p id="config-path"></p><div class="button-row"><button id="open-config" class="ghost-btn">開啟設定檔</button><button id="reload-config" class="ghost-btn">重新載入</button></div><h4>工作階段</h4><label class="toggle"><input id="session-enabled" type="checkbox">關閉 app 時記住開啟中的頁籤</label><h4>診斷</h4><pre id="config-diagnostics"></pre><h4>快捷鍵</h4><div class="shortcut-list"><kbd>⌘1～⌘0</kbd><span>切換頁籤</span><kbd>⌘⇧B</kbd><span>開合側欄</span><kbd>⌘O</kbd><span>目錄</span><kbd>⌘T</kbd><span>新頁籤</span><kbd>⌘D / ⌘⇧D</kbd><span>分割</span></div></div></section>
</div></section><section id="drawer-detail" aria-label="詳細內容"><div class="drawer-inner"></div></section>
<section id="workspace"><div id="terminals" aria-label="原生 Ghostty 工作區"></div><div id="empty" hidden><p>選擇目錄，開始工作。</p><button id="first">開啟目錄</button></div></section></main>
<footer><span id="search-status"></span></footer>
<dialog id="confirm"><h3>關閉終端機？</h3><p>以下工作仍在執行，確認後會終止相關程序。</p><pre id="processes"></pre><div class="actions"><button id="cancel-close">取消</button><button id="force-close" class="danger">終止並關閉</button></div></dialog>
<dialog id="palette"><h3 id="palette-title">命令</h3><div id="palette-items"></div><div class="actions"><button id="close-palette">關閉</button></div></dialog>
<div id="search" hidden><input id="search-input" aria-label="搜尋終端機"><button id="search-prev">↑</button><button id="search-next">↓</button><button id="search-close">×</button></div><div id="notice" role="alert"></div>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const native = <T = Record<string, unknown>>(
  request: Record<string, unknown>,
) => invoke<T>("native", { request });
let tabs: Tab[] = [],
  active: Tab | undefined,
  surfaces = new Map<string, Surface>(),
  favorites: WorkspaceFavorite[] = [],
  favoritesRevision = 0,
  recentFavoriteInstances = new Map<string, string>(),
  folders: FavoriteFolder[] = [],
  browsePath = "",
  browseRoot = "",
  columns: string[] = [],
  generation = 0,
  editing: string | undefined;
let drawerState: DrawerState = { panel: null, lastPanel: "workspace", detailStack: [] };
let focusEditorOnRender = false;
let renderedDetail: Detail | undefined;
let directoryLayout: "tree" | "columns" = "tree",
  showHidden = false,
  homePath = "";
let collapsedWorkspaceGroups = new Set<string>(),
  draggingTabId: string | undefined,
  draggingFavoriteId: string | undefined,
  groupExpandTimer: ReturnType<typeof setTimeout> | undefined,
  sessionKey = (window as unknown as { __HIGHOSTTY_SESSION_KEY__?: string }).__HIGHOSTTY_SESSION_KEY__ || "main",
  sessionEnabled = true,
  persistTimer: ReturnType<typeof setTimeout> | undefined,
  restoring = false;
let config: NativeConfig | undefined,
  closeAction: (() => Promise<void>) | undefined,
  lastRects: Rect[] = [],
  layoutPending = false,
  initialized = false,
  closedHistory: { paths: string[]; title?: string }[] = [],
  redoHistory: typeof closedHistory = [],
  closing = false,
  closingForQuit = false,
  closingForWindow = false;
const pendingEvents = new Map<string, NativeEvent[]>();
let opening = 0;
let eventQueue = Promise.resolve();
const suppressedTypes = new Set([
  "focus",
  "cwd",
  "title",
  "tab-title",
  "exited",
]);
function notify(e: unknown) {
  $("notice").textContent = String(e);
  $("notice").classList.add("show");
  setTimeout(() => $("notice").classList.remove("show"), 7000);
}
function action(id: string, fn: () => unknown) {
  $(id).onclick = () => {
    Promise.resolve().then(fn).catch(notify);
  };
}
function name(path: string) {
  return path.split("/").filter(Boolean).at(-1) || "/";
}
function parent(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}
function button(label: string, fn: () => unknown, title?: string) {
  const b = document.createElement("button");
  b.textContent = label;
  b.title = title || label;
  b.onclick = () => {
    Promise.resolve().then(fn).catch(notify);
  };
  return b;
}
function currentSurface() {
  return active ? surfaces.get(active.focused) : undefined;
}
function tabFor(id: string) {
  return tabs.find((t) => leaves(t.tree).includes(id));
}
function favoriteFor(tab: Tab) {
  return tab.favoriteId ? favorites.find((item) => item.id === tab.favoriteId) : undefined;
}
function tabFolder(tab: Tab) {
  const id = favoriteFor(tab)?.groupId;
  return id ? folders.find((folder) => folder.id === id) : undefined;
}
// Screen order: ungrouped tabs first, then tabs grouped by their favorite's group.
function orderedTabs(): Tab[] {
  const keyed = tabs.map((tab) => ({ id: tab.id, groupId: tabFolder(tab)?.id, tab }));
  return orderGroupedItems(keyed, folders.map((folder) => folder.id)).map((item) => item.tab);
}
function folderFavorites(folderId?: string) {
  return favorites.filter((item) => item.groupId === folderId);
}
function dialogsOpen() {
  return !!document.querySelector("dialog[open]");
}
function detail(): Detail | undefined { return drawerState.detailStack.at(-1); }
function renderDrawer() {
  const primary = $("drawer-primary"), secondary = $("drawer-detail");
  const panel = drawerState.panel;
  primary.style.width = panel ? "272px" : "0px";
  secondary.style.width = detail() ? "256px" : "0px";
  primary.dataset.open = String(!!panel);
  secondary.dataset.open = String(!!detail());
  for (const item of ["workspace", "favorites", "directories", "settings"] as Panel[]) {
    $("panel-" + item).hidden = panel !== item;
    $("rail-" + item).classList.toggle("active", panel === item);
    $("rail-" + item).setAttribute("aria-pressed", String(panel === item));
  }
  if (window.innerWidth < 760 && detail()) primary.classList.add("compact-hidden");
  else primary.classList.remove("compact-hidden");
  // Only rebuild the second drawer when its content changed, so resizing or
  // reopening panels never wipes an editor's unsaved input.
  if (renderedDetail !== detail()) renderDetail();
  syncSelection();
  scheduleLayout();
}
// Keep list highlights in step with the second drawer without rebuilding
// the lists (rebuilding would drop an in-progress inline rename).
function syncSelection() {
  const stack = drawerState.detailStack, top = detail();
  for (const row of document.querySelectorAll<HTMLElement>(".tab-row"))
    row.classList.toggle("selected", row.dataset.tabId === active?.id || (top?.kind === "edit-tab" && top.tabId === row.dataset.tabId));
  for (const row of document.querySelectorAll<HTMLElement>(".group-row"))
    row.classList.toggle("selected", stack.some((item) => (item.kind === "group" || item.kind === "edit-group") && item.groupId === row.dataset.groupId));
  for (const row of document.querySelectorAll<HTMLElement>(".favorite-row"))
    row.classList.toggle("selected", stack.some((item) => item.kind === "edit-favorite" && item.favoriteId === row.dataset.favoriteId));
}
function setPanel(panel: Panel) { drawerState = openPanel(drawerState, panel); localStorage.setItem("drawer-panel", panel); renderDrawer(); scheduleSessionSave(); }
function toggleDrawerPanel(panel: Panel) { drawerState = togglePanel(drawerState, panel); if (drawerState.panel) localStorage.setItem("drawer-panel", drawerState.panel); renderDrawer(); if (!drawerState.panel && active) native({ op: "focus", id: active.focused }).catch(notify); scheduleSessionSave(); }
function closeDrawers() { drawerState = closeAll(drawerState); renderDrawer(); scheduleSessionSave(); if (active) native({ op: "focus", id: active.focused }).catch(notify); }
function showDetail(value: Detail, replace = false) { drawerState = replace ? replaceDetail(drawerState, value) : pushDetail(drawerState, value); focusEditorOnRender = value.kind.startsWith("edit-"); renderDrawer(); }
function showRootDetail(value: Detail) { drawerState = { ...drawerState, detailStack: [value] }; focusEditorOnRender = value.kind.startsWith("edit-"); renderDrawer(); }
function backDetail() {
  if (detail()?.kind === "dir-column") { columnBack().catch(notify); return; }
  drawerState = popDetail(drawerState); renderDrawer();
  if (active) native({ op: "focus", id: active.focused }).catch(notify);
}
function renderDetail() {
  const host = $("drawer-detail").querySelector<HTMLElement>(".drawer-inner")!;
  const current = detail();
  renderedDetail = current;
  const shouldFocusEditor = focusEditorOnRender;
  focusEditorOnRender = false;
  host.replaceChildren();
  host.ondragover = host.ondragleave = host.ondrop = null;
  host.classList.remove("drop-target-list");
  if (!current) return;
  const isEditor = current.kind.startsWith("edit-");
  const heading = document.createElement("div"); heading.className = "drawer-heading detail-heading";
  const back = button(isEditor ? "返回" : "", backDetail, "返回上一層");
  back.className = isEditor ? "ghost-btn back-btn" : "icon-btn";
  back.insertAdjacentHTML("afterbegin", icons.back);
  heading.append(back);
  const enterSaves = (save: HTMLButtonElement, ...inputs: (HTMLInputElement | undefined)[]) => {
    for (const input of inputs) if (input) input.onkeydown = (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); if (!save.disabled) save.click(); } };
  };
  if (current.kind === "dir-column") {
    const title = document.createElement("strong"); title.textContent = name(current.path); title.title = current.path;
    const open = button("在此開啟", () => newSurface(current.path), "在此開啟終端機"); open.className = "primary-btn small-btn";
    heading.append(title, open); host.append(heading);
    void invoke<Directory[]>("directories", { path: current.path, showHidden }).then((entries) => {
      if (detail() !== current) return;
      for (const entry of entries) {
        const row = document.createElement("div"); row.className = "row directory-detail-row" + (entry.is_dir ? "" : " is-file");
        const icon = document.createElement("span"); icon.className = "directory-kind"; icon.innerHTML = entry.is_dir ? icons.folder : icons.file;
        const label = button(entry.name, () => entry.is_dir && openColumn(columns.length - 1, entry.path), entry.path); label.className = "row-label"; label.disabled = !entry.is_dir;
        row.append(icon, label);
        if (entry.is_dir && entry.has_children) { const chevron = document.createElement("span"); chevron.className = "row-chevron"; chevron.innerHTML = icons.chevron; row.append(chevron); }
        host.append(row);
      }
      if (!entries.length) host.append(help("此目錄沒有項目"));
    }).catch((error) => host.append(help(String(error))));
  } else if (current.kind === "group") {
    const folder = folders.find((item) => item.id === current.groupId);
    if (!folder) { backDetail(); return; }
    const items = folderFavorites(folder.id);
    const dot = document.createElement("span"); dot.className = "group-dot"; dot.style.background = folder.color;
    const title = document.createElement("strong"); title.textContent = folder.name;
    const count = document.createElement("span"); count.className = "badge"; count.textContent = String(items.length);
    const edit = button("", () => editFolder(folder), "編輯群組"); edit.className = "icon-btn"; edit.innerHTML = icons.pencil;
    heading.append(dot, title, count, edit);
    host.append(heading);
    makeFavoriteDropZone(host, folder.id);
    if (items.length) { const openAll = button("全部開啟", () => openFolder(folder).then(closeAfterOpen), "開啟群組內所有收藏"); openAll.className = "primary-btn wide-button group-open-all"; host.append(openAll); }
    for (const item of items) appendFavoriteRow(host, item);
    if (!items.length) host.append(help("此群組還沒有收藏。把收藏拖到這裡，或按下方按鈕收藏目前頁籤。"));
    if (active) { const add = button("＋ 收藏目前頁籤到此群組", () => newFavorite({ tabId: active!.id, groupId: folder.id })); add.className = "ghost-btn wide-button"; host.append(add); }
  } else if (current.kind === "edit-tab") {
    const tab = tabs.find((item) => item.id === current.tabId);
    if (!tab) { backDetail(); return; }
    const cwd = surfaces.get(tab.focused)?.cwd || "/";
    const folder = tabFolder(tab);
    const objectName = editorIntro(host, heading, "編輯頁籤", tab.title || name(cwd), cwd);
    if (folder) { const dot = document.createElement("span"); dot.className = "group-dot"; dot.style.background = folder.color; objectName.before(dot); }
    host.append(formCaption("基本"));
    const title = document.createElement("input"); title.id = "rename-value"; title.value = tab.title || ""; title.placeholder = name(cwd); title.setAttribute("aria-label", "名稱");
    host.append(labeled("名稱", title), help("留空會跟隨目前目錄名稱。"));
    host.append(formCaption("啟動"));
    const command = document.createElement("input"); command.id = "tab-command-value"; command.className = "mono"; command.value = tab.command || ""; command.placeholder = "留空以開啟一般 shell"; command.setAttribute("aria-label", "啟動命令");
    host.append(labeled("啟動命令", command), help("只在這個頁籤的主要終端機啟動時執行。修改後於下次開啟（重啟 app 或從收藏開啟）生效。"));
    host.append(formCaption("內容"));
    for (const [index, id] of leaves(tab.tree).entries()) host.append(summaryItem(`分割 ${index + 1}${index === 0 ? " · 主要" : ""}`, surfaces.get(id)?.cwd || ""));
    const apply = () => { tab.title = title.value.trim() || undefined; tab.command = command.value.trim() || undefined; };
    host.append(formCaption("收藏"));
    const favorite = favoriteFor(tab);
    host.append(help(favorite
      ? `已連結收藏「${favorite.name}」${folder ? `（群組「${folder.name}」）` : "（未分組）"}。編輯頁籤不會自動改動收藏；頁籤的群組由收藏決定。`
      : "將目前目錄、分割布局與啟動命令存成收藏，可同時放進群組。"));
    if (favorite) {
      const update = button("更新收藏", () => { apply(); return saveTabFavorite(tab); }); update.className = "primary-btn wide-button"; host.append(update);
      const saveNew = button("另存新收藏…", () => { apply(); newFavorite({ tabId: tab.id }); }); saveNew.className = "ghost-btn wide-button"; host.append(saveNew);
      const editFav = button("編輯收藏…", () => editFavorite(favorite)); editFav.className = "ghost-btn wide-button"; host.append(editFav);
    } else {
      const saveFav = button("收藏此頁籤…", () => { apply(); newFavorite({ tabId: tab.id }); }); saveFav.className = "primary-btn wide-button"; host.append(saveFav);
    }
    host.append(formCaption("危險操作"));
    const close = button("關閉頁籤", () => requestClose(leaves(tab.tree), (force) => closeTab(tab, force))); close.className = "danger-btn wide-button"; host.append(close);
    const original = { title: tab.title || "", command: tab.command || "" };
    const save = button("儲存", () => { apply(); renderTabs(); backDetail(); });
    editorFooter(host, save);
    const updateDirty = () => { save.disabled = title.value === original.title && command.value === original.command; };
    title.oninput = () => { objectName.textContent = title.value.trim() || name(cwd); updateDirty(); };
    command.oninput = updateDirty;
    enterSaves(save, title, command);
    updateDirty();
    if (shouldFocusEditor) requestAnimationFrame(() => { title.focus(); title.select(); });
  } else if (current.kind === "edit-group") {
    const folder = current.groupId ? folders.find((item) => item.id === current.groupId) : undefined;
    if (current.groupId && !folder) { backDetail(); return; }
    const defaultName = `群組 ${folders.length + 1}`;
    const items = folder ? folderFavorites(folder.id) : [];
    const objectName = editorIntro(host, heading, folder ? "編輯群組" : "新增群組", folder?.name || defaultName, folder ? `${items.length} 個收藏` : "用來整理收藏");
    host.append(formCaption("基本"));
    const input = document.createElement("input"); input.id = "group-name"; input.value = folder?.name || defaultName; input.setAttribute("aria-label", "群組名稱"); host.append(labeled("名稱", input));
    const color = document.createElement("input"); color.id = "group-color"; color.type = "color"; color.value = folder?.color || "#77dfc0"; color.className = "color-input"; color.tabIndex = -1; color.setAttribute("aria-hidden", "true");
    const dotPreview = document.createElement("span"); dotPreview.className = "group-dot"; dotPreview.style.background = color.value; objectName.before(dotPreview);
    const palette = document.createElement("div"); palette.className = "color-swatches";
    const markChosen = () => palette.querySelectorAll<HTMLButtonElement>(".color-swatch").forEach((item) => item.classList.toggle("chosen", item.dataset.color ? item.dataset.color === color.value : !swatchColors.includes(color.value)));
    for (const value of swatchColors) { const swatch = button("", () => { color.value = value; color.dispatchEvent(new Event("input")); }, value); swatch.className = "color-swatch"; swatch.dataset.color = value; swatch.style.background = value; palette.append(swatch); }
    const custom = button("", () => { color.focus(); color.click(); }, "自訂顏色"); custom.className = "color-swatch custom-color"; palette.append(custom, color);
    markChosen();
    host.append(labeled("顏色", palette, "div"), help("從這個群組開啟的頁籤，在工作區會以此顏色標示。"));
    if (folder) {
      host.append(formCaption("內容"));
      for (const item of items) host.append(savedTabSummary(item.tab, item.name));
      if (!items.length) host.append(help("此群組目前沒有收藏"));
      if (items.length) { host.append(formCaption("開啟")); const openAll = button("全部開啟", () => openFolder(folder).then(closeAfterOpen)); openAll.className = "ghost-btn wide-button"; host.append(openAll); }
      host.append(formCaption("危險操作"), help("刪除群組後，裡面的收藏會移到未分組，不會被刪除。"));
      const remove = button("刪除群組", () => { if (confirmTwice(remove)) return deleteFolder(folder); }); remove.className = "danger-btn wide-button"; host.append(remove);
    }
    const original = { name: input.value, color: color.value };
    const save = button("儲存", () => saveFolder(folder, input.value.trim() || folder?.name || defaultName, color.value));
    editorFooter(host, save);
    const updateDirty = () => { save.disabled = !!folder && input.value === original.name && color.value === original.color; };
    input.oninput = () => { objectName.textContent = input.value.trim() || defaultName; updateDirty(); };
    color.addEventListener("input", () => { dotPreview.style.background = color.value; markChosen(); updateDirty(); });
    enterSaves(save, input);
    updateDirty();
    if (shouldFocusEditor) requestAnimationFrame(() => { input.focus(); input.select(); });
  } else if (current.kind === "edit-favorite") {
    const item = current.favoriteId ? favorites.find((favorite) => favorite.id === current.favoriteId) : undefined;
    if (current.favoriteId && !item) { backDetail(); return; }
    const sourceTab = !item && current.tabId ? tabs.find((tab) => tab.id === current.tabId) : undefined;
    if (current.tabId && !item && !sourceTab) { backDetail(); return; }
    const draft = editorDrafts.get(current) || {};
    const sourcePath = sourceTab ? surfaces.get(sourceTab.focused)?.cwd || "/" : "";
    const defaultPath = item ? item.tab.paths[0] || "" : sourceTab ? sourcePath : currentSurface()?.cwd || browsePath;
    const defaultName = item?.name || (sourceTab ? sourceTab.title || name(sourcePath) : name(defaultPath || "/"));
    const objectName = editorIntro(host, heading, item ? "編輯收藏" : sourceTab ? "收藏頁籤" : "新增收藏", draft.name || defaultName, item ? "頁籤收藏" : sourceTab ? "存下目前頁籤的目錄、分割與啟動命令" : "從目錄建立收藏");
    host.append(formCaption("基本"));
    const alias = document.createElement("input"); alias.id = "alias"; alias.value = draft.name ?? defaultName; alias.setAttribute("aria-label", "名稱"); host.append(labeled("名稱", alias));
    const groupSelect = document.createElement("select"); groupSelect.id = "favorite-group";
    groupSelect.add(new Option("未分組", "")); for (const folder of folders) groupSelect.add(new Option(folder.name, folder.id)); groupSelect.add(new Option("＋ 新群組…", "__new__"));
    groupSelect.value = draft.groupId ?? item?.groupId ?? current.groupId ?? "";
    host.append(labeled("群組", groupSelect));
    let path: HTMLInputElement | undefined;
    if (!sourceTab) {
      host.append(formCaption("目錄"));
      path = document.createElement("input"); path.id = "favorite-path"; path.value = draft.path ?? defaultPath; path.setAttribute("aria-label", "目錄");
      const row = document.createElement("div"); row.className = "field-row";
      const choose = button("選擇…", () => pick("favorite")); choose.className = "ghost-btn";
      row.append(path, choose);
      host.append(labeled("路徑", row));
      if (item) host.append(help("只修改主要終端機的目錄；分割布局維持原樣。"));
      const error = document.createElement("p"); error.id = "favorite-path-error"; error.className = "field-error"; error.hidden = true; host.append(error);
    }
    if (item || sourceTab) {
      host.append(formCaption("內容"));
      host.append(savedTabSummary(item ? item.tab : savedTab(sourceTab!), item ? undefined : "目前頁籤"));
    }
    if (item) {
      host.append(formCaption("開啟"));
      const open = button("開啟／切換", () => openFavorite(item).then(closeAfterOpen)); open.className = "primary-btn wide-button";
      const openNew = button("另開一份", () => openFavorite(item, true).then(closeAfterOpen)); openNew.className = "ghost-btn wide-button";
      host.append(open, openNew);
      host.append(formCaption("危險操作"), help("移除收藏不會關閉已開啟的頁籤。"));
      const remove = button("移除收藏", () => { if (confirmTwice(remove)) return removeFavorite(item); }); remove.className = "danger-btn wide-button"; host.append(remove);
    }
    const original = { name: item?.name || "", path: item ? defaultPath : "", groupId: item?.groupId || "" };
    const save = button(item ? "儲存" : "收藏", () => saveFavoriteEditor(current, item, sourceTab, alias.value.trim(), groupSelect.value === "__new__" ? "" : groupSelect.value, path));
    editorFooter(host, save);
    const updateDirty = () => { save.disabled = !alias.value.trim() || (!!item && alias.value === original.name && (path?.value ?? "") === original.path && groupSelect.value === original.groupId); };
    alias.oninput = () => { objectName.textContent = alias.value.trim() || defaultName; updateDirty(); };
    path?.addEventListener("input", updateDirty);
    groupSelect.onchange = () => {
      updateDirty();
      if (groupSelect.value !== "__new__") return;
      // Keep what was typed while the new-group editor is on top.
      editorDrafts.set(current, { name: alias.value, path: path?.value, groupId: item?.groupId || current.groupId || "" });
      createFolder();
    };
    enterSaves(save, alias, path);
    updateDirty();
    if (shouldFocusEditor) requestAnimationFrame(() => { alias.focus(); alias.select(); });
  }
}
const editorDrafts = new WeakMap<Detail, { name?: string; path?: string; groupId?: string }>();
const swatchColors = ["#77dfc0", "#7cc4ff", "#b59cff", "#ff9ecf", "#ff8f7a", "#f5c46b", "#a6d86e", "#9aa6b8"];
function editorIntro(host: HTMLElement, heading: HTMLElement, pageTitle: string, objectName: string, subtitle: string) {
  heading.append(Object.assign(document.createElement("strong"), { textContent: pageTitle, className: "page-title" }));
  host.append(heading);
  const intro = document.createElement("div"); intro.className = "editor-intro";
  const line = document.createElement("div"); line.className = "editor-object";
  const label = document.createElement("span"); label.textContent = objectName;
  line.append(label);
  const sub = document.createElement("p"); sub.className = "editor-subtitle"; sub.textContent = subtitle; sub.title = subtitle;
  intro.append(line, sub); host.append(intro);
  return label;
}
function editorFooter(host: HTMLElement, save: HTMLButtonElement) {
  const footer = document.createElement("div"); footer.className = "sticky-actions";
  const cancel = button("取消", backDetail); cancel.className = "ghost-btn";
  save.className = "primary-btn";
  footer.append(cancel, save); host.append(footer);
}
function summaryItem(title: string, detailText: string) {
  const item = document.createElement("div"); item.className = "summary-item";
  const strong = document.createElement("span"); strong.className = "summary-title"; strong.textContent = title;
  const sub = document.createElement("span"); sub.className = "summary-detail"; sub.textContent = detailText; sub.title = detailText;
  item.append(strong, sub); return item;
}
function savedTabSummary(tab: SavedTab, title?: string) {
  const parts = [tab.paths[0] || "", tab.paths.length > 1 ? `${tab.paths.length} 分割` : "", tab.command ? `⌘ ${tab.command}` : ""].filter(Boolean);
  return summaryItem(title || tab.title || name(tab.paths[0] || "/"), parts.join(" · "));
}
async function closeAfterOpen() {
  drawerState = { ...drawerState, detailStack: [] };
  renderDrawer();
  if (active) await native({ op: "focus", id: active.focused });
}
function formCaption(text: string) { const el = document.createElement("div"); el.className = "caption form-caption"; el.textContent = text; return el; }
function help(text: string) { const el = document.createElement("p"); el.className = "help"; el.textContent = text; return el; }
function labeled(title: string, input: HTMLElement, tag: "label" | "div" = "label") { const label = document.createElement(tag); label.className = "field"; label.append(document.createTextNode(title), input); return label; }
const confirmTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();
function confirmTwice(button: HTMLButtonElement) { if (confirmTimers.has(button)) { clearTimeout(confirmTimers.get(button)); confirmTimers.delete(button); button.textContent = button.dataset.original || "確認"; button.classList.remove("confirming"); return true; } button.dataset.original = button.textContent; button.textContent = "再按一次以確認"; button.classList.add("confirming"); const timer = setTimeout(() => { button.textContent = button.dataset.original || "確認"; button.classList.remove("confirming"); confirmTimers.delete(button); }, 3000); confirmTimers.set(button, timer); return false; }
// Returns true when the stored list used the old format and was converted.
function applyFavoritesDocument(document: FavoritesDocument) {
  const result = migrateFavorites(document.items, () => crypto.randomUUID());
  folders = result.folders;
  favorites = result.favorites;
  favoritesRevision = document.revision;
  const ids = new Set(favorites.map((item) => item.id));
  for (const tab of tabs) if (tab.favoriteId && !ids.has(tab.favoriteId)) delete tab.favoriteId;
  for (const id of recentFavoriteInstances.keys()) if (!ids.has(id)) recentFavoriteInstances.delete(id);
  const folderIds = new Set(folders.map((folder) => folder.id));
  drawerState = {
    ...drawerState,
    detailStack: drawerState.detailStack.filter((item) =>
      !((item.kind === "group" || item.kind === "edit-group") && item.groupId && !folderIds.has(item.groupId)) &&
      !(item.kind === "edit-favorite" && item.favoriteId && !ids.has(item.favoriteId))),
  };
  return result.migrated;
}
async function persistFavorites(nextFavorites: WorkspaceFavorite[], nextFolders: FavoriteFolder[] = folders) {
  try {
    applyFavoritesDocument(await invoke<FavoritesDocument>("save_group_favorites", { items: [...nextFolders, ...nextFavorites], expectedRevision: favoritesRevision }));
  } catch (error) {
    applyFavoritesDocument(await invoke<FavoritesDocument>("group_favorites"));
    renderFavorites(); renderTabs(); renderDrawer();
    throw error;
  }
}
function savedTab(tab: Tab): SavedTab {
  const ids = leaves(tab.tree);
  return { paths: ids.map((id) => surfaces.get(id)?.cwd || ""), tree: savedTree(tab.tree, ids), focused: Math.max(0, ids.indexOf(tab.focused)), title: tab.title, command: tab.command, favoriteId: tab.favoriteId };
}
function renderTabs() {
  const arranged = orderedTabs();
  const list = $("tabs");
  list.replaceChildren();
  const caption = (text: string) => { const el = document.createElement("div"); el.className = "caption"; el.textContent = text; return el; };
  const loose = arranged.filter((tab) => !tabFolder(tab));
  const ungrouped = document.createElement("section"); ungrouped.className = "tab-block";
  ungrouped.append(caption("未分組"));
  for (const tab of loose) appendTabRow(ungrouped, tab);
  if (!loose.length) ungrouped.append(help("沒有未分組的頁籤"));
  list.append(ungrouped);
  const grouped = folders.map((folder) => ({ folder, items: arranged.filter((tab) => tabFolder(tab) === folder) })).filter((entry) => entry.items.length);
  if (grouped.length) {
    list.append(Object.assign(document.createElement("div"), { className: "section-divider" }));
    for (const { folder, items } of grouped) {
      const block = document.createElement("section"); block.className = "tab-block grouped"; block.style.setProperty("--group-color", folder.color);
      // Parent row: the group; its tabs sit indented underneath and can be collapsed.
      const collapsed = collapsedWorkspaceGroups.has(folder.id);
      const heading = button("", () => {
        if (collapsedWorkspaceGroups.has(folder.id)) collapsedWorkspaceGroups.delete(folder.id); else collapsedWorkspaceGroups.add(folder.id);
        try { localStorage.setItem("workspace-collapsed-groups", JSON.stringify([...collapsedWorkspaceGroups])); } catch {}
        renderTabs();
      }, collapsed ? "展開群組" : "收合群組");
      heading.className = "row group-heading";
      heading.setAttribute("aria-expanded", String(!collapsed));
      const chevron = document.createElement("span"); chevron.className = "group-chevron" + (collapsed ? "" : " expanded"); chevron.innerHTML = icons.chevron;
      const dot = document.createElement("span"); dot.className = "group-dot";
      const label = document.createElement("span"); label.className = "group-heading-name"; label.textContent = folder.name;
      const count = document.createElement("span"); count.className = "badge"; count.textContent = String(items.length);
      const activeMark = document.createElement("span"); activeMark.className = "active-mark"; activeMark.title = "目前頁籤在此群組"; activeMark.hidden = !collapsed || !items.includes(active!);
      heading.append(chevron, dot, label, count, activeMark);
      const children = document.createElement("div"); children.className = "group-children"; children.hidden = collapsed;
      for (const tab of items) appendTabRow(children, tab, folder);
      block.append(heading, children);
      list.append(block);
    }
  }
  $("current").textContent = currentSurface()?.cwd || "選擇工作目錄";
  $("rail-exited").hidden = !tabs.some((tab) => leaves(tab.tree).every((id) => surfaces.get(id)?.exited));
  $("empty").hidden = tabs.length > 0;
  const top = detail();
  if (top?.kind === "edit-tab" && !tabs.some((tab) => tab.id === top.tabId)) renderDetail();
  renderFavorites();
  scheduleSessionSave();
}
// Reorder only within the same block: a tab's block comes from its favorite's
// group, so dragging cannot change it.
function moveTab(movingId: string, beforeId?: string) {
  const moving = tabs.find((tab) => tab.id === movingId);
  if (!moving) return;
  const rest = tabs.filter((tab) => tab !== moving);
  const index = beforeId ? rest.findIndex((tab) => tab.id === beforeId) : -1;
  if (index < 0) {
    const sameBlock = rest.map((tab, i) => ({ tab, i })).filter(({ tab }) => tabFolder(tab) === tabFolder(moving));
    rest.splice(sameBlock.length ? sameBlock.at(-1)!.i + 1 : rest.length, 0, moving);
  } else rest.splice(index, 0, moving);
  tabs = rest;
}
function appendTabRow(parent: HTMLElement, tab: Tab, folder?: FavoriteFolder) {
  const ids = leaves(tab.tree), surface = surfaces.get(tab.focused);
  const top = detail();
  const editingThis = top?.kind === "edit-tab" && top.tabId === tab.id;
  const row = document.createElement("div"); row.className = "row tab-row" + (tab === active || editingThis ? " selected" : ""); row.dataset.tabId = tab.id; row.draggable = true;
  if (folder) row.style.setProperty("--group-color", folder.color);
  row.ondragstart = (event) => { if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/highostty-tab", tab.id); } draggingTabId = tab.id; row.classList.add("dragging"); };
  row.ondragend = () => { draggingTabId = undefined; row.classList.remove("dragging"); };
  const sameBlock = () => { const moving = tabs.find((item) => item.id === draggingTabId); return !!moving && moving !== tab && tabFolder(moving) === tabFolder(tab); };
  const lowerHalf = (event: DragEvent) => event.clientY - row.getBoundingClientRect().top >= row.clientHeight / 2;
  row.ondragover = (event) => {
    if (!event.dataTransfer?.types.includes("text/highostty-tab") || !sameBlock()) return;
    event.preventDefault();
    const after = lowerHalf(event);
    row.classList.toggle("drop-before", !after);
    row.classList.toggle("drop-after", after);
  };
  row.ondragleave = (event) => { if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return; row.classList.remove("drop-before", "drop-after"); };
  row.ondrop = (event) => {
    row.classList.remove("drop-before", "drop-after");
    if (!sameBlock()) return;
    event.preventDefault(); event.stopPropagation();
    const moving = draggingTabId!;
    // Siblings exclude the dragged tab so "after the row above me" never
    // resolves to the dragged tab itself.
    const siblings = orderedTabs().filter((item) => item.id !== moving && tabFolder(item) === tabFolder(tab));
    const next = lowerHalf(event) ? siblings[siblings.indexOf(tab) + 1] : tab;
    moveTab(moving, next?.id);
    renderTabs();
  };
  const state = document.createElement("span"); state.className = "status-dot"; state.classList.toggle("exited", ids.every((id) => surfaces.get(id)?.exited));
  const label = button(tab.title || name(surface?.cwd || "/"), () => activate(tab), surface?.cwd); label.className = "row-label"; label.ondblclick = () => inlineRename(tab, label);
  row.append(state, label);
  if (ids.length > 1) { const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = String(ids.length); badge.title = `${ids.length} 個分割`; row.append(badge); }
  if (tab.favoriteId) { const star = document.createElement("span"); star.className = "favorite-mark"; star.innerHTML = icons.star; star.title = `來自收藏「${favoriteFor(tab)?.name || ""}」`; row.append(star); }
  const edit = button("", () => renameTab(tab), "編輯頁籤"); edit.className = "icon-btn row-action"; edit.innerHTML = icons.pencil;
  const close = button("", () => requestClose(ids, (force) => closeTab(tab, force)), "關閉頁籤"); close.className = "icon-btn row-action"; close.innerHTML = icons.close;
  row.append(edit, close); parent.append(row);
}
function inlineRename(tab: Tab, label: HTMLButtonElement) {
  const input = document.createElement("input"); input.className = "inline-rename"; input.value = tab.title || name(surfaces.get(tab.focused)?.cwd || "/");
  label.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = (save: boolean) => { if (done) return; done = true; if (save) tab.title = input.value.trim() || undefined; renderTabs(); };
  input.onkeydown = (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); finish(true); }
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
}
function savedTree(node: Node, ids: string[]): Node {
  if (node.kind === "leaf") return { kind: "leaf", id: String(ids.indexOf(node.id)) };
  return { ...node, first: savedTree(node.first, ids), second: savedTree(node.second, ids) };
}
function snapshot(): { tabs: SavedTab[]; activeIndex: number; collapsedSidebar: boolean } {
  const arranged = orderedTabs();
  return {
    tabs: arranged.map(savedTab),
    activeIndex: active ? arranged.indexOf(active) : 0,
    collapsedSidebar: drawerState.panel === null,
  };
}
function scheduleSessionSave() {
  if (!sessionEnabled || restoring || closingForQuit || closingForWindow) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => invoke("save_session", { key: sessionKey, snapshot: snapshot() }).catch(notify), 250);
}
function scheduleLayout() {
  if (!initialized || layoutPending) return;
  layoutPending = true;
  requestAnimationFrame(() => {
    layoutPending = false;
    updateLayout().catch(notify);
  });
}
async function updateLayout() {
  const box = $("terminals").getBoundingClientRect();
  const visible = active
    ? active.zoom
      ? [
          {
            id: active.zoom,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          },
        ]
      : rectangles(active.tree, box.x, box.y, box.width, box.height)
    : [];
  lastRects = visible;
  const host = $("terminals");
  host.replaceChildren();
  for (const r of visible) {
    const outline = document.createElement("div");
    outline.className =
      "surface-outline " + (r.id === active?.focused ? "focused" : "");
    outline.style.cssText = `left:${r.x - box.x}px;top:${r.y - box.y}px;width:${r.width}px;height:${r.height}px`;
    host.append(outline);
  }
  await native({
    op: "layout",
    rects: visible.map((r) => ({
      ...r,
      x: r.x + 1,
      y: r.y + 1,
      width: Math.max(0, r.width - 2),
      height: Math.max(0, r.height - 2),
    })),
    viewportWidth: window.innerWidth,
    suspended: dialogsOpen(),
  });
}
async function focus(id: string) {
  const tab = tabFor(id);
  if (!tab) return;
  active = tab; rememberFavoriteInstance(tab);
  tab.focused = id;
  if (tab.zoom) tab.zoom = id;
  renderTabs();
  await updateLayout();
  await native({ op: "focus", id });
}
// Switching into a tab of a collapsed workspace group opens that group.
function revealTab(tab: Tab) {
  const folder = tabFolder(tab);
  if (!folder || !collapsedWorkspaceGroups.delete(folder.id)) return;
  try { localStorage.setItem("workspace-collapsed-groups", JSON.stringify([...collapsedWorkspaceGroups])); } catch {}
}
async function activate(tab: Tab) {
  if (active !== tab) revealTab(tab);
  active = tab;
  rememberFavoriteInstance(tab);
  renderTabs();
  await updateLayout();
  if (drawerState.panel === "directories")
    await followDirectory(currentSurface()?.cwd || browsePath);
  await native({ op: "focus", id: tab.focused });
}
function rememberFavoriteInstance(tab: Tab) {
  if (tab.favoriteId) recentFavoriteInstances.set(tab.favoriteId, tab.id);
}
function applyConfig(value: NativeConfig) {
  config = value;
  document.documentElement.style.setProperty(
    "--terminal-background",
    value.background,
  );
  document.documentElement.style.setProperty(
    "--terminal-foreground",
    value.foreground,
  );
  $("config-path").textContent = value.path;
  $("config-summary").textContent =
    `Ghostty ${value.version} · ${value.fontSize}pt · 背景透明度 ${value.opacity}`;
  $("config-diagnostics").textContent =
    value.diagnostics.join("\n") || "設定載入完成";
  if (value.diagnostics.length) notify(value.diagnostics.join("\n"));
}
async function newSurface(path: string, source?: string, direction?: number, options: { command?: string } = {}) {
  const normalized = await invoke<string>("resolve_path", {
    path,
    base: browsePath || undefined,
  });
  opening++;
  let result: { id: string; cwd: string };
  try {
    result = await native<{ id: string; cwd: string }>({
      op: "open",
      path: normalized,
      source,
      split: direction !== undefined,
      command: options.command,
    });
  } finally {
    opening--;
  }
  surfaces.set(result.id, {
    id: result.id,
    cwd: result.cwd,
    title: "",
    exited: false,
  });
  if (source && direction !== undefined) {
    const tab = tabFor(source);
    if (!tab) throw new Error("找不到分割工作區");
    tab.tree = split(tab.tree, source, result.id, direction);
    tab.focused = result.id;
    active = tab;
  } else {
    const tab: Tab = {
      id: crypto.randomUUID(),
      tree: { kind: "leaf", id: result.id },
      focused: result.id,
      command: options.command,
    };
    tabs.push(tab);
    active = tab;
  }
  for (const event of pendingEvents.get(result.id) || [])
    await handleEvent(event);
  pendingEvents.delete(result.id);
  if (drawerState.panel === "directories") closeDrawers();
  renderTabs();
  await updateLayout();
  await native({ op: "focus", id: result.id });
}
function restoreTree(node: Node, ids: string[]): Node {
  if (node.kind === "leaf") return { kind: "leaf", id: ids[Number(node.id)] || ids[0] };
  return { ...node, first: restoreTree(node.first, ids), second: restoreTree(node.second, ids) };
}
// Older snapshots may still carry workspace groups; they are ignored now that
// a tab's group comes from its favorite.
async function restoreSnapshot(value: { tabs?: SavedTab[]; activeIndex?: number; collapsedSidebar?: boolean }) {
  restoring = true;
  const startIndex = tabs.length;
  try {
    for (const saved of value.tabs || []) {
      const paths = saved.paths.filter(Boolean);
      if (!paths.length) continue;
      await newSurface(paths[0], undefined, undefined, { command: saved.command });
      const tab = active!;
      const ids = [tab.focused];
      for (const path of paths.slice(1)) {
        await newSurface(path, ids[0], 0);
        ids.push(active!.focused);
      }
      tab.tree = restoreTree(saved.tree, ids);
      tab.focused = ids[saved.focused] || ids[0];
      tab.title = saved.title;
      tab.command = saved.command;
      tab.favoriteId = saved.favoriteId;
    }
    if (value.activeIndex !== undefined) active = tabs[startIndex + value.activeIndex] || active;
    else if (tabs.length > startIndex) active = tabs.at(-1);
    if (active) rememberFavoriteInstance(active);
    if (value.collapsedSidebar !== undefined) {
      drawerState = value.collapsedSidebar
        ? closeAll(drawerState)
        : openPanel(drawerState, (localStorage.getItem("drawer-panel") as Panel | null) || "workspace");
    }
  } finally { restoring = false; }
  renderTabs();
  renderDrawer();
  if (active) { await updateLayout(); await native({ op: "focus", id: active.focused }); }
}
async function destroy(id: string, force: boolean) {
  await native({ op: "close", id, force });
  await forgetSurface(id);
}
async function forgetSurface(id: string) {
  const tab = tabFor(id);
  surfaces.delete(id);
  if (!tab) return;
  const tree = removeLeaf(tab.tree, id);
  if (!tree) {
    tabs = tabs.filter((t) => t !== tab);
    if (active === tab) active = tabs.at(-1);
  } else {
    tab.tree = tree;
    if (tab.focused === id) tab.focused = leaves(tree)[0];
    if (tab.zoom === id) delete tab.zoom;
  }
  renderTabs();
  await updateLayout();
  if (active && !dialogsOpen())
    await native({ op: "focus", id: active.focused });
}
async function closeTab(tab: Tab, force: boolean, remember = true) {
  const ids = leaves(tab.tree);
  const item = {
    paths: ids.map((id) => surfaces.get(id)!.cwd),
    title: tab.title,
  };
  for (const id of ids) await destroy(id, force);
  if (remember) {
    closedHistory.push(item);
    redoHistory = [];
  }
}
async function requestClose(
  ids: string[],
  fn: (force: boolean) => Promise<void>,
) {
  if (closing) return;
  const infos = await Promise.all(
    ids.map((id) => native<Info>({ op: "info", id })),
  );
  const running = infos.flatMap((info, index) =>
    info.running.map(
      (p) => `${name(surfaces.get(ids[index])?.cwd || "/")}: ${p}`,
    ),
  );
  if (infos.some((i) => i.needsConfirm) || running.length) {
    $("processes").textContent = running.join("\n") || "終端機仍有工作執行。";
    closeAction = () => fn(true);
    await showDialog("confirm");
  } else await fn(false);
}
async function shutdown(all = false) {
  if (all) {
    if (sessionEnabled) await invoke("save_session", { key: sessionKey, snapshot: snapshot() });
    const info = await native<{ running: string[]; needsConfirm: boolean }>({
      op: "all-info",
    });
    const finish = async (force: boolean) => {
      closingForQuit = true;
      await native({ op: "close-all", force });
      await invoke("quit_app");
    };
    if (info.running.length || info.needsConfirm) {
      $("processes").textContent = info.running.join("\n") || "仍有工作執行。";
      closeAction = () => finish(true);
      await showDialog("confirm");
    } else await finish(false);
    return;
  }
  await requestClose([...surfaces.keys()], async (force) => {
    closingForWindow = true;
    for (const tab of [...tabs]) await closeTab(tab, force, false);
    await invoke("remove_session", { key: sessionKey });
    await native({ op: "forget-window" });
    await win.destroy();
  });
}
async function undoClose() {
  const item = closedHistory.pop();
  if (!item) return;
  redoHistory.push(item);
  await newSurface(item.paths[0]);
  const tab = active!;
  tab.title = item.title;
  for (const path of item.paths.slice(1))
    await newSurface(path, tab.focused, 0);
  renderTabs();
}
async function redoClose() {
  const item = redoHistory.pop();
  if (!item || !active) return;
  const tab = active;
  await requestClose(leaves(tab.tree), async (force) => {
    await closeTab(tab, force, false);
    closedHistory.push(item);
  });
}
async function refreshCwd() {
  const s = currentSurface();
  if (!s) return;
  const info = await native<{ cwd: string; exited: boolean }>({
    op: "cwd",
    id: s.id,
  });
  if (surfaces.has(s.id)) {
    if (info.cwd && info.cwd !== s.cwd)
      await handleEvent({ type: "cwd", id: s.id, path: info.cwd });
    if (info.exited !== s.exited) {
      s.exited = info.exited;
      renderTabs();
    }
  }
}
async function browse() {
  setPanel("directories");
  await refreshCwd();
  await followDirectory(
    currentSurface()?.cwd || (await invoke<string>("home")),
  );
  $("path").focus();
}
async function followDirectory(path: string) {
  browsePath = path;
  browseRoot = path;
  columns = [path];
  await drawDirectories();
}
async function choose(path: string) {
  const normalized = await invoke<string>("resolve_path", {
    path,
    base: browsePath || undefined,
  });
  browsePath = normalized;
  browseRoot = normalized;
  columns = [normalized];
  await drawDirectories();
}
// Column mode shows a two-column window: the first drawer lists the
// second-to-last column and the second drawer lists the last one.
async function openColumn(index: number, path: string) {
  columns = [...columns.slice(0, index + 1), path];
  browsePath = path;
  await drawDirectories();
}
async function columnBack() {
  if (columns.length > 1) columns = columns.slice(0, -1);
  browsePath = columns.at(-1)!;
  await drawDirectories();
}
function syncColumnDetail() {
  const last = drawerState.panel === "directories" && directoryLayout === "columns" && columns.length > 1 ? columns.at(-1)! : undefined;
  const others = drawerState.detailStack.filter((item) => item.kind !== "dir-column");
  const top = detail();
  if (last && top?.kind === "dir-column" && top.path === last) return;
  drawerState = { ...drawerState, detailStack: last ? [{ kind: "dir-column", path: last }] : others };
  renderDrawer();
}
function displayPath(path: string) {
  return homePath && (path === homePath || path.startsWith(homePath + "/")) ? "~" + path.slice(homePath.length) : path;
}
function renderBreadcrumb(path: string) {
  const nav = $("breadcrumb");
  nav.replaceChildren();
  nav.hidden = directoryLayout !== "columns";
  if (nav.hidden) return;
  const inHome = homePath && (path === homePath || path.startsWith(homePath + "/"));
  const base = inHome ? homePath : "";
  const parts = path.slice(base.length).split("/").filter(Boolean);
  const crumbs: [string, string][] = [[inHome ? "~" : "/", base || "/"]];
  let current = base;
  for (const part of parts) { current += "/" + part; crumbs.push([part, current]); }
  crumbs.forEach(([label, target], index) => {
    if (index) nav.append(Object.assign(document.createElement("span"), { textContent: "›", className: "crumb-sep" }));
    const crumb = button(label, () => choose(target), target); crumb.className = "crumb";
    nav.append(crumb);
  });
}
function selectDirectory(path: string) {
  browsePath = path;
  $<HTMLInputElement>("path").value = displayPath(path);
  for (const row of document.querySelectorAll<HTMLElement>(".directory-row"))
    row.classList.toggle("selected", row.dataset.path === path);
}
function renderDirectoryControls() {
  $("layout-tree").classList.toggle("active", directoryLayout === "tree");
  $("layout-columns").classList.toggle("active", directoryLayout === "columns");
  $("layout-tree").setAttribute("aria-pressed", String(directoryLayout === "tree"));
  $("layout-columns").setAttribute("aria-pressed", String(directoryLayout === "columns"));
  $("show-hidden").classList.toggle("active", showHidden);
  $("show-hidden").setAttribute("aria-pressed", String(showHidden));
}
async function drawDirectories() {
  const token = ++generation;
  $<HTMLInputElement>("path").value = displayPath(browsePath);
  renderDirectoryControls();
  const container = $("directories");
  container.className = directoryLayout;
  const content = document.createElement("div");
  try {
    if (directoryLayout === "columns") {
      const index = Math.max(0, columns.length - 2);
      const path = columns[index];
      renderBreadcrumb(path);
      const entries = await invoke<Directory[]>("directories", { path, showHidden });
      if (token !== generation) return;
      for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "row directory-detail-row" + (entry.is_dir ? "" : " is-file") + (columns[index + 1] === entry.path ? " selected" : "");
        const icon = document.createElement("span"); icon.className = "directory-kind"; icon.innerHTML = entry.is_dir ? icons.folder : icons.file;
        const label = button(entry.name, () => entry.is_dir && openColumn(index, entry.path), entry.path); label.className = "row-label"; label.disabled = !entry.is_dir;
        label.ondblclick = () => entry.is_dir && newSurface(entry.path).catch(notify);
        row.append(icon, label);
        if (entry.is_dir) { const open = button("開啟", () => newSurface(entry.path), "在此開啟終端機"); open.className = "ghost-btn row-action"; row.append(open); }
        content.append(row);
      }
      if (!entries.length) content.append(help("此目錄沒有項目"));
    } else {
      renderBreadcrumb(browseRoot);
      content.setAttribute("role", "tree");
      await tree(browseRoot, content, token, 0);
    }
    if (token !== generation) return;
    container.replaceChildren(content);
    syncColumnDetail();
  } catch (e) {
    if (token !== generation) return;
    container.replaceChildren();
    const text = document.createElement("p");
    text.className = "directory-error";
    text.textContent = String(e);
    container.append(text);
    throw e;
  }
}
async function tree(
  path: string,
  container: HTMLElement,
  token: number,
  depth: number,
) {
  const entries = await invoke<Directory[]>("directories", { path, showHidden });
  if (token !== generation) return;
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "此目錄沒有子目錄";
    container.append(empty);
  }
  for (const entry of entries) {
    const group = document.createElement("div");
    group.className = "tree-item";
    group.setAttribute("role", "treeitem");
    group.setAttribute("aria-label", entry.name);
    group.tabIndex = 0;
    const row = document.createElement("div");
    row.className = "directory-row";
    row.dataset.path = entry.path;
    row.classList.toggle("selected", entry.path === browsePath);
    const children = document.createElement("div");
    children.className = "tree-children";
    children.hidden = true;
    children.setAttribute("role", "group");
    let loaded = false;
    const arrow = button(
      "",
      () => toggle(),
      entry.has_children ? "展開目錄" : "沒有子目錄",
    );
    arrow.className = "expand";
    arrow.innerHTML = icons.chevron;
    arrow.disabled = !entry.has_children || !entry.is_dir;
    arrow.tabIndex = -1;
    const folder = button(
      entry.name,
      () => entry.is_dir && selectDirectory(entry.path),
      entry.path,
    );
    folder.className = "folder";
    folder.insertAdjacentHTML("afterbegin", entry.is_dir ? icons.folder : icons.file);
    folder.disabled = !entry.is_dir;
    folder.ondblclick = () => entry.is_dir && newSurface(entry.path).catch(notify);
    folder.tabIndex = -1;
    async function toggle(force?: boolean) {
      if (!entry.has_children) return;
      const expanded = force ?? children.hidden;
      children.hidden = !expanded;
      group.setAttribute("aria-expanded", String(expanded));
      arrow.classList.toggle("expanded", expanded);
      folder.querySelector("svg")?.remove();
      folder.insertAdjacentHTML(
        "afterbegin",
        expanded ? icons.folderOpen : icons.folder,
      );
      if (expanded && !loaded) {
        try {
          await tree(entry.path, children, token, depth + 1);
          loaded = true;
        } catch (e) {
          children.textContent = String(e);
          children.classList.add("directory-error");
        }
      }
    }
    if (entry.has_children) group.setAttribute("aria-expanded", "false");
    const openButton = button("開啟", () => newSurface(entry.path), "在此開啟終端機");
    openButton.className = "ghost-btn row-action";
    openButton.hidden = !entry.is_dir;
    row.append(
      arrow,
      folder,
      openButton,
    );
    group.append(row, children);
    container.append(group);
    group.onkeydown = (event) => {
      if (event.target !== group) return;
      const visible = [
          ...$("directories").querySelectorAll<HTMLElement>(
            '[role="treeitem"]',
          ),
        ].filter((x) => x.getClientRects().length > 0),
        index = visible.indexOf(group);
      const key = event.key;
      if (key === "ArrowRight") {
        event.preventDefault();
        if (children.hidden) toggle(true).catch(notify);
        else children.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
      }
      if (key === "ArrowLeft") {
        event.preventDefault();
        if (!children.hidden) toggle(false).catch(notify);
        else
          group.parentElement
            ?.closest<HTMLElement>('[role="treeitem"]')
            ?.focus();
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        visible[index + (key === "ArrowDown" ? 1 : -1)]?.focus();
      }
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        if (entry.is_dir) selectDirectory(entry.path);
      }
      if (key === "Enter" && event.metaKey && entry.is_dir)
        newSurface(entry.path).catch(notify);
    };
  }
}
async function pick(field: "browser" | "favorite") {
  await updateLayout();
  const initial =
    field === "favorite"
      ? $<HTMLInputElement>("favorite-path").value
      : browsePath;
  // Suspend all native surfaces while the OS sheet owns keyboard input.
  await native({
    op: "layout",
    rects: [],
    viewportWidth: window.innerWidth,
    suspended: true,
  });
  try {
    const path = await invoke<string | null>("pick_directory", {
      path: initial || browsePath || (await invoke<string>("home")),
    });
    if (path) {
      if (field === "favorite") {
        $<HTMLInputElement>("favorite-path").value = path;
        $("favorite-path").dispatchEvent(new Event("input"));
      }
      else await choose(path);
    }
  } finally {
    await updateLayout();
  }
}
function favoriteIsOpen(item: WorkspaceFavorite) {
  return !!recentFavoriteInstance(tabs, item.id, recentFavoriteInstances.get(item.id));
}
function renderFavorites() {
  const list = $("favorites");
  list.replaceChildren();
  const caption = (text: string) => Object.assign(document.createElement("div"), { className: "caption", textContent: text });
  const loose = folderFavorites(undefined);
  const ungrouped = document.createElement("section"); ungrouped.className = "favorite-block";
  makeFavoriteDropZone(ungrouped, undefined);
  ungrouped.append(caption("未分組"));
  for (const item of loose) appendFavoriteRow(ungrouped, item);
  if (!favorites.length && !folders.length) ungrouped.append(help("還沒有收藏。從頁籤編輯頁或上方 ＋ 收藏目前頁籤，或把 Finder 中的資料夾拖到這裡。"));
  else if (!loose.length) ungrouped.append(help("沒有未分組的收藏。把收藏拖到這裡即可移出群組。"));
  list.append(ungrouped, Object.assign(document.createElement("div"), { className: "section-divider" }), caption("群組"));
  if (!folders.length) { const empty = button("＋ 建立第一個群組", () => createFolder()); empty.className = "ghost-btn wide-button"; list.append(empty); }
  const stack = drawerState.detailStack;
  for (const folder of folders) {
    const items = folderFavorites(folder.id);
    const row = document.createElement("div"); row.className = "row group-row"; row.dataset.groupId = folder.id;
    row.classList.toggle("selected", stack.some((item) => (item.kind === "group" || item.kind === "edit-group") && item.groupId === folder.id));
    const dot = document.createElement("span"); dot.className = "group-dot"; dot.style.background = folder.color;
    const label = button(folder.name, () => toggleFolderDetail(folder), folder.name); label.className = "row-label";
    const count = document.createElement("span"); count.className = "badge"; count.textContent = String(items.length);
    const openMark = document.createElement("span"); openMark.className = "active-mark"; openMark.title = "群組內有已開啟的收藏"; openMark.hidden = !items.some(favoriteIsOpen);
    const chevron = document.createElement("span"); chevron.className = "row-chevron"; chevron.innerHTML = icons.chevron;
    const edit = button("", () => editFolder(folder), "編輯群組"); edit.className = "icon-btn row-action"; edit.innerHTML = icons.pencil;
    row.draggable = true;
    row.ondragstart = (event) => { if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/highostty-group", folder.id); } row.classList.add("dragging"); };
    row.ondragend = () => row.classList.remove("dragging");
    row.ondragover = (event) => {
      const types = event.dataTransfer?.types;
      if (types?.includes("text/highostty-favorite")) {
        event.preventDefault();
        if (row.classList.contains("drop-target-list")) return;
        row.classList.add("drop-target-list");
        clearTimeout(groupExpandTimer);
        groupExpandTimer = setTimeout(() => { const top = detail(); if (top?.kind !== "group" || top.groupId !== folder.id) showRootDetail({ kind: "group", groupId: folder.id }); }, 600);
      } else if (types?.includes("text/highostty-group")) {
        event.preventDefault();
        row.classList.add("drop-before");
      }
    };
    row.ondragleave = (event) => { if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return; clearTimeout(groupExpandTimer); row.classList.remove("drop-before", "drop-target-list"); };
    row.ondrop = (event) => {
      event.preventDefault(); event.stopPropagation(); clearTimeout(groupExpandTimer);
      row.classList.remove("drop-before", "drop-target-list");
      const movingFolder = event.dataTransfer?.getData("text/highostty-group");
      if (movingFolder && movingFolder !== folder.id) persistFavorites(favorites, moveItemBefore(folders, movingFolder, folder.id)).then(renderTabs).catch(notify);
      const movingFavorite = event.dataTransfer?.getData("text/highostty-favorite");
      if (movingFavorite) persistFavorites(moveGroupedItem(favorites, movingFavorite, folder.id)).then(renderTabs).catch(notify);
    };
    row.append(dot, label, count, openMark, chevron, edit);
    list.append(row);
  }
  if (detail()?.kind === "group") renderDetail();
}
function makeFavoriteDropZone(zone: HTMLElement, folderId: string | undefined) {
  zone.ondragover = (event) => { if (event.dataTransfer?.types.includes("text/highostty-favorite")) { event.preventDefault(); zone.classList.add("drop-target-list"); } };
  zone.ondragleave = (event) => { if (!(event.relatedTarget instanceof Node) || !zone.contains(event.relatedTarget)) zone.classList.remove("drop-target-list"); };
  zone.ondrop = (event) => {
    zone.classList.remove("drop-target-list");
    const moving = event.dataTransfer?.getData("text/highostty-favorite");
    if (!moving) return;
    event.preventDefault();
    persistFavorites(moveGroupedItem(favorites, moving, folderId || null)).then(renderTabs).catch(notify);
  };
}
function appendFavoriteRow(parent: HTMLElement, item: WorkspaceFavorite) {
  const row = document.createElement("div"); row.className = "row favorite-row"; row.dataset.favoriteId = item.id; row.draggable = true;
  const top = detail();
  row.classList.toggle("selected", top?.kind === "edit-favorite" && top.favoriteId === item.id);
  row.ondragstart = (event) => { if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/highostty-favorite", item.id); } draggingFavoriteId = item.id; row.classList.add("dragging"); };
  row.ondragend = () => { draggingFavoriteId = undefined; row.classList.remove("dragging"); };
  const lowerHalf = (event: DragEvent) => event.clientY - row.getBoundingClientRect().top >= row.clientHeight / 2;
  row.ondragover = (event) => {
    if (!event.dataTransfer?.types.includes("text/highostty-favorite") || draggingFavoriteId === item.id) return;
    event.preventDefault();
    const after = lowerHalf(event);
    row.classList.toggle("drop-before", !after);
    row.classList.toggle("drop-after", after);
  };
  row.ondragleave = (event) => { if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return; row.classList.remove("drop-before", "drop-after"); };
  row.ondrop = (event) => {
    row.classList.remove("drop-before", "drop-after");
    const moving = event.dataTransfer?.getData("text/highostty-favorite");
    if (!moving) return;
    event.preventDefault(); event.stopPropagation();
    if (moving === item.id) return;
    const siblings = favorites.filter((value) => value.id !== moving && value.groupId === item.groupId);
    const next = lowerHalf(event) ? siblings[siblings.indexOf(item) + 1] : item;
    persistFavorites(moveGroupedItem(favorites, moving, item.groupId || null, next?.id)).then(renderTabs).catch(notify);
  };
  const icon = document.createElement("span"); icon.className = "favorite-icon"; icon.innerHTML = icons.tab;
  const label = button(item.name, () => openFavorite(item), `${item.name}\n${item.tab.paths[0] || ""}`); label.className = "row-label";
  const openMark = document.createElement("span"); openMark.className = "active-mark"; openMark.title = "已開啟"; openMark.hidden = !favoriteIsOpen(item);
  const edit = button("", () => editFavorite(item), "編輯收藏"); edit.className = "icon-btn row-action"; edit.innerHTML = icons.pencil;
  row.append(icon, label);
  if (item.tab.paths.length > 1) { const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = String(item.tab.paths.length); badge.title = `${item.tab.paths.length} 個分割`; row.append(badge); }
  row.append(openMark, edit);
  parent.append(row);
}
function toggleFolderDetail(folder: FavoriteFolder) {
  const top = detail();
  if (top?.kind === "group" && top.groupId === folder.id) { drawerState = { ...drawerState, detailStack: [] }; renderDrawer(); return; }
  showRootDetail({ kind: "group", groupId: folder.id });
}
function createFolder() { showDetail({ kind: "edit-group" }); }
function editFolder(folder: FavoriteFolder) { showDetail({ kind: "edit-group", groupId: folder.id }); }
async function saveFolder(folder: FavoriteFolder | undefined, folderName: string, color: string) {
  if (folder) {
    await persistFavorites(favorites, folders.map((item) => item.id === folder.id ? { ...item, name: folderName, color } : item));
    renderTabs(); backDetail(); return;
  }
  const created: FavoriteFolder = { id: crypto.randomUUID(), kind: "folder", name: folderName, color };
  await persistFavorites(favorites, [...folders, created]);
  // Opened from a favorite editor's "＋ 新群組…": select the new group there.
  const below = drawerState.detailStack.at(-2);
  if (below?.kind === "edit-favorite") editorDrafts.set(below, { ...editorDrafts.get(below), groupId: created.id });
  renderTabs();
  if (drawerState.detailStack.length <= 1) showRootDetail({ kind: "group", groupId: created.id });
  else backDetail();
}
async function deleteFolder(folder: FavoriteFolder) {
  await persistFavorites(dissolveGroup(favorites, folder.id), folders.filter((item) => item.id !== folder.id));
  drawerState = onGroupRemoved(drawerState, folder.id);
  renderTabs(); renderDrawer();
}
async function openFolder(folder: FavoriteFolder) {
  let first: Tab | undefined;
  for (const item of folderFavorites(folder.id)) {
    let tab = recentFavoriteInstance(tabs, item.id, recentFavoriteInstances.get(item.id));
    if (!tab) {
      await restoreSnapshot({ tabs: [{ ...item.tab, favoriteId: item.id }] });
      tab = active;
      if (tab) recentFavoriteInstances.set(item.id, tab.id);
    }
    first ??= tab;
  }
  if (first) await activate(first);
}
function newFavorite(options: { tabId?: string; groupId?: string }) {
  if (!drawerState.panel) setPanel("favorites");
  showDetail({ kind: "edit-favorite", ...options });
}
// Refresh the linked favorite with the tab's current directories, splits and command.
async function saveTabFavorite(tab: Tab) {
  const favorite = favoriteFor(tab);
  if (!favorite) { newFavorite({ tabId: tab.id }); return; }
  const updated: WorkspaceFavorite = { ...favorite, tab: { ...savedTab(tab), favoriteId: favorite.id } };
  await persistFavorites(favorites.map((item) => item.id === favorite.id ? updated : item));
  renderTabs();
}
async function openFavorite(item: WorkspaceFavorite, forceNew = false) {
  const existing = recentFavoriteInstance(tabs, item.id, recentFavoriteInstances.get(item.id));
  if (!forceNew && existing) { await activate(existing); return; }
  await restoreSnapshot({ tabs: [{ ...item.tab, favoriteId: item.id }] });
  if (active) recentFavoriteInstances.set(item.id, active.id);
}
async function removeFavorite(item: WorkspaceFavorite) {
  await persistFavorites(favorites.filter((value) => value.id !== item.id));
  renderTabs(); renderDrawer();
}
async function editFavorite(item: WorkspaceFavorite) {
  showDetail({ kind: "edit-favorite", favoriteId: item.id });
}
async function edit() {
  newFavorite({});
}
async function resolveFavoritePath() {
  const input = $<HTMLInputElement>("favorite-path"), error = document.getElementById("favorite-path-error");
  try {
    const path = await invoke<string>("resolve_path", { path: input.value, base: browsePath });
    if (error) error.hidden = true;
    return path;
  } catch (reason) {
    if (!error) throw reason;
    error.textContent = String(reason); error.hidden = false; input.focus();
    return undefined;
  }
}
async function saveFavoriteEditor(current: Detail, item: WorkspaceFavorite | undefined, sourceTab: Tab | undefined, alias: string, groupId: string, pathInput?: HTMLInputElement) {
  if (!alias) { $("alias").focus(); return; }
  const group = groupId || undefined;
  let createdId: string | undefined;
  if (item) {
    let tab = item.tab;
    if (pathInput) {
      const path = await resolveFavoritePath();
      if (!path) return;
      tab = { ...tab, paths: [path, ...tab.paths.slice(1)] };
    }
    const updated: WorkspaceFavorite = { id: item.id, kind: "tab", name: alias, tab: { ...tab, title: alias }, groupId: group };
    await persistFavorites(favorites.map((value) => value.id === item.id ? updated : value));
  } else {
    const id = crypto.randomUUID();
    let tab: SavedTab;
    if (sourceTab) {
      const saved = savedTab(sourceTab);
      tab = { ...saved, favoriteId: id, title: saved.title || (alias !== name(saved.paths[0] || "/") ? alias : undefined) };
    } else {
      const path = await resolveFavoritePath();
      if (!path) return;
      tab = { paths: [path], tree: { kind: "leaf", id: "0" }, focused: 0, title: alias !== name(path) ? alias : undefined };
    }
    await persistFavorites([...favorites, { id, kind: "tab", name: alias, tab, groupId: group }]);
    if (sourceTab) { sourceTab.favoriteId = id; recentFavoriteInstances.set(id, sourceTab.id); }
    createdId = id;
  }
  editorDrafts.delete(current);
  renderTabs();
  backDetail();
  if (createdId) document.querySelector(`[data-favorite-id="${createdId}"]`)?.classList.add("flash");
}
async function showDialog(id: string) {
  if (dialogsOpen()) return;
  $<HTMLDialogElement>(id).showModal();
  await updateLayout();
}
async function closeDialog(id: string) {
  $<HTMLDialogElement>(id).close();
  await updateLayout();
  if (active && !dialogsOpen())
    await native({ op: "focus", id: active.focused });
}
function renameTab(tab: Tab) {
  showDetail({ kind: "edit-tab", tabId: tab.id, focus: "name" });
}
async function showPalette(overview = false) {
  $("palette-title").textContent = overview ? "工作區一覽" : "命令";
  const list = $("palette-items");
  list.replaceChildren();
  const add = (label: string, fn: () => Promise<unknown>) =>
    list.append(
      button(label, async () => {
        await closeDialog("palette");
        await fn();
      }),
    );
  if (overview) {
    for (const tab of orderedTabs())
      add(tab.title || name(surfaces.get(tab.focused)?.cwd || "/"), () =>
        activate(tab),
      );
  } else {
    add("選擇目錄", browse);
    add("新工作區", () => newSurface(currentSurface()?.cwd || browsePath));
    add("新視窗", () =>
      invoke("new_window", {
        path: currentSurface()?.cwd || browsePath,
        quick: false,
      }),
    );
    add("快速終端", () =>
      invoke("new_window", {
        path: currentSurface()?.cwd || browsePath,
        quick: true,
      }),
    );
    for (const [label, direction] of [
      ["向右分割", 0],
      ["向下分割", 1],
    ] as const)
      add(label, () =>
        currentSurface()
          ? newSurface(currentSurface()!.cwd, active!.focused, direction)
          : Promise.resolve(),
      );
    add("共用 Ghostty 設定", async () => { setPanel("settings"); applyConfig(await native<NativeConfig>({ op: "config" })); });
    add("重新載入 Ghostty 設定", async () =>
      applyConfig(await native<NativeConfig>({ op: "reload" })),
    );
  }
  await showDialog("palette");
}
async function search(needle = "") {
  $("search").hidden = false;
  $<HTMLInputElement>("search-input").value = needle;
  $("search-input").focus();
  scheduleLayout();
}
async function searchBinding(action: string) {
  if (active) await native({ op: "binding", id: active.focused, action });
}
async function handleEvent(event: NativeEvent) {
  const s = event.id ? surfaces.get(event.id) : undefined;
  if (event.id && !s && suppressedTypes.has(event.type)) {
    if (!opening) return;
    const list = pendingEvents.get(event.id) || [];
    list.push(event);
    pendingEvents.set(event.id, list);
    return;
  }
  switch (event.type) {
    case "focus": {
      const tab = event.id ? tabFor(event.id) : undefined;
      if (tab) {
        const changed = active !== tab || tab.focused !== event.id;
        if (active !== tab) revealTab(tab);
        active = tab; rememberFavoriteInstance(tab);
        tab.focused = event.id!;
        renderTabs();
        if (changed && drawerState.panel === "directories")
          await followDirectory(s!.cwd);
      }
      break;
    }
    case "cwd":
      if (s && event.path && event.path !== s.cwd) {
        s.cwd = event.path;
        renderTabs();
        if (event.id === active?.focused) {
          if (drawerState.panel === "directories")
            await followDirectory(event.path);
          else {
            browsePath = event.path;
            browseRoot = event.path;
            columns = [event.path];
          }
        }
      }
      break;
    case "title":
      if (s) {
        s.title = event.title || "";
        if (event.id === active?.focused)
          await win.setTitle(s.title ? `${s.title} — HiGhostty` : "HiGhostty");
      }
      break;
    case "tab-title": {
      const tab = event.id ? tabFor(event.id) : undefined;
      if (tab) {
        tab.title = event.title;
        renderTabs();
      }
      break;
    }
    case "removed":
      if (event.id && surfaces.has(event.id)) await forgetSurface(event.id);
      break;
    case "exited":
      if (s) {
        s.exited = true;
        renderTabs();
      }
      break;
    case "config":
      if (event.config) applyConfig(event.config);
      break;
    case "warning":
      notify(event.message);
      break;
    case "browse":
      await browse();
      break;
    case "toggle-sidebar":
      toggleDrawerPanel(drawerState.panel || drawerState.lastPanel);
      break;
    case "new-tab":
      await newSurface(s?.cwd || currentSurface()?.cwd || browsePath, event.id);
      break;
    case "new-window":
      await invoke("new_window", {
        path: s?.cwd || currentSurface()?.cwd || browsePath,
        quick: false,
      });
      break;
    case "quick-terminal":
      await invoke("new_window", {
        path: currentSurface()?.cwd || browsePath,
        quick: true,
      });
      break;
    case "split":
      if (s) await newSurface(s.cwd, s.id, event.direction);
      break;
    case "close-surface":
      if (s) await requestClose([s.id], (force) => destroy(s.id, force));
      break;
    case "close-tab": {
      const tab = event.id ? tabFor(event.id) : active;
      if (!tab) break;
      const arranged = orderedTabs();
      const index = arranged.indexOf(tab),
        targets =
          event.mode === 1
            ? arranged.filter((t) => t !== tab)
            : event.mode === 2
              ? arranged.slice(index + 1)
              : [tab];
      await requestClose(
        targets.flatMap((t) => leaves(t.tree)),
        async (force) => {
          for (const t of [...targets]) await closeTab(t, force);
        },
      );
      break;
    }
    case "goto-tab": {
      const arranged = orderedTabs();
      if (!arranged.length) break;
      const index = active ? arranged.indexOf(active) : 0,
        v = event.value!;
      const next =
        v === -1
          ? (index - 1 + arranged.length) % arranged.length
          : v === -2
            ? (index + 1) % arranged.length
            : v === -3
              ? arranged.length - 1
              : Math.min(arranged.length - 1, Math.max(0, v - 1));
      await activate(arranged[next]);
      break;
    }
    case "move-tab":
      if (active) {
        const arranged = orderedTabs();
        const i = arranged.indexOf(active), next = Math.max(0, Math.min(arranged.length - 1, i + event.value!));
    arranged.splice(i, 1); arranged.splice(next, 0, active); tabs = arranged;
        renderTabs();
      }
      break;
    case "goto-split":
      if (active) {
        const id = neighbor(lastRects, active.focused, event.value!);
        if (id) await focus(id);
      }
      break;
    case "resize-split":
      if (active) {
        resizeSplit(
          active.tree,
          active.focused,
          event.direction!,
          Math.max(0.01, (event.amount || 10) / 100),
        );
        await updateLayout();
      }
      break;
    case "equalize":
      if (active) {
        equalize(active.tree);
        await updateLayout();
      }
      break;
    case "zoom":
      if (active) {
        active.zoom = active.zoom ? undefined : active.focused;
        await updateLayout();
      }
      break;
    case "goto-window": {
      const labels = await invoke<string[]>("list_windows");
      const index = labels.indexOf(win.label);
      const next =
        (index + (event.value === -1 ? -1 : 1) + labels.length) % labels.length;
      await invoke("focus_window", { label: labels[next] });
      break;
    }
    case "close-window":
      await shutdown();
      break;
    case "quit":
      await shutdown(true);
      break;
    case "overview":
      await showPalette(true);
      break;
    case "command-palette":
      await showPalette();
      break;
    case "prompt-title":
      if (active) { if (drawerState.panel !== "workspace") setPanel("workspace"); renameTab(active); }
      break;
    case "search":
      await search(event.needle);
      break;
    case "end-search":
      $("search").hidden = true;
      await updateLayout();
      if (active) await native({ op: "focus", id: active.focused });
      break;
    case "search-total":
      $("search-status").textContent = `搜尋結果 ${event.value}`;
      break;
    case "search-selected":
      $("search-status").textContent = `搜尋結果 ${event.value}`;
      break;
    case "undo":
      await undoClose();
      break;
    case "redo":
      await redoClose();
      break;
    case "color":
      if (event.kind === -2 && event.color)
        document.documentElement.style.setProperty(
          "--terminal-background",
          event.color,
        );
      break;
  }
}
action("first", browse);
action("new", () => newSurface(currentSurface()?.cwd || browsePath));
action("favorite-group-add", () => createFolder());
action("up", () => choose(parent(browsePath)));
action("go", () => choose($<HTMLInputElement>("path").value));
action("pick", () => pick("browser"));
action("open", () => newSurface(browsePath));
action("favorite-add", () => {
  const options = $("favorite-add-options"); options.hidden = !options.hidden;
  $("favorite-current-tab").textContent = active ? `收藏目前頁籤「${active.title || name(currentSurface()?.cwd || "/")}」…` : "";
  $("favorite-current-tab").hidden = !active;
});
action("favorite-current-tab", () => { $("favorite-add-options").hidden = true; if (active) newFavorite({ tabId: active.id }); });
action("favorite-from-dir", () => { $("favorite-add-options").hidden = true; edit().catch(notify); });
action("show-hidden", () => {
  showHidden = !showHidden;
  localStorage.setItem("show-hidden", String(showHidden));
  return drawDirectories();
});
action("cancel-close", () => closeDialog("confirm"));
action("force-close", async () => {
  if (closing) return;
  closing = true;
  try {
    await closeAction?.();
    await closeDialog("confirm");
  } finally {
    closing = false;
  }
});
action("open-config", () => native({ op: "open-config" }));
action("reload-config", async () =>
  applyConfig(await native<NativeConfig>({ op: "reload" })),
);
action("close-palette", () => closeDialog("palette"));
action("search-prev", () => searchBinding("navigate_search:previous"));
action("search-next", () => searchBinding("navigate_search:next"));
action("search-close", async () => {
  $("search").hidden = true;
  await searchBinding("end_search");
  scheduleLayout();
});
let searchTimer: ReturnType<typeof setTimeout>;
$("search-input").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(
    () =>
      searchBinding(
        "search:" + $<HTMLInputElement>("search-input").value,
      ).catch(notify),
    150,
  );
};
$("search-input").onkeydown = (e) => {
  if (e.key === "Enter")
    searchBinding(
      e.shiftKey ? "navigate_search:previous" : "navigate_search:next",
    ).catch(notify);
  if (e.key === "Escape") $("search-close").click();
};
for (const layout of ["tree", "columns"] as const)
  action("layout-" + layout, () => {
    if (directoryLayout === layout) return;
    directoryLayout = layout;
    localStorage.setItem("directory-layout", layout);
    columns = [browsePath];
    browseRoot = browsePath;
    return drawDirectories();
  });
$<HTMLInputElement>("session-enabled").onchange = async () => {
  sessionEnabled = $<HTMLInputElement>("session-enabled").checked;
  await invoke("set_session_enabled", { enabled: sessionEnabled });
  if (sessionEnabled) scheduleSessionSave();
};
$("path").onkeydown = (e) => {
  if (e.key === "Enter" && !e.isComposing)
    choose($<HTMLInputElement>("path").value).catch(notify);
};
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.isComposing || dialogsOpen()) return;
  // Inputs with their own Escape behavior handle it; don't also close drawers.
  if (event.target instanceof Element && event.target.closest(".inline-rename, #search")) return;
  if (!$("favorite-add-options").hidden) { event.preventDefault(); $("favorite-add-options").hidden = true; return; }
  if (detail()) { event.preventDefault(); backDetail(); }
  else if (drawerState.panel) { event.preventDefault(); closeDrawers(); }
}, true);
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", scheduleLayout);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog(dialog.id).catch(notify);
  });
}
new ResizeObserver(scheduleLayout).observe($("terminals"));
window.addEventListener("resize", () => { renderDrawer(); scheduleLayout(); });
$("drawer-primary").addEventListener("transitionend", scheduleLayout);
$("drawer-detail").addEventListener("transitionend", scheduleLayout);
async function start() {
  directoryLayout = localStorage.getItem("directory-layout") === "columns" ? "columns" : "tree";
  showHidden = localStorage.getItem("show-hidden") === "true";
  try { collapsedWorkspaceGroups = new Set(JSON.parse(localStorage.getItem("workspace-collapsed-groups") || "[]")); } catch {}
  const injected = window as unknown as { __HIGHOSTTY_RESTORE__?: { tabs?: SavedTab[]; collapsedSidebar?: boolean }; __HIGHOSTTY_INITIAL_PATH__?: string };
  const savedState = await invoke<{ enabled: boolean; windows: { key: string; snapshot: { tabs?: SavedTab[]; collapsedSidebar?: boolean } }[] }>("session_state");
  sessionEnabled = savedState.enabled;
  drawerState.lastPanel = (localStorage.getItem("drawer-panel") as Panel | null) || "workspace";
  for (const [key, panel] of [["rail-workspace", "workspace"], ["rail-favorites", "favorites"], ["rail-directories", "directories"], ["rail-settings", "settings"]] as [string, Panel][]) {
    $(key).onclick = () => {
      if (panel === "settings" && drawerState.panel !== panel) native<NativeConfig>({ op: "config" }).then(applyConfig).catch(notify);
      toggleDrawerPanel(panel);
      if (panel === "directories" && drawerState.panel === panel) browse().catch(notify);
    };
  }
  $<HTMLInputElement>("session-enabled").checked = sessionEnabled;
  if (!injected.__HIGHOSTTY_RESTORE__ && sessionEnabled) {
    for (const saved of savedState.windows.filter((item) => item.key !== sessionKey))
      await invoke("restore_window", { saved });
  }
  await listen<FavoritesDocument>("group-favorites-changed", ({ payload }) => {
    applyFavoritesDocument(payload);
    renderTabs();
    renderDrawer();
    renderTabs();
  });
  await listen<boolean>("session-enabled-changed", ({ payload }) => {
    sessionEnabled = payload;
    $<HTMLInputElement>("session-enabled").checked = payload;
    if (payload) scheduleSessionSave();
  });
  await win.onDragDropEvent(async ({ payload }) => {
    const dpr = window.devicePixelRatio || 1;
    const targetAt = (position: { x: number; y: number }) => {
      const element = document.elementFromPoint(position.x / dpr, position.y / dpr);
      if (element?.closest("#favorites, #rail-favorites")) return "favorites";
      // Dropping on an open favorite group adds the directory to that group.
      if (element?.closest("#drawer-detail") && detail()?.kind === "group") return "group";
      if (element?.closest("#workspace")) return "workspace";
      return "";
    };
    if (payload.type === "enter" || payload.type === "over") {
      const target = targetAt(payload.position);
      $("workspace").classList.toggle("drop-target", target === "workspace");
      $("favorites").classList.toggle("drop-target-list", target === "favorites");
      $("drawer-detail").classList.toggle("drop-target-list", target === "group");
      return;
    }
    $("workspace").classList.remove("drop-target");
    $("favorites").classList.remove("drop-target-list");
    $("drawer-detail").classList.remove("drop-target-list");
    if (payload.type !== "drop") return;
    const target = targetAt(payload.position);
    const top = detail();
    const groupId = target === "group" && top?.kind === "group" ? top.groupId : undefined;
    for (const path of payload.paths) {
      try {
        const directory = await invoke<string>("resolve_path", { path, base: browsePath });
        if (target === "favorites" || target === "group") {
          const item: WorkspaceFavorite = { id: crypto.randomUUID(), kind: "tab", name: name(directory), tab: { paths: [directory], tree: { kind: "leaf", id: "0" }, focused: 0 }, groupId };
          await persistFavorites([...favorites, item]);
          renderFavorites();
        } else if (target === "workspace") await newSurface(directory);
      } catch (error) {
        notify("略過無法開啟的目錄：" + path + " (" + String(error) + ")");
      }
    }
  });
  await listen<NativeEvent>("native-event", ({ payload }) => {
    eventQueue = eventQueue.then(() => handleEvent(payload)).catch(notify);
  });
  applyConfig(await native<NativeConfig>({ op: "init" }));
  initialized = true;
  // Convert old group favorites once and write the new format back.
  if (applyFavoritesDocument(await invoke<FavoritesDocument>("group_favorites")))
    await persistFavorites(favorites, folders).catch(notify);
  renderFavorites();
  browsePath = homePath = await invoke<string>("home");
  browseRoot = browsePath;
  await win.onCloseRequested((event) => {
    event.preventDefault();
    shutdown().catch(notify);
  });
  const initial = (window as unknown as { __HIGHOSTTY_INITIAL_PATH__?: string })
    .__HIGHOSTTY_INITIAL_PATH__;
  const restore = injected.__HIGHOSTTY_RESTORE__ || (sessionEnabled ? savedState.windows.find((item) => item.key === sessionKey)?.snapshot : undefined);
  if (restore?.tabs?.length) await restoreSnapshot(restore);
  else {
    drawerState = openPanel(drawerState, drawerState.lastPanel || "workspace");
    renderDrawer();
    await newSurface(injected.__HIGHOSTTY_INITIAL_PATH__ || initial || browsePath);
  }
  setInterval(() => {
    if (document.visibilityState === "visible" && !closing)
      refreshCwd().catch(notify);
  }, 1000);
}
start().catch(notify);
