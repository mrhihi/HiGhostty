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
  type Node,
  type Rect,
} from "./model";
import "./style.css";

type Favorite = { id: string; alias: string; path: string };
type Directory = { name: string; path: string; has_children: boolean };
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
};
const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `<header data-tauri-drag-region="deep"><b>◈ HiGhostty</b><span id="current">準備原生終端機</span><button id="browse">目錄 ⌘O</button><button id="settings">Ghostty 設定</button><button id="side-toggle">側欄</button></header>
<main><section id="workspace"><div id="terminals" aria-label="原生 Ghostty 工作區"></div><div id="empty" hidden><p>選擇目錄，開始工作。</p><button id="first">開啟目錄</button></div>
<section id="drawer" aria-label="目錄瀏覽"><div class="drawer-tools"><button id="up">↑ 上層</button><input id="path" aria-label="目錄路徑" placeholder="支援 ~/目錄"><button id="go">前往</button><button id="pick">選擇資料夾…</button><button id="open">在此開啟終端機</button><select id="layout" aria-label="瀏覽模式"><option value="tree">目錄樹列表</option><option value="columns">直欄</option></select><select id="edge" aria-label="面板位置"><option value="bottom">由下而上</option><option value="top">由上而下</option></select><button id="hide" aria-label="收合目錄">×</button></div><div id="directories"></div></section></section>
<aside><div class="section-title">工作區 <button id="new" aria-label="新增工作區">＋</button></div><div id="tabs"></div><div class="section-title">收藏 <button id="favorite-add" aria-label="新增收藏">＋</button></div><div id="favorites"></div><p class="hint">Ghostty 快捷鍵優先<br>⌘T 新頁籤 · ⌘D 分割<br>⌘W 關閉目前終端機</p></aside></main>
<footer><span id="status">原生 Ghostty · Metal · macOS</span><span id="search-status"></span></footer>
<dialog id="confirm"><h3>關閉終端機？</h3><p>以下工作仍在執行，確認後會終止相關程序。</p><pre id="processes"></pre><div class="actions"><button id="cancel-close">取消</button><button id="force-close" class="danger">終止並關閉</button></div></dialog>
<dialog id="edit"><h3>收藏目錄</h3><label>別名<input id="alias" required></label><label>路徑<div class="field-row"><input id="favorite-path" required><button id="favorite-pick">選擇…</button></div></label><div class="actions"><button id="cancel-edit">取消</button><button id="save-edit">儲存</button></div></dialog>
<dialog id="config"><h3>共用 Ghostty 設定</h3><p id="config-path"></p><p id="config-summary"></p><pre id="config-diagnostics"></pre><div class="actions"><button id="open-config">開啟設定檔</button><button id="reload-config">重新載入</button><button id="close-config">完成</button></div></dialog>
<dialog id="palette"><h3 id="palette-title">命令</h3><div id="palette-items"></div><div class="actions"><button id="close-palette">關閉</button></div></dialog>
<dialog id="rename"><h3>工作區名稱</h3><input id="rename-value" aria-label="工作區名稱"><div class="actions"><button id="cancel-rename">取消</button><button id="save-rename">儲存</button></div></dialog>
<div id="search" hidden><input id="search-input" aria-label="搜尋終端機"><button id="search-prev">↑</button><button id="search-next">↓</button><button id="search-close">×</button></div><div id="notice" role="alert"></div>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const native = <T = Record<string, unknown>>(
  request: Record<string, unknown>,
) => invoke<T>("native", { request });
let tabs: Tab[] = [],
  active: Tab | undefined,
  surfaces = new Map<string, Surface>(),
  favorites: Favorite[] = [],
  browsePath = "",
  browseRoot = "",
  columns: string[] = [],
  generation = 0,
  editing: string | undefined;
let config: NativeConfig | undefined,
  closeAction: (() => Promise<void>) | undefined,
  lastRects: Rect[] = [],
  layoutPending = false,
  initialized = false,
  closedHistory: { paths: string[]; title?: string }[] = [],
  redoHistory: typeof closedHistory = [],
  closing = false;
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
function dialogsOpen() {
  return !!document.querySelector("dialog[open]");
}
function renderTabs() {
  const list = $("tabs");
  list.replaceChildren();
  for (const tab of tabs) {
    const ids = leaves(tab.tree),
      s = surfaces.get(tab.focused);
    const row = document.createElement("div");
    row.className = "tab " + (tab === active ? "selected" : "");
    const title = tab.title || name(s?.cwd || "/");
    const item = button(
      `${ids.every((id) => surfaces.get(id)?.exited) ? "○" : "●"} ${title}${ids.length > 1 ? " · " + ids.length : ""}`,
      () => activate(tab),
      s?.cwd,
    );
    item.ondblclick = () => renameTab(tab);
    row.append(
      item,
      button(
        "×",
        () => requestClose(ids, (force) => closeTab(tab, force)),
        "關閉工作區",
      ),
    );
    list.append(row);
  }
  $("current").textContent = currentSurface()?.cwd || "選擇工作目錄";
  $("empty").hidden = tabs.length > 0;
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
  active = tab;
  tab.focused = id;
  if (tab.zoom) tab.zoom = id;
  renderTabs();
  await updateLayout();
  await native({ op: "focus", id });
}
async function activate(tab: Tab) {
  active = tab;
  renderTabs();
  await updateLayout();
  if ($("drawer").classList.contains("visible"))
    await followDirectory(currentSurface()?.cwd || browsePath);
  await native({ op: "focus", id: tab.focused });
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
async function newSurface(path: string, source?: string, direction?: number) {
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
    };
    tabs.push(tab);
    active = tab;
  }
  for (const event of pendingEvents.get(result.id) || [])
    await handleEvent(event);
  pendingEvents.delete(result.id);
  hideDrawer();
  renderTabs();
  await updateLayout();
  await native({ op: "focus", id: result.id });
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
    const info = await native<{ running: string[]; needsConfirm: boolean }>({
      op: "all-info",
    });
    const finish = async (force: boolean) => {
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
    for (const tab of [...tabs]) await closeTab(tab, force, false);
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
  await refreshCwd();
  await followDirectory(
    currentSurface()?.cwd || (await invoke<string>("home")),
  );
  $("drawer").classList.add("visible");
  scheduleLayout();
  $("path").focus();
}
function hideDrawer() {
  $("drawer").classList.remove("visible");
  scheduleLayout();
}
async function followDirectory(path: string) {
  browsePath = path;
  browseRoot = path;
  columns = [path];
  await drawDirectories();
}
async function choose(path: string, index?: number) {
  const normalized = await invoke<string>("resolve_path", {
    path,
    base: browsePath || undefined,
  });
  browsePath = normalized;
  if (index === undefined) {
    browseRoot = normalized;
    columns = [normalized];
  } else columns = [...columns.slice(0, index + 1), normalized];
  await drawDirectories();
}
function selectDirectory(path: string) {
  browsePath = path;
  $<HTMLInputElement>("path").value = path;
  for (const row of document.querySelectorAll<HTMLElement>(".directory-row"))
    row.classList.toggle("selected", row.dataset.path === path);
}
async function drawDirectories() {
  const token = ++generation;
  $<HTMLInputElement>("path").value = browsePath;
  const container = $("directories");
  const mode = $<HTMLSelectElement>("layout").value;
  container.className = mode;
  const content = document.createElement("div");
  try {
    if (mode === "columns") {
      content.className = "columns-inner";
      for (const [index, path] of columns.entries()) {
        const entries = await invoke<Directory[]>("directories", { path });
        if (token !== generation) return;
        const col = document.createElement("div");
        col.className = "column";
        const title = document.createElement("strong");
        title.textContent = name(path);
        col.append(
          title,
          button("在此開啟", () => newSurface(path)),
        );
        for (const entry of entries) {
          const b = button(
            entry.name,
            () => choose(entry.path, index),
            entry.path,
          );
          b.insertAdjacentHTML("afterbegin", icons.folder);
          col.append(b);
        }
        if (!entries.length) {
          const text = document.createElement("p");
          text.className = "hint";
          text.textContent = "沒有子目錄";
          col.append(text);
        }
        content.append(col);
      }
    } else {
      content.setAttribute("role", "tree");
      await tree(browseRoot, content, token, 0);
    }
    if (token !== generation) return;
    container.replaceChildren(content);
    if (mode === "columns") container.scrollLeft = container.scrollWidth;
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
  const entries = await invoke<Directory[]>("directories", { path });
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
    arrow.disabled = !entry.has_children;
    arrow.tabIndex = -1;
    const folder = button(
      entry.name,
      () => selectDirectory(entry.path),
      entry.path,
    );
    folder.className = "folder";
    folder.insertAdjacentHTML("afterbegin", icons.folder);
    folder.ondblclick = () => newSurface(entry.path).catch(notify);
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
    row.append(
      arrow,
      folder,
      button("開啟", () => newSurface(entry.path)),
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
        selectDirectory(entry.path);
      }
      if (key === "Enter" && event.metaKey)
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
      if (field === "favorite")
        $<HTMLInputElement>("favorite-path").value = path;
      else await choose(path);
    }
  } finally {
    await updateLayout();
  }
}
function renderFavorites() {
  const list = $("favorites");
  list.replaceChildren();
  for (const f of favorites) {
    const row = document.createElement("div");
    row.className = "favorite";
    row.append(
      button("☆ " + f.alias, () => newSurface(f.path), f.path),
      button("✎", () => edit(f), "編輯收藏"),
      button(
        "×",
        async () => {
          const next = favorites.filter((x) => x.id !== f.id);
          await invoke("save_favorites", { items: next });
          favorites = next;
          renderFavorites();
        },
        "刪除收藏",
      ),
    );
    list.append(row);
  }
}
async function edit(f?: Favorite) {
  editing = f?.id;
  const path = f?.path || currentSurface()?.cwd || browsePath;
  $<HTMLInputElement>("alias").value = f?.alias || name(path);
  $<HTMLInputElement>("favorite-path").value = path;
  await showDialog("edit");
  $("alias").focus();
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
  active = tab;
  $<HTMLInputElement>("rename-value").value = tab.title || "";
  showDialog("rename").catch(notify);
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
    for (const tab of tabs)
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
    add("共用 Ghostty 設定", () => showDialog("config"));
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
        active = tab;
        tab.focused = event.id!;
        renderTabs();
        if (changed && $("drawer").classList.contains("visible"))
          await followDirectory(s!.cwd);
      }
      break;
    }
    case "cwd":
      if (s && event.path && event.path !== s.cwd) {
        s.cwd = event.path;
        renderTabs();
        if (event.id === active?.focused) {
          if ($("drawer").classList.contains("visible"))
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
      const index = tabs.indexOf(tab),
        targets =
          event.mode === 1
            ? tabs.filter((t) => t !== tab)
            : event.mode === 2
              ? tabs.slice(index + 1)
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
      if (!tabs.length) break;
      const index = active ? tabs.indexOf(active) : 0,
        v = event.value!;
      const next =
        v === -1
          ? (index - 1 + tabs.length) % tabs.length
          : v === -2
            ? (index + 1) % tabs.length
            : v === -3
              ? tabs.length - 1
              : Math.min(tabs.length - 1, Math.max(0, v - 1));
      await activate(tabs[next]);
      break;
    }
    case "move-tab":
      if (active) {
        const i = tabs.indexOf(active),
          next = Math.max(0, Math.min(tabs.length - 1, i + event.value!));
        tabs.splice(i, 1);
        tabs.splice(next, 0, active);
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
      if (active) renameTab(active);
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
action("browse", browse);
action("first", browse);
action("new", browse);
action("hide", async () => {
  hideDrawer();
  await updateLayout();
  if (active) await native({ op: "focus", id: active.focused });
});
action("side-toggle", () => {
  document.body.classList.toggle("collapsed");
  scheduleLayout();
});
action("up", () => choose(parent(browsePath)));
action("go", () => choose($<HTMLInputElement>("path").value));
action("pick", () => pick("browser"));
action("open", () => newSurface(browsePath));
action("favorite-add", () => edit());
action("favorite-pick", () => pick("favorite"));
action("cancel-edit", () => closeDialog("edit"));
action("save-edit", async () => {
  const alias = $<HTMLInputElement>("alias").value.trim();
  if (!alias) throw "請填寫別名";
  const path = await invoke<string>("resolve_path", {
    path: $<HTMLInputElement>("favorite-path").value,
    base: browsePath,
  });
  const item = { id: editing || crypto.randomUUID(), alias, path };
  const next = editing
    ? favorites.map((x) => (x.id === editing ? item : x))
    : [...favorites, item];
  await invoke("save_favorites", { items: next });
  favorites = next;
  renderFavorites();
  await closeDialog("edit");
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
action("settings", async () => {
  applyConfig(await native<NativeConfig>({ op: "config" }));
  await showDialog("config");
});
action("open-config", () => native({ op: "open-config" }));
action("reload-config", async () =>
  applyConfig(await native<NativeConfig>({ op: "reload" })),
);
action("close-config", () => closeDialog("config"));
action("close-palette", () => closeDialog("palette"));
action("cancel-rename", () => closeDialog("rename"));
action("save-rename", async () => {
  if (active)
    active.title =
      $<HTMLInputElement>("rename-value").value.trim() || undefined;
  renderTabs();
  await closeDialog("rename");
});
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
$("layout").onchange = () => {
  localStorage.setItem(
    "directory-layout",
    $<HTMLSelectElement>("layout").value,
  );
  columns = [browsePath];
  browseRoot = browsePath;
  drawDirectories().catch(notify);
};
$("edge").onchange = () => {
  localStorage.setItem("directory-edge", $<HTMLSelectElement>("edge").value);
  $("drawer").classList.toggle(
    "top",
    $<HTMLSelectElement>("edge").value === "top",
  );
  scheduleLayout();
};
$("path").onkeydown = (e) => {
  if (e.key === "Enter")
    choose($<HTMLInputElement>("path").value).catch(notify);
};
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", scheduleLayout);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog(dialog.id).catch(notify);
  });
}
new ResizeObserver(scheduleLayout).observe($("terminals"));
window.addEventListener("resize", scheduleLayout);
$("drawer").addEventListener("transitionend", scheduleLayout);
async function start() {
  $<HTMLSelectElement>("layout").value =
    localStorage.getItem("directory-layout") || "tree";
  $<HTMLSelectElement>("edge").value =
    localStorage.getItem("directory-edge") || "bottom";
  $("drawer").classList.toggle(
    "top",
    $<HTMLSelectElement>("edge").value === "top",
  );
  await listen<Favorite[]>("favorites-changed", ({ payload }) => {
    favorites = payload;
    renderFavorites();
  });
  await listen<NativeEvent>("native-event", ({ payload }) => {
    eventQueue = eventQueue.then(() => handleEvent(payload)).catch(notify);
  });
  applyConfig(await native<NativeConfig>({ op: "init" }));
  initialized = true;
  favorites = await invoke<Favorite[]>("favorites");
  renderFavorites();
  browsePath = await invoke<string>("home");
  browseRoot = browsePath;
  await win.onCloseRequested((event) => {
    event.preventDefault();
    shutdown().catch(notify);
  });
  const initial = (window as unknown as { __HIGHOSTTY_INITIAL_PATH__?: string })
    .__HIGHOSTTY_INITIAL_PATH__;
  await newSurface(initial || browsePath);
  setInterval(() => {
    if (document.visibilityState === "visible" && !closing)
      refreshCwd().catch(notify);
  }, 1000);
}
start().catch(notify);
