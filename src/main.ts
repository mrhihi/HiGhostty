import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { popupMenu as showMenu } from "./context-menu";
import { t } from "./i18n";
import { initI18n, onLocaleChange } from "./i18n-runtime";
import { createLanguageSection, renderLocaleEditor } from "./language-settings";
import {
  leaves,
  split,
  remove as removeLeaf,
  equalize,
  rectangles,
  resizeSplit,
  neighbor,
  orderTabsByFavorites,
  displayName,
  unlinkedTitle,
  orderWithChildren,
  promoteChildren,
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
import { initFilesPanel } from "./files-panel";
import { initPreviewPanel } from "./preview-panel";
import { openPreview, previewKind, splitBox, togglePreviewSide, type PreviewSide, type PreviewState } from "./preview";
import { restoreFiles, sameSaved, saveFiles, setDetached, toggleOpen, type FilesState, type SavedFiles } from "./files";
import { initSnippets } from "./snippet-palette";
import { initAttentionDrop } from "./attention-drop";
import { enableRowDrag } from "./row-drag";
import { icons } from "./icons";
import { AI_TOOLS, composeLaunch, joinCommand, parseLaunch, splitCommand, type Launch } from "./launch";
import { closeAll, onGroupRemoved, openPanel, popDetail, pushDetail, replaceDetail, togglePanel, type Detail, type DrawerState, type Panel } from "./drawer";
import { agentState, ANSWER_LOCK_MS, attachScreen, badgeText, clear, clearSource, emptyAttention, idleStep, menuAnswerable, menuKeys, promptIdentity, promptKey, prune, raise, recognizePrompt, sameMenu, snapshot, sorted, titleSpinnerStopped, unreadCount, type AgentState, type AlertSource, type AttentionState, type IdleTrack } from "./attention";
import { buildRules, formatRuleError, type CompiledRules, type Prompt } from "./prompt-rules";
import builtinRules from "./prompt-rules.json?raw";
import { newSessionName, restorable, tmuxCommand, validSession, withProgramDir, withProgramPath } from "./tmux";
import { agentCommand, alertInput, authorize, claimFor, commandLine, confirmedState, keysProblem, promptProblem, PROMPT_STALL_MS, startReady, commandProblem, errReply, findMatch, isShellName, usage, validKey, helpResult, makeMatcher, okReply, parseArgv, previewSide, resolveCaller, snippetInput, statusText, tailLines, waitLimit, waitSatisfied, WAIT_STATES, type Claim, type ControlMode, type Parsed, type Reply } from "./control";
import "./style.css";

type MenuEntry = { text: string; action: () => unknown } | { item: "Separator" };
type SavedTab = { paths: string[]; tree: Node; focused: number; title?: string; groupId?: string; command?: string; commandInShell?: boolean; tmux?: boolean; tmuxHideStatus?: boolean; tmuxSessions?: (string | undefined)[]; favoriteId?: string; parent?: number; files?: SavedFiles };
// Groups organize favorites; an open tab shows the group of the favorite it came from.
type WorkspaceFavorite = TabFavoriteItem<SavedTab>;
type FavoritesDocument = { revision: number; items: StoredFavorite<SavedTab>[] };
type Info = {
  cwd: string;
  running: string[];
  exited: boolean;
  needsConfirm: boolean;
};
type Surface = { id: string; cwd: string; title: string; exited: boolean; tmuxSession?: string; openedAt?: number; command?: string };
type Tab = {
  id: string;
  tree: Node;
  focused: string;
  title?: string;
  zoom?: string;
  command?: string;
  commandInShell?: boolean;
  tmux?: boolean;
  tmuxHideStatus?: boolean;
  favoriteId?: string;
  parentId?: string;
  files?: FilesState;
  // Preview pane beside the terminals; memory only, never saved.
  preview?: PreviewState;
  // Short status line set by `highostty ctl tab status`; shown in the tab row, never saved.
  status?: string;
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
  on?: boolean;
  id?: string;
  path?: string;
  title?: string;
  body?: string;
  event?: string;
  agent?: string;
  value?: number;
  direction?: number;
  amount?: number;
  mode?: number;
  message?: string;
  needle?: string;
  config?: NativeConfig;
  kind?: number;
  color?: string;
  key?: string;
  shift?: boolean;
};
const win = getCurrentWindow();
const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `<header data-tauri-drag-region="deep"><b>◈ HiGhostty</b><span id="current">…</span><button id="bell-btn" class="icon-btn header-btn" title="Needs attention" data-i18n-title="app.attentionTitle" aria-label="Needs attention" data-i18n-aria-label="app.attentionTitle">${icons.bell}<span id="bell-count" hidden></span></button><button id="files-toggle" class="icon-btn header-btn" title="Files panel (⌘O / ⌘0)" data-i18n-title="app.filesToggle" aria-label="Files panel (⌘O / ⌘0)" data-i18n-aria-label="app.filesToggle" aria-pressed="false">${icons.folder}</button></header>
<main><nav id="rail" aria-label="Sidebar" data-i18n-aria-label="app.sidebar">
<button id="rail-workspace" class="rail-btn" title="Workspace (⌘⇧B)" data-i18n-title="app.workspaceShortcut" aria-label="Workspace (⌘⇧B)" data-i18n-aria-label="app.workspaceShortcut">${icons.workspace}<span id="rail-exited" hidden></span></button>
<button id="rail-favorites" class="rail-btn" title="Favorites" data-i18n-title="app.favorites" aria-label="Favorites" data-i18n-aria-label="app.favorites">${icons.star}</button>
<button id="rail-snippets" class="rail-btn" title="Snippets (⌘⇧P)" data-i18n-title="app.snippetsShortcut" aria-label="Snippets (⌘⇧P)" data-i18n-aria-label="app.snippetsShortcut">${icons.snippet}</button>
<button id="rail-attention" class="rail-btn" title="Needs attention" data-i18n-title="app.attention" aria-label="Needs attention" data-i18n-aria-label="app.attention">${icons.bell}<span id="rail-alert" hidden></span></button>
<span class="rail-spacer"></span><button id="rail-settings" class="rail-btn" title="Settings" data-i18n-title="app.settings" aria-label="Settings" data-i18n-aria-label="app.settings">${icons.settings}</button></nav>
<section id="drawer-primary" aria-label="Sidebar panel" data-i18n-aria-label="app.sidebarPanel"><div class="drawer-inner">
<section id="panel-workspace" class="panel-content"><div class="drawer-heading"><strong data-i18n="app.workspace">Workspace</strong><button id="new" class="icon-btn" title="New tab" data-i18n-title="app.newTab" aria-label="New tab" data-i18n-aria-label="app.newTab">${icons.plus}</button></div><div id="tabs" role="tree" aria-label="Workspace" data-i18n-aria-label="app.workspace"></div></section>
<section id="panel-favorites" class="panel-content"><div class="drawer-heading"><strong data-i18n="app.favorites">Favorites</strong><button id="favorite-add" class="icon-btn" title="New favorite" data-i18n-title="app.addFavorite" aria-label="New favorite" data-i18n-aria-label="app.addFavorite">${icons.plus}</button><button id="favorite-group-add" class="icon-btn" title="New group" data-i18n-title="app.addGroup" aria-label="New group" data-i18n-aria-label="app.addGroup">${icons.folderPlus}</button></div><div id="favorite-add-options" class="inline-actions" hidden><button id="favorite-current-tab" class="ghost-btn wide-button"></button><button id="favorite-from-dir" class="ghost-btn wide-button" data-i18n="app.favoriteFromDir">Create favorite from folder…</button></div><div id="favorites"></div></section>
<section id="panel-snippets" class="panel-content"><div class="drawer-heading"><strong data-i18n="app.snippets">Snippets</strong><button id="snippet-add" class="icon-btn" title="New snippet" data-i18n-title="app.addSnippet" aria-label="New snippet" data-i18n-aria-label="app.addSnippet">${icons.plus}</button></div><div id="snippet-list"></div></section>
<section id="panel-settings" class="panel-content"><div class="drawer-heading"><strong data-i18n="app.settings">Settings</strong></div><div class="settings-content"><h4>Ghostty</h4><p id="config-summary"></p><p id="config-path"></p><div class="button-row"><button id="open-config" class="ghost-btn" data-i18n="settings.openConfig">Open config file</button><button id="reload-config" class="ghost-btn" data-i18n="settings.reload">Reload</button></div><h4 data-i18n="settings.window">Window</h4><p class="help" data-i18n="settings.windowHelp">Where the main window appears when the app opens. The size is always restored from last time.</p><select id="window-placement"><option value="center" data-i18n="settings.placementCenter">Center on screen</option><option value="remember" data-i18n="settings.placementRemember">Remember last position</option></select><h4 data-i18n="settings.rules">Prompt detection rules</h4><p class="help" data-i18n="settings.rulesHelp">When an agent in a background tab stops to ask you something, the screen is recognized by these rules and you are notified. The rules file can add, replace or disable built-in rules.</p><p id="rules-summary"></p><div class="button-row"><button id="open-rules" class="ghost-btn" data-i18n="settings.openRules">Open rules file</button><button id="reload-rules" class="ghost-btn" data-i18n="settings.reload">Reload</button></div><h4 data-i18n="settings.control">Agent control commands</h4><p class="help" data-i18n="settings.controlHelp">Lets agents inside terminals use highostty ctl to read other tabs, run in the background, and more. Read-only: view only. Full: can also open tabs and send input. Only newly opened tabs get the related environment variables.</p><select id="control-mode"><option value="off" data-i18n="settings.controlOff">Off</option><option value="readonly" data-i18n="settings.controlReadonly">Read-only</option><option value="full" data-i18n="settings.controlFull">Full</option></select><p class="help" data-i18n="settings.skillHelp">The skill teaches an agent how to use these commands. Nothing is written until you press a button: it goes into each agent's skills folder (skills/highostty/SKILL.md under ~/.claude, ~/.codex, ~/.copilot, ~/.gemini) and can be removed at any time. For other agents, copy the content into their global instructions.</p><div id="skill-list"></div><p id="skill-status"></p><div class="button-row"><button id="copy-skill" class="ghost-btn" data-i18n="settings.copySkill">Copy skill content</button></div><h4 data-i18n="settings.diagnostics">Diagnostics</h4><pre id="config-diagnostics"></pre><h4 data-i18n="settings.shortcuts">Shortcuts</h4><div class="shortcut-list"><kbd>⌘1～⌘9</kbd><span data-i18n="settings.sc.switchTab">Switch tabs</span><kbd>⌘⇧B</kbd><span data-i18n="settings.sc.sidebar">Toggle sidebar</span><kbd>⌘⇧P</kbd><span data-i18n="settings.sc.snippets">Snippets palette</span><kbd>⌘O / ⌘0</kbd><span data-i18n="settings.sc.files">Files panel</span><kbd>⇧⌘F</kbd><span data-i18n="settings.sc.filesFull">Files panel full screen</span><kbd>⌘T</kbd><span data-i18n="settings.sc.newTab">New tab</span><kbd>⌘⇧T</kbd><span data-i18n="settings.sc.childTab">Another tab in the same folder (child tab)</span><kbd>⌘D / ⌘⇧D</kbd><span data-i18n="settings.sc.split">Split</span></div></div></section>
</div></section><div id="drawer-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" data-i18n-aria-label="app.resizeSidebar" hidden></div><section id="drawer-detail" aria-label="Details" data-i18n-aria-label="app.detail"><div class="drawer-inner"></div></section><div id="detail-resizer" role="separator" aria-orientation="vertical" aria-label="Resize editor" data-i18n-aria-label="app.resizeDetail" hidden></div>
<section id="workspace"><div id="terminals" aria-label="Native Ghostty workspace" data-i18n-aria-label="app.terminalsLabel"></div><div id="files-resizer" role="separator" aria-orientation="vertical" aria-label="Resize files panel" data-i18n-aria-label="app.resizeFiles" hidden></div><section id="files" aria-label="Files" data-i18n-aria-label="app.files" hidden></section><div id="empty" hidden><p data-i18n="app.emptyHint">Choose a folder to get started.</p><button id="first" data-i18n="app.chooseFolder">Choose folder…</button></div></section></main>
<footer><span id="app-version" title="HiGhostty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 9-9 9-9-9z"/><path d="M12 8l4 4-4 4-4-4z"/></svg><span id="app-version-text"></span></span><span id="search-status"></span></footer>
<dialog id="confirm"><h3 data-i18n="app.confirmTitle">Close terminal?</h3><p data-i18n="app.confirmBody">These jobs are still running. Confirming will terminate them.</p><pre id="processes"></pre><div class="actions"><button id="cancel-close" data-i18n="app.cancel">Cancel</button><button id="force-close" class="danger" data-i18n="app.forceClose">Terminate and close</button></div></dialog>
<dialog id="palette"><h3 id="palette-title" data-i18n="app.paletteTitle">Commands</h3><div id="palette-items"></div><div class="actions"><button id="close-palette" data-i18n="app.close">Close</button></div></dialog>
<div id="search" hidden><input id="search-input" aria-label="Search terminal" data-i18n-aria-label="app.searchTerminal"><button id="search-prev">↑</button><button id="search-next">↓</button><button id="search-close">×</button></div><div id="notice" role="alert"></div>`;
getVersion().then((v) => { document.getElementById("app-version-text")!.textContent = `v${v}`; }).catch(() => {});
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
// The full-screen files panel covers the terminals; a terminal must not take the keyboard under it.
const terminalHidden = () => filesPanel.isFull();
const native = <T = Record<string, unknown>>(
  request: Record<string, unknown>,
) => invoke<T>("native", { request });
const filesPanel = initFilesPanel({
  native,
  activeTab: () => active,
  cwd: () => currentSurface()?.cwd,
  home: () => homePath,
  displayPath,
  openTerminal: async (path) => { await newSurface(path); },
  previewFile: (path) => { if (active) showPreview(active, path); },
  followPreview: (path) => { if (active?.preview && active.preview.path !== path) showPreview(active, path); },
  editInTerminal: async (directory, command) => {
    if (active) await newSurface(directory, active.focused, 0, { command, commandInShell: true });
  },
  insertIntoTerminal: async (text) => {
    if (!active) return;
    await native({ op: "insert-text", id: active.focused, text });
    if (!terminalHidden()) await native({ op: "focus", id: active.focused });
  },
  focusTerminal: () => { if (active && !terminalHidden()) native({ op: "focus", id: active.focused }).catch(notify); },
  layoutChanged: scheduleLayout,
  visibilityChanged: (tab) => rememberFilesState(tab as Tab),
  notify,
  popOut: () => { if (active) popOutFiles(active).catch(notify); },
  focusDetached: () => { if (active) openFilesWindow(active, true).catch(notify); },
  detachedCwd: (cwd) => { if (active) emitTo(filesWindowLabel(active), "files-cwd", { cwd }).catch(() => {}); },
  icons,
});
// ---- Files panel in its own window (files-window.ts) ----
const filesWindowLabel = (tab: Tab) => `preview-files-${tab.id}`;
function filesWindowSize(): [number, number] | null {
  try {
    const saved = JSON.parse(localStorage.getItem("files-window-size") || "null");
    return saved && Number(saved.width) > 0 && Number(saved.height) > 0 ? [Number(saved.width), Number(saved.height)] : null;
  } catch { return null; }
}
async function openFilesWindow(tab: Tab, focus: boolean) {
  const files = tab.files;
  if (!files) return;
  await invoke("open_files_window", {
    tab: tab.id, title: tabName(tab), focus, size: filesWindowSize(),
    init: { tab: tab.id, origin: win.label, cwd: surfaces.get(tab.focused)?.cwd, home: homePath, files: { ...files, open: true, detached: undefined } },
  });
}
async function popOutFiles(tab: Tab) {
  const files = tab.files;
  if (!files?.open || files.detached) return;
  tab.files = setDetached(files, true);
  filesPanel.invalidate(); scheduleLayout(); rememberFilesState(tab);
  try { await openFilesWindow(tab, true); }
  catch (error) { tab.files = files; filesPanel.invalidate(); scheduleLayout(); rememberFilesState(tab); throw error; }
}
// The window sent its panel back (or was closed): the tab shows it again, or keeps it closed.
function dockFiles(tab: Tab, files: FilesState | undefined, close: boolean) {
  if (!tab.files?.detached) return;
  const base = { ...(files ?? tab.files), detached: undefined };
  tab.files = close ? toggleOpen({ ...base, open: true }) : { ...base, open: true, full: false };
  filesPanel.invalidate(); scheduleLayout(); rememberFilesState(tab);
}
const previewPanel = initPreviewPanel({
  activeTab: () => active,
  area: () => $("terminals").getBoundingClientRect(),
  layoutChanged: scheduleLayout,
  toggleSide: () => togglePreview(),
  close: () => closePreview(),
  reveal: (path) => { native({ op: "files-reveal", paths: [path] }).catch(notify); },
  popOut: (path) => {
    const tab = active;
    invoke("open_preview_window", { path, focus: true, origin: { window: win.label, tab: tab?.id } })
      .then(() => { if (tab?.preview) { delete tab.preview; scheduleLayout(); } })
      .catch(notify);
  },
  notify,
});
function showPreview(tab: Tab, path: string, side?: PreviewSide) {
  tab.preview = tab.preview
    ? { ...tab.preview, path, side: side ?? tab.preview.side }
    : openPreview(path, side);
  scheduleLayout();
}
function togglePreview() {
  if (active?.preview) { active.preview = togglePreviewSide(active.preview); scheduleLayout(); }
}
function closePreview(tab = active) {
  if (!tab?.preview) return;
  delete tab.preview;
  scheduleLayout();
  if (tab === active && !terminalHidden()) native({ op: "focus", id: tab.focused }).catch(notify);
}
const snippets = initSnippets({
  native,
  cwd: () => currentSurface()?.cwd,
  home: () => homePath,
  insertIntoTerminal: async (text) => {
    if (!active) return;
    await native({ op: "insert-text", id: active.focused, text });
    await native({ op: "focus", id: active.focused });
  },
  focusTerminal: () => { if (active && !terminalHidden()) native({ op: "focus", id: active.focused }).catch(notify); },
  editInDrawer: (snippetId, scope, text) => {
    if (!drawerState.panel) setPanel("snippets");
    showRootDetail({ kind: "edit-snippet", snippetId, scope, text });
  },
  notify,
  canInsert: () => !!active && !terminalHidden(),
});
// 與 snippets 共用單一 overlay-cutout，兩個浮層不可同時開著。
const attentionDrop = initAttentionDrop({
  native,
  focusTerminal: () => { if (active && !terminalHidden()) native({ op: "focus", id: active.focused }).catch(notify); },
  notify,
  render: () => renderAttention(),
  clearAll: () => setAttention(emptyAttention),
  closeIcon: icons.close,
});
function toggleAttention() {
  if (attentionDrop.isOpen()) { attentionDrop.close(); return; }
  snippets.close(false);
  lastAttentionSig = undefined;
  attentionDrop.open().catch(notify);
}
let tabs: Tab[] = [],
  active: Tab | undefined,
  surfaces = new Map<string, Surface>(),
  favorites: WorkspaceFavorite[] = [],
  favoritesRevision = 0,
  recentFavoriteInstances = new Map<string, string>(),
  folders: FavoriteFolder[] = [],
  editing: string | undefined;
let drawerState: DrawerState = { panel: null, lastPanel: "workspace", detailStack: [] };
let focusEditorOnRender = false;
let renderedDetail: Detail | undefined;
let homePath = "";
let collapsedWorkspaceGroups = new Set<string>(),
  restoring = false;
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
function rootOf(tab: Tab) {
  return (tab.parentId && tabs.find((item) => item.id === tab.parentId)) || tab;
}
function childrenOf(tab: Tab) {
  return tabs.filter((item) => item.parentId === tab.id);
}
function favoriteFor(tab: Tab) {
  tab = rootOf(tab);
  return tab.favoriteId ? favorites.find((item) => item.id === tab.favoriteId) : undefined;
}
// The favorite this very tab was opened from (sub-tabs have none).
function favoriteOf(tab: Tab) {
  return tab.favoriteId ? favorites.find((item) => item.id === tab.favoriteId) : undefined;
}
function tabName(tab: Tab) {
  return displayName(favoriteOf(tab)?.name, tab.title, name(surfaces.get(tab.focused)?.cwd || "/"));
}
function tabFolder(tab: Tab) {
  const id = favoriteFor(tab)?.groupId;
  return id ? folders.find((folder) => folder.id === id) : undefined;
}
// Screen order: ungrouped tabs first, then tabs grouped by their favorite's group.
function orderedTabs(): Tab[] {
  const roots = orderTabsByFavorites(tabs.filter((tab) => rootOf(tab) === tab), favorites, folders.map((folder) => folder.id));
  return orderWithChildren([...roots, ...tabs.filter((tab) => rootOf(tab) !== tab)]);
}
function folderFavorites(folderId?: string) {
  return favorites.filter((item) => item.groupId === folderId);
}
function dialogsOpen() {
  return !!document.querySelector("dialog[open]");
}
function startProgram(command: string | undefined) {
  const words = (command ?? "").trim().split(/\s+/).filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  return words[0];
}
function detail(): Detail | undefined { return drawerState.detailStack.at(-1); }
type WidthSpec = { key: string; css: string; min: number; max: number; def: number; value: number };
const loadWidth = (spec: WidthSpec) => { try { const saved = Number(localStorage.getItem(spec.key)); if (saved) spec.value = Math.min(spec.max, Math.max(spec.min, Math.round(saved))); } catch {} return spec; };
const drawerSpec = loadWidth({ key: "drawer-width", css: "--drawer-width", min: 220, max: 520, def: 272, value: 272 });
// The second drawer holds the editors, so it is wider and its width is remembered separately.
const detailSpec = loadWidth({ key: "detail-width", css: "--detail-width", min: 300, max: 760, def: 380, value: 380 });
const clampWidth = (spec: WidthSpec, value: number) => Math.min(spec.max, Math.max(spec.min, Math.round(value)));
const applyWidth = (spec: WidthSpec) => document.documentElement.style.setProperty(spec.css, `${spec.value}px`);
function rememberDrawerOpen() { try { localStorage.setItem("drawer-open", String(!!drawerState.panel)); } catch {} }
function wireWidthResizer(handle: HTMLElement, drawer: HTMLElement, spec: WidthSpec) {
  handle.onpointerdown = (event) => {
    event.preventDefault();
    const startX = event.clientX, startWidth = spec.value;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    drawer.classList.add("resizing");
    handle.onpointermove = (move) => { spec.value = clampWidth(spec, startWidth + move.clientX - startX); drawer.style.width = `${spec.value}px`; applyWidth(spec); };
    const stop = () => {
      handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
      handle.classList.remove("dragging"); drawer.classList.remove("resizing");
      try { localStorage.setItem(spec.key, String(spec.value)); } catch {}
      scheduleLayout();
    };
    handle.onpointerup = handle.onpointercancel = stop;
  };
  handle.ondblclick = () => { spec.value = spec.def; try { localStorage.setItem(spec.key, String(spec.value)); } catch {} renderDrawer(); };
}
function wireDrawerResizer() {
  wireWidthResizer($("drawer-resizer"), $("drawer-primary"), drawerSpec);
  wireWidthResizer($("detail-resizer"), $("drawer-detail"), detailSpec);
}
// An editor with unsaved input; set by editorFooter, cleared whenever the detail is rebuilt.
let editorDirty: (() => boolean) | undefined;
function discardChoice(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
    popupMenu([
      { text: t("app.unsavedDiscard"), action: () => done(true) },
      { text: t("app.unsavedKeep"), action: () => done(false) },
    ]).finally(() => setTimeout(() => done(false), 200));
  });
}
// Leaving an editor with unsaved input asks first; otherwise just goes.
function afterLeavingEditor(go: () => void) {
  if (!detail()?.kind.startsWith("edit-") || !editorDirty?.()) { go(); return; }
  discardChoice().then((ok) => { if (ok) go(); }).catch(notify);
}
function renderDrawer() {
  const primary = $("drawer-primary"), secondary = $("drawer-detail");
  const panel = drawerState.panel;
  primary.style.width = panel ? `${drawerSpec.value}px` : "0px";
  applyWidth(drawerSpec); applyWidth(detailSpec);
  secondary.style.width = detail() ? `${detailSpec.value}px` : "0px";
  primary.dataset.open = String(!!panel);
  secondary.dataset.open = String(!!detail());
  for (const item of ["workspace", "favorites", "snippets", "settings"] as Panel[]) {
    $("panel-" + item).hidden = panel !== item;
    $("rail-" + item).classList.toggle("active", panel === item);
    $("rail-" + item).setAttribute("aria-pressed", String(panel === item));
  }
  if (window.innerWidth < 760 && detail()) primary.classList.add("compact-hidden");
  else primary.classList.remove("compact-hidden");
  $("drawer-resizer").hidden = !panel || primary.classList.contains("compact-hidden");
  $("detail-resizer").hidden = !detail();
  // Only rebuild the second drawer when its content changed, so resizing or
  // reopening panels never wipes an editor's unsaved input.
  if (renderedDetail !== detail()) renderDetail();
  refreshSnippetList();
  renderAttention();
  syncSelection();
  scheduleLayout();
}
// A snippet changed elsewhere: rebuild the editor only when it shows a vanished snippet.
function renderDetailIfSnippet() {
  const top = detail();
  if (top?.kind === "edit-snippet" && top.snippetId && !snippets.store.get(top.snippetId)) backDetail();
}
function refreshSnippetList() {
  if (drawerState.panel !== "snippets") return;
  // Rebuilding would drop the search box's focus while typing.
  if (document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains("snippet-search")) return;
  const top = detail();
  snippets.renderList($("snippet-list"), top?.kind === "edit-snippet" ? top.snippetId : undefined);
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
function setPanel(panel: Panel) { drawerState = openPanel(drawerState, panel); localStorage.setItem("drawer-panel", panel); rememberDrawerOpen(); renderDrawer(); }
function toggleDrawerPanel(panel: Panel) { drawerState = togglePanel(drawerState, panel); if (drawerState.panel) localStorage.setItem("drawer-panel", drawerState.panel); rememberDrawerOpen(); renderDrawer(); if (!drawerState.panel && active) native({ op: "focus", id: active.focused }).catch(notify); }
function closeDrawers() { drawerState = closeAll(drawerState); rememberDrawerOpen(); renderDrawer(); if (active) native({ op: "focus", id: active.focused }).catch(notify); }
// An editor opened from another editor's page (new group from a favorite) keeps it underneath
// with `nested`; otherwise opening a different editor replaces the current one.
function showDetail(value: Detail, replace = false, nested = false) {
  afterLeavingEditor(() => {
    const swap = replace || (!nested && value.kind.startsWith("edit-") && !!detail()?.kind.startsWith("edit-"));
    drawerState = swap ? replaceDetail(drawerState, value) : pushDetail(drawerState, value);
    focusEditorOnRender = value.kind.startsWith("edit-"); renderDrawer();
  });
}
function showRootDetail(value: Detail) { afterLeavingEditor(() => { drawerState = { ...drawerState, detailStack: [value] }; focusEditorOnRender = value.kind.startsWith("edit-"); renderDrawer(); }); }
function backDetail() {
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
  editorDirty = undefined;
  host.ondragover = host.ondragleave = host.ondrop = null;
  host.classList.remove("drop-target-list");
  if (!current) return;
  const isEditor = current.kind.startsWith("edit-");
  const heading = document.createElement("div"); heading.className = "drawer-heading detail-heading";
  const back = button(isEditor ? t("app.back") : "", backDetail, t("app.backUp"));
  back.className = isEditor ? "ghost-btn back-btn" : "icon-btn";
  back.insertAdjacentHTML("afterbegin", icons.back);
  heading.append(back);
  const enterSaves = (save: HTMLButtonElement, ...inputs: (HTMLInputElement | undefined)[]) => {
    for (const input of inputs) if (input) input.onkeydown = (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); if (!save.disabled) save.click(); } };
  };
  if (current.kind === "group") {
    const folder = folders.find((item) => item.id === current.groupId);
    if (!folder) { backDetail(); return; }
    const items = folderFavorites(folder.id);
    const dot = document.createElement("span"); dot.className = "group-dot"; dot.style.background = folder.color;
    const title = document.createElement("strong"); title.textContent = folder.name;
    const count = document.createElement("span"); count.className = "badge"; count.textContent = String(items.length);
    const edit = button("", () => editFolder(folder), t("app.editGroup")); edit.className = "icon-btn"; edit.innerHTML = icons.pencil;
    heading.append(dot, title, count, edit);
    host.append(heading);
    if (items.length) { const openAll = button(t("app.openAll"), () => openFolder(folder).then(closeAfterOpen), t("app.openAllTitle")); openAll.className = "primary-btn wide-button group-open-all"; host.append(openAll); }
    for (const item of items) appendFavoriteRow(host, item);
    if (!items.length) host.append(help(t("app.groupEmpty")));
    if (active) { const add = button(t("app.favoriteTabToGroup"), () => newFavorite({ tabId: active!.id, groupId: folder.id })); add.className = "ghost-btn wide-button"; host.append(add); }
  } else if (current.kind === "edit-tab") {
    const tab = tabs.find((item) => item.id === current.tabId);
    if (!tab) { backDetail(); return; }
    // Linked tabs have no fields of their own: everything lives in the favorite.
    const linked = favoriteOf(tab);
    if (linked) { drawerState = replaceDetail(drawerState, { kind: "edit-favorite", favoriteId: linked.id }); renderDetail(); return; }
    const cwd = surfaces.get(tab.focused)?.cwd || "/";
    const folder = tabFolder(tab);
    const objectName = editorIntro(host, heading, t("app.editTab"), tabName(tab), cwd);
    if (folder) { const dot = document.createElement("span"); dot.className = "group-dot"; dot.style.background = folder.color; objectName.before(dot); }
    host.append(formCaption(t("app.cap.basic")));
    const title = document.createElement("input"); title.id = "rename-value"; title.value = tab.title || ""; title.placeholder = name(cwd); title.setAttribute("aria-label", t("app.name"));
    host.append(labeled(t("app.name"), title), help(t("app.nameHelp")));
    host.append(formCaption(t("app.cap.launch")));
    const command = document.createElement("input"); command.id = "tab-command-value"; command.className = "mono"; command.value = tab.command || ""; command.placeholder = t("app.shellPlaceholder"); command.setAttribute("aria-label", t("app.launchCommand"));
    const commandField = labeled(t("app.launchCommand"), command);
    host.append(launchPicker(command, commandField), commandField, help(t("app.tabCommandHelp")));
    const commandInShell = document.createElement("input"); commandInShell.type = "checkbox"; commandInShell.checked = !!tab.commandInShell; commandInShell.disabled = !command.value.trim();
    const commandInShellLabel = document.createElement("label"); commandInShellLabel.className = "toggle"; commandInShellLabel.append(commandInShell, document.createTextNode(t("app.loadShell")));
    host.append(commandInShellLabel, help(t("app.loadShellHelp")));
    host.append(formCaption(t("app.cap.background")));
    const tmuxBox = document.createElement("input"); tmuxBox.type = "checkbox"; tmuxBox.checked = !!tab.tmux;
    const tmuxLabel = document.createElement("label"); tmuxLabel.className = "toggle"; tmuxLabel.append(tmuxBox, document.createTextNode(t("app.useTmux")));
    host.append(tmuxLabel, help(t("app.tmuxHelpTab")));
    const tmuxStatus = document.createElement("input"); tmuxStatus.type = "checkbox"; tmuxStatus.checked = !!tab.tmuxHideStatus; tmuxStatus.disabled = !tmuxBox.checked;
    const tmuxStatusLabel = document.createElement("label"); tmuxStatusLabel.className = "toggle"; tmuxStatusLabel.append(tmuxStatus, document.createTextNode(t("app.hideTmuxStatus")));
    host.append(tmuxStatusLabel, help(t("app.hideTmuxStatusHelpTab")));
    host.append(formCaption(t("app.cap.content")));
    for (const [index, id] of leaves(tab.tree).entries()) host.append(summaryItem(t(index === 0 ? "app.splitPrimary" : "app.splitLabel", { index: index + 1 }), surfaces.get(id)?.cwd || ""));
    const apply = () => { tab.title = title.value.trim() || undefined; tab.command = command.value.trim() || undefined; tab.commandInShell = tab.command ? commandInShell.checked : undefined; tab.tmux = tmuxBox.checked || undefined; tab.tmuxHideStatus = tab.tmux && tmuxStatus.checked || undefined; for (const id of leaves(tab.tree)) { const session = surfaces.get(id)?.tmuxSession; if (session && original.tmuxHideStatus !== !!tab.tmuxHideStatus) invoke("tmux_set_status", { name: session, visible: !tab.tmuxHideStatus }).catch(() => {}); } original.tmuxHideStatus = !!tab.tmuxHideStatus; };
    host.append(formCaption(t("app.favorites")));
    host.append(help(t("app.favoriteTabHelp")));
    const saveFav = button(t("app.favoriteThisTab"), () => { apply(); newFavorite({ tabId: tab.id }); }); saveFav.className = "primary-btn wide-button"; host.append(saveFav);
    host.append(formCaption(t("app.cap.danger")));
    const close = button(t("app.closeTab"), () => requestClose(leaves(tab.tree), (force) => closeTab(tab, force))); close.className = "danger-btn wide-button"; host.append(close);
    const original = { title: tab.title || "", command: tab.command || "", commandInShell: !!tab.commandInShell, tmux: !!tab.tmux, tmuxHideStatus: !!tab.tmuxHideStatus };
    const save = button(t("app.save"), () => { apply(); renderTabs(); backDetail(); });
    editorFooter(host, save);
    const updateDirty = () => { save.disabled = title.value === original.title && command.value === original.command && commandInShell.checked === original.commandInShell && tmuxBox.checked === original.tmux && tmuxStatus.checked === original.tmuxHideStatus; };
    title.oninput = () => { objectName.textContent = title.value.trim() || name(cwd); updateDirty(); };
    command.oninput = () => { commandInShell.disabled = !command.value.trim(); if (commandInShell.disabled) commandInShell.checked = false; updateDirty(); };
    commandInShell.onchange = updateDirty;
    tmuxBox.onchange = () => { tmuxStatus.disabled = !tmuxBox.checked; updateDirty(); };
    tmuxStatus.onchange = updateDirty;
    enterSaves(save, title, command);
    updateDirty();
    if (shouldFocusEditor) requestAnimationFrame(() => { title.focus(); title.select(); });
  } else if (current.kind === "edit-group") {
    const folder = current.groupId ? folders.find((item) => item.id === current.groupId) : undefined;
    if (current.groupId && !folder) { backDetail(); return; }
    const defaultName = t("app.defaultGroupName", { index: folders.length + 1 });
    const items = folder ? folderFavorites(folder.id) : [];
    const objectName = editorIntro(host, heading, folder ? t("app.editGroup") : t("app.addGroup"), folder?.name || defaultName, folder ? t("app.favoriteCount", { n: items.length }) : t("app.groupSubtitleNew"));
    host.append(formCaption(t("app.cap.basic")));
    const input = document.createElement("input"); input.id = "group-name"; input.value = folder?.name || defaultName; input.setAttribute("aria-label", t("app.groupName")); host.append(labeled(t("app.name"), input));
    const color = document.createElement("input"); color.id = "group-color"; color.type = "color"; color.value = folder?.color || "#77dfc0"; color.className = "color-input"; color.tabIndex = -1; color.setAttribute("aria-hidden", "true");
    const dotPreview = document.createElement("span"); dotPreview.className = "group-dot"; dotPreview.style.background = color.value; objectName.before(dotPreview);
    const palette = document.createElement("div"); palette.className = "color-swatches";
    const markChosen = () => palette.querySelectorAll<HTMLButtonElement>(".color-swatch").forEach((item) => item.classList.toggle("chosen", item.dataset.color ? item.dataset.color === color.value : !swatchColors.includes(color.value)));
    for (const value of swatchColors) { const swatch = button("", () => { color.value = value; color.dispatchEvent(new Event("input")); }, value); swatch.className = "color-swatch"; swatch.dataset.color = value; swatch.style.background = value; palette.append(swatch); }
    const custom = button("", () => { color.focus(); color.click(); }, t("app.customColor")); custom.className = "color-swatch custom-color"; palette.append(custom, color);
    markChosen();
    host.append(labeled(t("app.color"), palette, "div"), help(t("app.groupColorHelp")));
    if (folder) {
      host.append(formCaption(t("app.cap.content")));
      for (const item of items) host.append(savedTabSummary(item.tab, item.name));
      if (!items.length) host.append(help(t("app.groupNoFavorites")));
      if (items.length) { host.append(formCaption(t("app.open"))); const openAll = button(t("app.openAll"), () => openFolder(folder).then(closeAfterOpen)); openAll.className = "ghost-btn wide-button"; host.append(openAll); }
      host.append(formCaption(t("app.cap.danger")), help(t("app.deleteGroupHelp")));
      const remove = button(t("app.deleteGroup"), () => { if (confirmTwice(remove)) return deleteFolder(folder); }); remove.className = "danger-btn wide-button"; host.append(remove);
    }
    const original = { name: input.value, color: color.value };
    const save = button(t("app.save"), () => saveFolder(folder, input.value.trim() || folder?.name || defaultName, color.value));
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
    const defaultPath = item ? item.tab.paths[0] || "" : sourceTab ? sourcePath : currentSurface()?.cwd || homePath;
    const defaultName = item?.name || (sourceTab ? sourceTab.title || name(sourcePath) : name(defaultPath || "/"));
    const objectName = editorIntro(host, heading, item ? t("app.editFavorite") : sourceTab ? t("app.favoriteTab") : t("app.addFavorite"), draft.name || defaultName, item ? t("app.tabFavorite") : sourceTab ? t("app.favoriteTabSubtitle") : t("app.favoriteFromDirSubtitle"));
    host.append(formCaption(t("app.cap.basic")));
    const alias = document.createElement("input"); alias.id = "alias"; alias.value = draft.name ?? defaultName; alias.setAttribute("aria-label", t("app.name")); host.append(labeled(t("app.name"), alias));
    const groupSelect = document.createElement("select"); groupSelect.id = "favorite-group";
    groupSelect.add(new Option(t("app.ungrouped"), "")); for (const folder of folders) groupSelect.add(new Option(folder.name, folder.id)); groupSelect.add(new Option(t("app.newGroupOption"), "__new__"));
    groupSelect.value = draft.groupId ?? item?.groupId ?? current.groupId ?? "";
    host.append(labeled(t("app.group"), groupSelect));
    const savedCommand = item?.tab.command ?? sourceTab?.command ?? "";
    const command = document.createElement("input"); command.id = "favorite-command"; command.className = "mono"; command.value = draft.command ?? savedCommand; command.placeholder = t("app.shellPlaceholder"); command.setAttribute("aria-label", t("app.launchCommand"));
    const commandField = labeled(t("app.launchCommand"), command);
    host.append(formCaption(t("app.cap.launch")), launchPicker(command, commandField), commandField, help(t("app.favoriteCommandHelp")));
    const commandInShell = document.createElement("input"); commandInShell.type = "checkbox"; commandInShell.checked = draft.commandInShell ?? (item?.tab.commandInShell ?? sourceTab?.commandInShell ?? false); commandInShell.disabled = !command.value.trim();
    const commandInShellLabel = document.createElement("label"); commandInShellLabel.className = "toggle"; commandInShellLabel.append(commandInShell, document.createTextNode(t("app.loadShell")));
    host.append(commandInShellLabel, help(t("app.loadShellHelpNext")));
    host.append(formCaption(t("app.cap.background")));
    const tmuxBox = document.createElement("input"); tmuxBox.type = "checkbox"; tmuxBox.checked = draft.tmux ?? !!(item?.tab.tmux ?? sourceTab?.tmux);
    const tmuxLabel = document.createElement("label"); tmuxLabel.className = "toggle"; tmuxLabel.append(tmuxBox, document.createTextNode(t("app.useTmux")));
    host.append(tmuxLabel, help(t("app.tmuxHelpFavorite")));
    const tmuxStatus = document.createElement("input"); tmuxStatus.type = "checkbox"; tmuxStatus.checked = draft.tmuxHideStatus ?? !!(item?.tab.tmuxHideStatus ?? sourceTab?.tmuxHideStatus); tmuxStatus.disabled = !tmuxBox.checked;
    const tmuxStatusLabel = document.createElement("label"); tmuxStatusLabel.className = "toggle"; tmuxStatusLabel.append(tmuxStatus, document.createTextNode(t("app.hideTmuxStatus")));
    host.append(tmuxStatusLabel, help(t("app.hideTmuxStatusHelpFavorite")));
    let path: HTMLInputElement | undefined;
    if (!sourceTab) {
      host.append(formCaption(t("app.cap.directory")));
      path = document.createElement("input"); path.id = "favorite-path"; path.value = draft.path ?? defaultPath; path.setAttribute("aria-label", t("app.cap.directory"));
      const row = document.createElement("div"); row.className = "field-row";
      const choose = button(t("app.choose"), () => pick("favorite")); choose.className = "ghost-btn";
      row.append(path, choose);
      host.append(labeled(t("app.path"), row));
      if (item) host.append(help(t("app.favoritePathHelp")));
      const error = document.createElement("p"); error.id = "favorite-path-error"; error.className = "field-error"; error.hidden = true; host.append(error);
    }
    const updateSummaryForFavorite = () => {
      if (!(item || sourceTab)) return;
      const count = item?.tab.paths.length ?? leaves(sourceTab!.tree).length;
      const summary = host.querySelector(".summary-detail");
      if (summary) summary.textContent = [item?.tab.paths[0] || sourcePath, count > 1 ? t("app.splitCount", { n: count }) : "", command.value.trim() ? `⌘ ${command.value.trim()}${commandInShell.checked ? t("app.shellSuffix") : ""}` : ""].filter(Boolean).join(" · ");
    };
    if (item || sourceTab) {
      host.append(formCaption(t("app.cap.content")));
      const contentSummary = savedTabSummary(item ? item.tab : savedTab(sourceTab!), item ? undefined : t("app.currentTab"));
      host.append(contentSummary);
    }
    const instance = item ? recentFavoriteInstance(tabs, item.id, recentFavoriteInstances.get(item.id)) : undefined;
    if (item && instance) {
      host.append(formCaption(t("app.cap.currentlyOpen")));
      for (const [index, id] of leaves(instance.tree).entries()) host.append(summaryItem(t(index === 0 ? "app.splitPrimary" : "app.splitLabel", { index: index + 1 }), surfaces.get(id)?.cwd || ""));
      const layout = button(t("app.updateFavoriteLayout"), () => updateFavoriteLayout(instance)); layout.className = "ghost-btn wide-button"; host.append(layout);
      host.append(help(t("app.updateLayoutHelp")));
    }
    if (item) {
      host.append(formCaption(t("app.open")));
      const open = button(t("app.openSwitch"), () => openFavorite(item).then(closeAfterOpen)); open.className = "primary-btn wide-button";
      const openNew = button(t("app.openAnother"), () => openFavorite(item, true).then(closeAfterOpen)); openNew.className = "ghost-btn wide-button";
      host.append(open, openNew);
      host.append(formCaption(t("app.cap.danger")), help(t("app.removeFavoriteHelp")));
      const remove = button(t("app.removeFavorite"), () => { if (confirmTwice(remove)) return removeFavorite(item); }); remove.className = "danger-btn wide-button"; host.append(remove);
    }
    const original = { name: item?.name || "", path: item ? defaultPath : "", groupId: item?.groupId || "", command: item?.tab.command || "", commandInShell: !!item?.tab.commandInShell, tmux: !!item?.tab.tmux, tmuxHideStatus: !!item?.tab.tmuxHideStatus };
    const save = button(item ? t("app.save") : t("app.favorites"), () => saveFavoriteEditor(current, item, sourceTab, alias.value.trim(), groupSelect.value === "__new__" ? "" : groupSelect.value, path, { command: command.value.trim(), commandInShell: commandInShell.checked, tmux: tmuxBox.checked, tmuxHideStatus: tmuxBox.checked && tmuxStatus.checked }));
    editorFooter(host, save);
    const updateDirty = () => { save.disabled = !alias.value.trim() || (!!item && alias.value === original.name && (path?.value ?? "") === original.path && groupSelect.value === original.groupId && command.value.trim() === original.command && commandInShell.checked === original.commandInShell && tmuxBox.checked === original.tmux && (tmuxBox.checked && tmuxStatus.checked) === original.tmuxHideStatus ); };
    alias.oninput = () => { objectName.textContent = alias.value.trim() || defaultName; updateDirty(); };
    path?.addEventListener("input", updateDirty);
    command.addEventListener("input", () => { commandInShell.disabled = !command.value.trim(); if (commandInShell.disabled) commandInShell.checked = false; updateSummaryForFavorite(); updateDirty(); });
    commandInShell.addEventListener("change", () => { updateSummaryForFavorite(); updateDirty(); });
    tmuxBox.addEventListener("change", () => { tmuxStatus.disabled = !tmuxBox.checked; updateDirty(); });
    tmuxStatus.addEventListener("change", updateDirty);
    groupSelect.onchange = () => {
      updateDirty();
      if (groupSelect.value !== "__new__") return;
      // Keep what was typed while the new-group editor is on top.
      editorDrafts.set(current, { name: alias.value, path: path?.value, groupId: item?.groupId || current.groupId || "", command: command.value, commandInShell: commandInShell.checked, tmux: tmuxBox.checked, tmuxHideStatus: tmuxStatus.checked });
      createFolder();
    };
    enterSaves(save, alias, path, command);
    updateDirty();
    if (shouldFocusEditor) requestAnimationFrame(() => { alias.focus(); alias.select(); });
  } else if (current.kind === "edit-snippet") {
    const item = current.snippetId ? snippets.store.get(current.snippetId) : undefined;
    if (current.snippetId && !item) { backDetail(); return; }
    const objectName = editorIntro(host, heading, item ? t("app.editSnippet") : t("app.addSnippet"), item?.name || t("app.newSnippetName"), item ? t("app.snippets") : t("app.snippetSubtitle"));
    const form = snippets.createForm(item, { scope: current.scope, text: current.text });
    host.append(form.element);
    if (item) {
      host.append(formCaption(t("app.cap.danger")));
      const remove = button(t("app.deleteSnippet"), () => { if (confirmTwice(remove)) return snippets.store.remove(item.id).then(backDetail); }); remove.className = "danger-btn wide-button"; host.append(remove);
    }
    const save = button(item ? t("app.save") : t("app.add"), async () => { await snippets.store.save(await form.read(), item?.id); backDetail(); });
    editorFooter(host, save);
    const update = () => { save.disabled = !form.valid() || !form.dirty(); };
    form.onChange(update);
    update();
    if (shouldFocusEditor) requestAnimationFrame(() => form.focus());
  } else if (current.kind === "edit-locale") {
    editorIntro(host, heading, t(current.code ? "language.editor.titleEdit" : "language.editor.titleNew"), current.code ?? "", "");
    renderLocaleEditor(host, current.code, { back: backDetail, notify });
  }
}
// Which AI tools are installed, looked up through the login shell (the app's own PATH is minimal).
const toolInstalled = new Map<string, boolean>();
let toolsDetected: Promise<void> | undefined;
function detectTools() {
  toolsDetected ??= Promise.all(AI_TOOLS.map(async (tool) => { toolInstalled.set(tool.id, !!(await invoke<string | null>("program_path", { name: tool.program }).catch(() => null))); })).then(() => {});
  return toolsDetected;
}
// Tool / model / extra-arguments picker above the launch command. The command input stays the
// single source of truth: the picker writes it and fires `input`, so dirty tracking is unchanged.
function launchPicker(command: HTMLInputElement, commandField: HTMLElement): HTMLElement {
  const box = document.createElement("div");
  let launch: Launch | undefined = parseLaunch(command.value);
  const toolSelect = document.createElement("select"); toolSelect.id = "launch-tool"; toolSelect.setAttribute("aria-label", t("app.launchTool"));
  const modelSelect = document.createElement("select"); modelSelect.id = "launch-model"; modelSelect.setAttribute("aria-label", t("app.launchModel"));
  const modelOther = document.createElement("input"); modelOther.className = "mono"; modelOther.placeholder = t("app.launchModelName"); modelOther.setAttribute("aria-label", t("app.launchModelName"));
  const extra = document.createElement("input"); extra.id = "launch-extra"; extra.className = "mono"; extra.placeholder = t("app.launchExtraPlaceholder"); extra.setAttribute("aria-label", t("app.launchExtra"));
  const preview = document.createElement("div"); preview.className = "launch-preview mono";
  const progInput = document.createElement("input"); progInput.id = "launch-program"; progInput.className = "mono"; progInput.placeholder = t("app.shellPlaceholder"); progInput.setAttribute("aria-label", t("app.launchCommand"));
  let custom = splitCommand(command.value);
  progInput.value = custom.program;
  const progField = labeled(t("app.launchCommand"), progInput);
  const toolField = labeled(t("app.launchTool"), toolSelect), modelField = labeled(t("app.launchModel"), modelSelect), extraField = labeled(t("app.launchExtra"), extra);
  const option = (select: HTMLSelectElement, value: string, text: string) => { const item = document.createElement("option"); item.value = value; item.textContent = text; select.append(item); };
  const fillTools = () => {
    toolSelect.replaceChildren();
    option(toolSelect, "", t("app.launchCustom"));
    for (const tool of AI_TOOLS) {
      const installed = toolInstalled.get(tool.id);
      if (installed || launch?.tool.id === tool.id) option(toolSelect, tool.id, installed ? tool.label : `${tool.label} ${t("app.launchNotInstalled")}`);
    }
    toolSelect.value = launch?.tool.id ?? "";
  };
  const fillModels = () => {
    modelSelect.replaceChildren();
    modelOther.hidden = true;
    if (!launch) return;
    option(modelSelect, "", t("app.launchModelDefault"));
    for (const model of launch.tool.models) option(modelSelect, model, model);
    option(modelSelect, "__other__", t("app.launchModelOther"));
    const custom = !!launch.model && !launch.tool.models.includes(launch.model);
    modelSelect.value = custom ? "__other__" : launch.model;
    modelOther.hidden = !custom;
    modelOther.value = custom ? launch.model : "";
  };
  const show = () => {
    const ai = !!launch;
    modelField.hidden = preview.hidden = !ai;
    progField.hidden = ai;
    if (!ai) modelOther.hidden = true;
    // The command is edited as program + arguments; the real input only holds the joined text.
    commandField.hidden = true;
    extra.value = launch ? launch.extra : custom.args;
    if (launch) preview.textContent = command.value;
  };
  const write = () => {
    command.value = launch ? composeLaunch(launch.tool, launch.model, launch.extra) : joinCommand(custom.program, custom.args);
    preview.textContent = command.value;
    command.dispatchEvent(new Event("input", { bubbles: true }));
  };
  toolSelect.onchange = () => {
    const tool = AI_TOOLS.find((item) => item.id === toolSelect.value);
    const args = launch?.extra ?? custom.args;
    launch = tool ? { tool, model: "", extra: args } : undefined;
    if (!tool) { custom = { program: command.value.trim() ? splitCommand(command.value).program : "", args }; progInput.value = custom.program; }
    fillModels(); show(); write();
  };
  modelSelect.onchange = () => {
    if (!launch) return;
    if (modelSelect.value === "__other__") { modelOther.hidden = false; modelOther.focus(); launch.model = modelOther.value.trim(); }
    else { modelOther.hidden = true; launch.model = modelSelect.value; }
    write();
  };
  modelOther.oninput = () => { if (launch) { launch.model = modelOther.value.trim(); write(); } };
  extra.oninput = () => { if (launch) launch.extra = extra.value; else custom.args = extra.value; write(); };
  progInput.oninput = () => { custom.program = progInput.value; write(); };
  fillTools(); fillModels(); show();
  detectTools().then(fillTools).catch(() => {});
  box.append(toolField, progField, modelField, modelOther, extraField, preview);
  return box;
}
const editorDrafts = new WeakMap<Detail, { name?: string; path?: string; groupId?: string; command?: string; commandInShell?: boolean; tmux?: boolean; tmuxHideStatus?: boolean }>();
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
  const cancel = button(t("app.cancel"), backDetail); cancel.className = "ghost-btn";
  save.className = "primary-btn";
  footer.append(cancel, save); host.append(footer);
  let touched = false;
  host.addEventListener("input", () => { touched = true; });
  host.addEventListener("change", () => { touched = true; });
  editorDirty = () => touched && !save.disabled;
}
function summaryItem(title: string, detailText: string) {
  const item = document.createElement("div"); item.className = "summary-item";
  const strong = document.createElement("span"); strong.className = "summary-title"; strong.textContent = title;
  const sub = document.createElement("span"); sub.className = "summary-detail"; sub.textContent = detailText; sub.title = detailText;
  item.append(strong, sub); return item;
}
function savedTabSummary(tab: SavedTab, title?: string) {
  const parts = [tab.paths[0] || "", tab.paths.length > 1 ? t("app.splitCount", { n: tab.paths.length }) : "", tab.command ? `⌘ ${tab.command}${tab.commandInShell ? t("app.shellSuffix") : ""}` : ""].filter(Boolean);
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
function confirmTwice(button: HTMLButtonElement) { if (confirmTimers.has(button)) { clearTimeout(confirmTimers.get(button)); confirmTimers.delete(button); button.textContent = button.dataset.original || t("app.confirm"); button.classList.remove("confirming"); return true; } button.dataset.original = button.textContent; button.textContent = t("app.confirmAgain"); button.classList.add("confirming"); const timer = setTimeout(() => { button.textContent = button.dataset.original || t("app.confirm"); button.classList.remove("confirming"); confirmTimers.delete(button); }, 3000); confirmTimers.set(button, timer); return false; }
// Returns true when the stored list used the old format and was converted.
function applyFavoritesDocument(document: FavoritesDocument) {
  const result = migrateFavorites(document.items, () => crypto.randomUUID());
  const previous = favorites;
  folders = result.folders;
  favorites = result.favorites;
  favoritesRevision = document.revision;
  const ids = new Set(favorites.map((item) => item.id));
  for (const tab of tabs) {
    if (!tab.favoriteId) continue;
    if (!ids.has(tab.favoriteId)) { tab.title = unlinkedTitle(previous.find((item) => item.id === tab.favoriteId)?.name, tab.title); delete tab.favoriteId; continue; }
    // Tmux status bar is the one launch option that applies to a running terminal.
    const before = previous.find((item) => item.id === tab.favoriteId)?.tab.tmuxHideStatus, now = favorites.find((item) => item.id === tab.favoriteId)?.tab.tmuxHideStatus;
    if (tab.tmux && !!before !== !!now) {
      tab.tmuxHideStatus = now || undefined;
      for (const id of leaves(tab.tree)) { const session = surfaces.get(id)?.tmuxSession; if (session) invoke("tmux_set_status", { name: session, visible: !now }).catch(() => {}); }
    }
  }
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
// A favorite reopens with the panel as it was left; tmux tabs get it through the session file.
// Navigation and folder toggles come in bursts, so the favorites file is written after a pause.
const filesDirty = new Set<Tab>();
let filesTimer: ReturnType<typeof setTimeout> | undefined;
function rememberFilesState(tab: Tab) {
  scheduleSessionSave();
  if (!tab.favoriteId) return;
  filesDirty.add(tab);
  clearTimeout(filesTimer);
  filesTimer = setTimeout(flushFilesState, 600);
}
function flushFilesState() {
  const changes = new Map<string, SavedFiles | undefined>();
  for (const tab of filesDirty) {
    const item = favoriteOf(tab);
    const files = saveFiles(tab.files);
    if (item && !sameSaved(item.tab.files, files)) changes.set(item.id, files);
  }
  filesDirty.clear();
  if (!changes.size) return;
  persistFavorites(favorites.map((value) => (changes.has(value.id) ? { ...value, tab: { ...value.tab, files: changes.get(value.id) } } : value))).catch(notify);
}
function savedTab(tab: Tab, sessions = false): SavedTab {
  const ids = leaves(tab.tree);
  return { tmux: tab.tmux, tmuxHideStatus: tab.tmuxHideStatus, tmuxSessions: sessions && tab.tmux ? ids.map((id) => surfaces.get(id)?.tmuxSession) : undefined, paths: ids.map((id) => surfaces.get(id)?.cwd || ""), tree: savedTree(tab.tree, ids), focused: Math.max(0, ids.indexOf(tab.focused)), title: tab.favoriteId ? undefined : tab.title, command: tab.command, commandInShell: tab.commandInShell, favoriteId: tab.favoriteId, files: saveFiles(tab.files) };
}
// ── Attention: bell / notification / agent waiting ──────────────────────────
let attention: AttentionState = emptyAttention;
const idleTracks = new Map<string, IdleTrack>();
const dismissed = new Map<string, string>();
const screens = new Map<string, { text: string; agent: string }>();
const viewing = (id: string) => !!active && document.hasFocus() && tabFor(id) === active;
function setAttention(next: AttentionState) {
  if (next === attention) return;
  attention = next;
  renderAttention();
  renderTabs();
}
function raiseAlert(id: string, source: AlertSource, title: string, body: string, screen?: string, prompt?: Prompt) {
  if (viewing(id)) return;
  setAttention(raise(attention, { surfaceId: id, source, title, body, since: Date.now(), screen, prompt }));
  if (screen === undefined) captureScreen(id).catch(() => {});
}
// Freeze what the terminal shows right now into the alert, for the bell panel.
async function captureScreen(id: string) {
  const result = await native<{ screens?: Record<string, { text: string; agent: string }> }>({ op: "scan", ids: [id], agents: promptRules.agents });
  const text = result.screens?.[id]?.text;
  if (text === undefined) return;
  screens.set(id, result.screens![id]);
  setAttention(attachScreen(attention, id, snapshot(text)));
}
// force：原生終端機取得第一回應者時，WebView 的 document.hasFocus() 不可靠，直接以原生 focus 事件為準。
function clearViewed(force = false) {
  if (!active || (!force && !document.hasFocus())) return;
  let next = attention;
  for (const id of leaves(active.tree)) next = clear(next, id);
  setAttention(next);
}
function alertLabel(id: string) {
  const tab = tabFor(id);
  return tab ? tabName(tab) : name(surfaces.get(id)?.cwd || "/");
}
function ago(since: number) {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return seconds < 60 ? t("app.agoSeconds", { n: seconds }) : seconds < 3600 ? t("app.agoMinutes", { n: Math.round(seconds / 60) }) : t("app.agoHours", { n: Math.round(seconds / 3600) });
}
// Prompt-recognition rules: built-in file plus the user's override in the data directory.
let promptRules: CompiledRules = buildRules(builtinRules).rules;
async function loadPromptRules() {
  let userText = "";
  try { userText = await invoke<string>("prompt_rules_read"); } catch (error) { notify(error); }
  const built = buildRules(builtinRules, userText);
  promptRules = built.rules;
  $("rules-summary").textContent = [
    built.userRules ? t("app.rulesCountWithUser", { n: built.rules.rules.length, user: built.userRules }) : t("app.rulesCount", { n: built.rules.rules.length }),
    ...built.errors.map((error) => `⚠ ${formatRuleError(error, t)}`),
    built.userBroken ? t("app.rulesUserBroken") : "",
  ].filter(Boolean).join("\n");
}
const signalHint = (title: string) => title === t("app.alertBell") ? t("app.alertBellHint") : title === t("app.alertStopped") ? t("app.alertStoppedHint") : "";
const promptLine = (prompt: Prompt, index: number) => `${prompt.selected === index ? "▶" : "  "} ${prompt.options[index]}`;
let lastAttentionSig: string | undefined;
// Menus answered from a card: the question we sent a choice for, until the screen changes. While locked the card's
// buttons are off, so a second click (or another window's) cannot press keys into whatever the screen became.
const answering = new Map<string, { key: string; at: number }>();
async function answerPrompt(surfaceId: string, shown: Prompt, index: number) {
  const keys = menuKeys(shown, index);
  if (!keys || answering.has(surfaceId)) return;
  // Locked by the menu's identity, not its cursor row: our own arrow keys move the cursor, which must not unlock it.
  answering.set(surfaceId, { key: promptIdentity(shown), at: Date.now() });
  renderAttention();
  let sent = false;
  const read = async () => {
    const screen = (await scanScreens([surfaceId]))[surfaceId];
    return screen?.agent ? recognizePrompt(screen.text.split("\n"), promptRules) : null;
  };
  const press = async (key: string) => {
    const reply = await native<{ error?: string }>({ op: "key", id: surfaceId, key });
    if (reply?.error) throw new Error(reply.error);
  };
  const refuse = () => { answering.delete(surfaceId); notify(t("app.answerChanged")); scanAttention().catch(notify); };
  try {
    // Read the screen again right now: the same question, options and cursor row, or nothing is pressed.
    if (!sameMenu(shown, await read())) return refuse();
    const moves = keys.slice(0, -1);
    for (const [i, key] of moves.entries()) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 60));
      sent = true;
      await press(key);
    }
    // Enter only if the cursor really is on the chosen row now; the screen may have moved on while we pressed.
    if (moves.length) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const now = await read();
      if (!now || promptIdentity(now) !== promptIdentity(shown) || now.selected !== index || now.exact !== true) {
        // Arrow keys already went out: stay locked (no second attempt) and tell the person where things stand.
        notify(t("app.answerChanged"));
        renderAttention();
        return;
      }
    }
    sent = true;
    await press("enter");
  } catch (error) {
    // Part of the keys may have gone out: stay locked until the screen changes instead of inviting a second try.
    if (!sent) answering.delete(surfaceId);
    notify(error);
  }
  renderAttention();
}
// 各卡片「畫面內容」方塊是否展開（預設收合）；重繪會重建 DOM，所以記在這裡。
const expandedBodies = new Set<string>();
function renderAttention() {
  const count = unreadCount(attention);
  for (const id of ["bell-count", "rail-alert"]) {
    const el = $(id); el.hidden = count === 0; if (id === "bell-count") el.textContent = badgeText(count);
  }
  $("bell-btn").classList.toggle("has-alert", count > 0);
  if (!attentionDrop.isOpen()) { lastAttentionSig = undefined; return; }
  const list = attentionDrop.list;
  const alerts = sorted(attention);
  const bodies = new Map<string, string>();
  const asks = new Map<string, string>();
  for (const alert of alerts) {
    const live = screens.get(alert.surfaceId)?.text;
    const shown = alert.screen || (live ? snapshot(live) : "");
    // Hook/notification message first, then the captured screen it refers to.
    bodies.set(alert.surfaceId, [alert.body && !shown.includes(alert.body) ? alert.body : "", shown].filter(Boolean).join("\n\n"));
    if (alert.prompt) asks.set(alert.surfaceId, [alert.prompt.question, ...alert.prompt.options.map((_, index) => promptLine(alert.prompt!, index))].filter(Boolean).join("\n"));
    else {
      // 只有響鈴／通知時沒有問題可顯示：補上頁籤、目錄、終端機標題，讓人知道是哪裡、大致什麼情況。
      const surface = surfaces.get(alert.surfaceId);
      asks.set(alert.surfaceId, [signalHint(alert.title), surface?.title ? t("app.alertTerminalTitle", { title: surface.title }) : "", surface?.cwd ? t("app.alertDirectory", { path: surface.cwd }) : ""].filter(Boolean).join("\n"));
    }
  }
  const metaOf = (alert: (typeof alerts)[number]) => [alert.title, alert.prompt?.low ? t("app.uncertain") : "", alert.count > 1 ? `×${alert.count}` : "", screens.get(alert.surfaceId)?.agent, ago(alert.since)].filter(Boolean).join(" · ");
  const sig = JSON.stringify([alerts.map((alert) => [alert.surfaceId, alert.source, alertLabel(alert.surfaceId), alert.title, alert.count, screens.get(alert.surfaceId)?.agent, bodies.get(alert.surfaceId), asks.get(alert.surfaceId), alert.prompt?.selected, answering.get(alert.surfaceId)?.key])]);
  const hadCards = lastAttentionSig !== undefined && lastAttentionSig !== "[]";
  // Same content: only refresh the relative times, so scroll positions and focus survive the 1.5s scan.
  if (sig === lastAttentionSig) {
    for (const alert of alerts) { const el = list.querySelector<HTMLElement>(`.alert-card[data-surface="${CSS.escape(alert.surfaceId)}"] .alert-meta`); if (el) el.textContent = metaOf(alert); }
    return;
  }
  lastAttentionSig = sig;
  // Dismissed the last card: nothing left to show, so close instead of leaving an empty shell.
  if (!count && hadCards) { attentionDrop.close(); return; }
  const listTop = list.scrollTop;
  const bodyTops = new Map<string, number>();
  for (const card of list.querySelectorAll<HTMLElement>(".alert-card")) bodyTops.set(card.dataset.surface || "", card.querySelector(".alert-body")?.scrollTop ?? 0);
  for (const id of expandedBodies) if (!attention.has(id)) expandedBodies.delete(id);
  list.replaceChildren();
  if (!count) { list.append(help(t("app.noAttention"))); attentionDrop.afterRender(); return; }
  for (const alert of alerts) {
    const card = document.createElement("div"); card.className = "alert-card"; card.dataset.source = alert.source; card.dataset.surface = alert.surfaceId; if (alert.prompt?.low) card.dataset.low = "1";
    const head = document.createElement("div"); head.className = "alert-head";
    const name_ = document.createElement("strong"); name_.textContent = alertLabel(alert.surfaceId);
    const meta = document.createElement("span"); meta.className = "alert-meta";
    meta.textContent = metaOf(alert);
    head.append(name_, meta);
    const ask = document.createElement("pre"); ask.className = "alert-ask"; ask.textContent = asks.get(alert.surfaceId) || "";
    const pre = document.createElement("pre"); pre.className = "alert-body";
    pre.textContent = bodies.get(alert.surfaceId) || "";
    const fold = document.createElement("details"); fold.className = "alert-fold"; fold.open = expandedBodies.has(alert.surfaceId);
    const foldSummary = document.createElement("summary"); foldSummary.textContent = t("app.screenContent");
    fold.append(foldSummary, pre);
    fold.addEventListener("toggle", () => { if (fold.open) expandedBodies.add(alert.surfaceId); else expandedBodies.delete(alert.surfaceId); });
    // A menu read reliably off the screen can be answered here; the keys are sent only after the screen is read again.
    const choices = document.createElement("div"); choices.className = "alert-options";
    if (alert.source === "prompt" && menuAnswerable(alert.prompt)) {
      const shown = alert.prompt, locked = answering.has(alert.surfaceId);
      shown.options.forEach((option, index) => {
        const choice = button(option, () => answerPrompt(alert.surfaceId, shown, index), option);
        choice.className = "ghost-btn"; choice.disabled = locked; choice.dataset.choice = String(index);
        if (index === shown.selected) choice.classList.add("current");
        choices.append(choice);
      });
      if (locked) choices.append(Object.assign(document.createElement("span"), { className: "help", textContent: t("app.answerSent") }));
    }
    const actions = document.createElement("div"); actions.className = "alert-actions";
    actions.append(
      button(t("app.goTo"), () => { attentionDrop.close(false); const tab = tabFor(alert.surfaceId); if (tab) { tab.focused = alert.surfaceId; activate(tab).catch(notify); } }),
      button(t("app.dismiss"), () => { if (alert.prompt && alert.source === "prompt") dismissed.set(alert.surfaceId, promptKey(alert.prompt)); setAttention(clear(attention, alert.surfaceId)); }),
    );
    for (const b of actions.querySelectorAll("button")) b.className = "ghost-btn";
    actions.children[0].setAttribute("data-act", "go"); actions.children[1].setAttribute("data-act", "dismiss");
    card.append(head);
    if (ask.textContent) card.append(ask);
    if (pre.textContent) card.append(fold);
    if (choices.children.length) card.append(choices);
    card.append(actions); list.append(card);
    if (pre.textContent) pre.scrollTop = bodyTops.get(alert.surfaceId) ?? 0;
  }
  list.scrollTop = listTop;
  attentionDrop.afterRender();
}
// Screen text and detected agent per surface. tmux tabs: the native surface only sees the tmux
// client, so ask tmux what runs in the pane.
type Screen = { text: string; agent: string };
async function scanScreens(ids: string[]): Promise<Record<string, Screen>> {
  const result = await native<{ screens?: Record<string, Screen> }>({ op: "scan", ids, agents: promptRules.agents });
  const found = result.screens || {};
  const agentName = new RegExp(`^(${promptRules.agents.join("|")})\\b`, "i");
  const panes: Record<string, string> = ids.some((id) => surfaces.get(id)?.tmuxSession) ? await invoke<Record<string, string>>("tmux_panes").catch(() => ({})) : {};
  for (const [id, screen] of Object.entries(found)) {
    const session = surfaces.get(id)?.tmuxSession;
    if (session && !screen.agent && agentName.test(panes[session] || "")) screen.agent = panes[session];
  }
  return found;
}
async function scanAttention() {
  clearViewed();
  const ids = [...surfaces.values()].filter((surface) => !surface.exited && !viewing(surface.id)).map((surface) => surface.id);
  setAttention(prune(attention, (id) => surfaces.has(id)));
  if (!ids.length) return;
  const found = await scanScreens(ids);
  const now = Date.now();
  for (const [id, screen] of Object.entries(found)) {
    screens.set(id, screen);
    const lock = answering.get(id);
    if (lock && (Date.now() - lock.at > ANSWER_LOCK_MS || promptIdentity((screen.agent ? recognizePrompt(screen.text.split("\n"), promptRules) : null) ?? undefined) !== lock.key)) answering.delete(id);
    if (!screen.agent) { idleTracks.delete(id); dismissed.delete(id); setAttention(clearSource(attention, id, "prompt")); continue; }
    const step = idleStep(idleTracks.get(id), screen.text, now, promptRules);
    idleTracks.set(id, step.track);
    const key = promptKey(step.prompt ?? undefined);
    if (dismissed.get(id) !== key) dismissed.delete(id);
    if (step.waiting && step.prompt) {
      const current = attention.get(id);
      // Same question already shown, or dismissed by the user: do not raise it again.
      if (!dismissed.has(id) && !(current?.source === "prompt" && promptKey(current.prompt) === key)) raiseAlert(id, "prompt", step.prompt.label, step.prompt.question, snapshot(screen.text), step.prompt);
    } else if (step.track.since === now) setAttention(clearSource(attention, id, "prompt"));
  }
  for (const id of [...screens.keys()]) if (!surfaces.has(id)) { answering.delete(id); screens.delete(id); idleTracks.delete(id); dismissed.delete(id); }
  renderAttention();
}
// 頁籤列的點擊不留下鍵盤焦點：游標點到頁籤（或其按鈕）後，焦點一律回到終端機，
// 否則 ⌘T／⌘D 等 surface 層快捷鍵會送進 WebView 而沒反應。
function keepTerminalFocus() {
  const list = $("tabs");
  list.addEventListener("mousedown", (event) => {
    if (event.target instanceof Element && event.target.closest("button") && !event.target.closest("input")) event.preventDefault();
  });
  list.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("input, textarea")) return;
    setTimeout(() => { if (active && !dialogsOpen()) native({ op: "focus", id: active.focused }).catch(() => {}); }, 0);
  });
}
// 同目錄有多個終端機時，原頁籤變成一列虛擬的父層，所有真正的終端機頁籤（含原本那個）
// 都掛在底下；只剩一個時自然還原成單一列。
const collapsedTabGroups = new Set<string>();
function appendTabGroup(parent: HTMLElement, root: Tab, folder: FavoriteFolder | undefined, hotkey: (tab: Tab) => number | undefined) {
  const kids = childrenOf(root);
  if (!kids.length) { appendTabRow(parent, root, folder, hotkey(root)); return; }
  const members = [root, ...kids];
  const collapsed = collapsedTabGroups.has(root.id);
  const head = document.createElement("div"); head.className = "row tab-parent" + (collapsed && members.includes(active!) ? " selected" : "");
  if (folder) head.style.setProperty("--group-color", folder.color);
  const toggle = button("", () => { if (collapsed) collapsedTabGroups.delete(root.id); else collapsedTabGroups.add(root.id); renderTabs(); }, collapsed ? t("app.expand") : t("app.collapse"));
  toggle.className = "row-label tab-parent-label"; toggle.setAttribute("aria-expanded", String(!collapsed));
  const chevron = document.createElement("span"); chevron.className = "group-chevron" + (collapsed ? "" : " expanded"); chevron.innerHTML = icons.chevron;
  const label = document.createElement("span"); label.textContent = tabName(root);
  toggle.replaceChildren(chevron, label);
  const count = document.createElement("span"); count.className = "badge"; count.textContent = String(members.length); count.title = t("app.sameDirTerminals", { n: members.length });
  head.append(toggle, count);
  if (root.favoriteId) { const star = document.createElement("span"); star.className = "favorite-mark"; star.innerHTML = icons.star; star.title = t("app.fromFavorite", { name: favoriteFor(root)?.name || "" }); head.append(star); }
  head.dataset.tabId = root.id;
  wireTabDrag(head, root, false);
  parent.append(head);
  if (collapsed) return;
  for (const tab of members) appendTabRow(parent, tab, folder, hotkey(tab), true);
}
function renderTabs() {
  scheduleSessionSave();
  const arranged = orderedTabs();
  const list = $("tabs");
  list.replaceChildren();
  const caption = (text: string) => { const el = document.createElement("div"); el.className = "caption"; el.textContent = text; return el; };
  const loose = arranged.filter((tab) => !tabFolder(tab));
  const ungrouped = document.createElement("section"); ungrouped.className = "tab-block";
  ungrouped.append(caption(t("app.ungrouped")));
  // ⌘1～⌘9 follow on-screen order; show the hint on the first nine rows.
  const hotkey = (tab: Tab) => { const index = arranged.indexOf(tab); return index >= 0 && index < 9 ? index + 1 : undefined; };
  const looseRoots = loose.filter((item) => !item.parentId);
  const looseFavorites = favorites.filter((item) => !folders.some((folder) => folder.id === item.groupId));
  for (const tab of looseRoots.filter((item) => !looseFavorites.some((favorite) => favorite.id === item.favoriteId))) appendTabGroup(ungrouped, tab, undefined, hotkey);
  // Ungrouped favorites follow favorite order, like grouped ones: opening a terminal never moves a row.
  for (const favorite of looseFavorites) {
    const instances = looseRoots.filter((tab) => tab.favoriteId === favorite.id);
    for (const tab of instances) appendTabGroup(ungrouped, tab, undefined, hotkey);
    if (!instances.length) appendWorkspaceFavoriteRow(ungrouped, favorite);
  }
  if (!loose.length && !looseFavorites.length) ungrouped.append(help(t("app.noUngroupedTabs")));
  list.append(ungrouped);
  if (folders.length) {
    list.append(Object.assign(document.createElement("div"), { className: "section-divider" }));
    for (const folder of folders) {
      const items = folderFavorites(folder.id);
      const openTabs = arranged.filter((tab) => tabFolder(tab)?.id === folder.id);
      const block = document.createElement("section"); block.className = "tab-block grouped"; block.style.setProperty("--group-color", folder.color);
      block.dataset.groupId = folder.id;
      // Parent row: the group; its tabs sit indented underneath and can be collapsed.
      const collapsed = collapsedWorkspaceGroups.has(folder.id);
      const heading = button("", () => {
        if (collapsedWorkspaceGroups.has(folder.id)) collapsedWorkspaceGroups.delete(folder.id); else collapsedWorkspaceGroups.add(folder.id);
        try { localStorage.setItem("workspace-collapsed-groups", JSON.stringify([...collapsedWorkspaceGroups])); } catch {}
        renderTabs();
      }, collapsed ? t("app.expandGroup") : t("app.collapseGroup"));
      heading.className = "row group-heading";
      heading.setAttribute("aria-expanded", String(!collapsed));
      const chevron = document.createElement("span"); chevron.className = "group-chevron" + (collapsed ? "" : " expanded"); chevron.innerHTML = icons.chevron;
      const dot = document.createElement("span"); dot.className = "group-dot";
      const label = document.createElement("span"); label.className = "group-heading-name"; label.textContent = folder.name;
      const count = document.createElement("span"); count.className = "badge"; count.textContent = String(items.length);
      const activeMark = document.createElement("span"); activeMark.className = "active-mark"; activeMark.title = t("app.currentTabInGroup"); activeMark.hidden = !collapsed || !openTabs.includes(active!);
      heading.append(chevron, dot, label, count, activeMark);
      const children = document.createElement("div"); children.className = "group-children"; children.hidden = collapsed;
      // Favorite order is the only order: opening a terminal changes a row's look, never its place.
      for (const favorite of items) {
        const instances = openTabs.filter((tab) => !tab.parentId && tab.favoriteId === favorite.id);
        for (const tab of instances) appendTabGroup(children, tab, folder, hotkey);
        if (!instances.length) appendWorkspaceFavoriteRow(children, favorite, folder);
      }
      if (!items.length) children.append(help(t("app.noFavoritesInCategory")));
      block.append(heading, children);
      list.append(block);
    }
  }
  $("current").textContent = currentSurface()?.cwd || t("app.chooseWorkingFolder");
  $("rail-exited").hidden = !tabs.some((tab) => leaves(tab.tree).every((id) => surfaces.get(id)?.exited));
  $("empty").hidden = tabs.length > 0;
  const top = detail();
  if (top?.kind === "edit-tab" && !tabs.some((tab) => tab.id === top.tabId)) renderDetail();
  renderFavorites();
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
// Rows reorder by pointer (see row-drag.ts). A favorite's row, open or not, reorders the
// favorite itself, so the order is remembered whether or not a terminal is open; other
// tabs reorder the open list, sub-tabs only among their siblings.
function wireRowDrag(row: HTMLElement, kind: string, id: string) {
  row.dataset.dragKind = kind; row.dataset.dragId = id;
  enableRowDrag(row, (moving, before) => {
    const movingId = moving.dataset.dragId!, beforeId = before?.dataset.dragId;
    if (kind === "fav") {
      const groupId = moving.closest<HTMLElement>(".tab-block")?.dataset.groupId;
      persistFavorites(moveGroupedItem(favorites, movingId, groupId ?? null, beforeId)).then(renderTabs).catch(notify);
    } else { moveTab(movingId, beforeId); renderTabs(); }
  });
}
function wireTabDrag(row: HTMLElement, tab: Tab, nested: boolean) {
  if (nested) wireRowDrag(row, `child:${tab.parentId}`, tab.id);
  else if (tab.favoriteId && favoriteOf(tab)) wireRowDrag(row, "fav", tab.favoriteId);
  else wireRowDrag(row, "tab", tab.id);
}
function appendTabRow(parent: HTMLElement, tab: Tab, folder?: FavoriteFolder, hotkey?: number, nested = false) {
  const ids = leaves(tab.tree), surface = surfaces.get(tab.focused);
  const top = detail();
  const editingThis = top?.kind === "edit-tab" && top.tabId === tab.id;
  const row = document.createElement("div"); row.className = "row tab-row" + (tab === active || editingThis ? " selected" : ""); row.dataset.tabId = tab.id;
  row.classList.toggle("child", nested);
  if (folder) row.style.setProperty("--group-color", folder.color);
  wireTabDrag(row, tab, nested);
  const alert = ids.map((id) => attention.get(id)).find(Boolean);
  if (alert) { row.classList.add("has-alert"); row.dataset.alert = alert.prompt?.low ? "maybe" : "yes"; }
  const state = document.createElement("span"); state.className = "status-dot"; state.classList.toggle("exited", ids.every((id) => surfaces.get(id)?.exited));
  state.title = ids.every((id) => surfaces.get(id)?.exited) ? t("app.terminalExited") : t("app.terminalOpen");
  const label = button(tabName(tab), () => activate(tab), surface?.cwd); label.className = "row-label"; label.ondblclick = () => inlineRename(tab, label);
  row.append(state, label);
  if (tab.status) { const note = document.createElement("span"); note.className = "tab-status"; note.textContent = tab.status; note.title = tab.status; row.append(note); }
  if (alert) { const pill = document.createElement("span"); pill.className = "alert-pill"; pill.textContent = alert.prompt?.low ? t("app.waiting") : alert.title; pill.title = alert.prompt ? [alert.prompt.question, ...alert.prompt.options].filter(Boolean).join("\n") : alert.body; row.append(pill); }
  if (tab.favoriteId && !nested) { const star = document.createElement("span"); star.className = "favorite-mark"; star.innerHTML = icons.star; star.title = t("app.fromFavorite", { name: favoriteFor(tab)?.name || "" }); row.append(star); }
  if (ids.length > 1) { const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = String(ids.length); badge.title = t("app.splitTitle", { n: ids.length }); row.append(badge); }
  // One slot at the row end: the ⌘N hint at rest, a floating "more" button on
  // hover. The button overlays the hint so hovering never reflows the label.
  const menu = () => popupMenu([
    { text: t("app.rename"), action: async () => { await native({ op: "focus-web" }); inlineRename(tab, label); } },
    { text: tab.favoriteId ? t("app.editFavoriteEllipsis") : t("app.editTabEllipsis"), action: () => renameTab(tab) },
    { text: t("app.duplicateTab"), action: () => duplicateTab(tab, surface?.cwd || defaultPath()) },
    { item: "Separator" },
    ...shellMenuItems(tab),
    { item: "Separator" },
    { text: t("app.closeTab"), action: () => requestClose(ids, (force) => closeTab(tab, force)) },
  ]);
  const slot = document.createElement("span"); slot.className = "tab-slot";
  if (hotkey) { const key = document.createElement("kbd"); key.className = "tab-key"; key.textContent = `⌘${hotkey}`; slot.append(key); }
  const more = button("", menu, t("app.tabActions")); more.className = "icon-btn tab-more"; more.innerHTML = icons.more;
  slot.append(more);
  row.oncontextmenu = (event) => { event.preventDefault(); if (event.ctrlKey) popupMenu(shellMenuItems(tab)); else menu(); };
  // The whole row switches tabs, not just the label: clicks on the alert pill,
  // status text, dot or empty space land here. Real controls handle themselves.
  row.onclick = (event) => { if (event.target instanceof Element && event.target.closest("button, input, kbd")) return; activate(tab); };
  row.append(slot); parent.append(row);
}
// Ctrl+click on a tab or favorite: a plain shell in its folder, ignoring any launch command.
// macOS sends Ctrl+click as a contextmenu event, so callers use oncontextmenu.
// The shell stays with its source: splits share the tab, a new tab is a child of it,
// and a favorite that is not open yet starts a tab linked to that favorite's group.
function shellMenuItems(tab: Tab): MenuEntry[] {
  const path = surfaces.get(tab.focused)?.cwd || defaultPath();
  const into = async (direction: number) => { await activate(tab); await newSurface(path, tab.focused, direction, { shell: true }); };
  return [
    { text: t("app.splitRight"), action: () => into(0) },
    { text: t("app.splitDown"), action: () => into(1) },
    { text: t("app.shellNewTab"), action: () => newSurface(path, undefined, undefined, { shell: true, parentId: rootOf(tab).id }) },
  ];
}
async function openFavoriteShell(item: WorkspaceFavorite) {
  const existing = recentFavoriteInstance(tabs, item.id, recentFavoriteInstances.get(item.id));
  if (existing) { await popupMenu(shellMenuItems(existing)); return; }
  await favoriteShellTab(item);
}
async function favoriteShellTab(item: WorkspaceFavorite) {
  const existing = recentFavoriteInstance(tabs, item.id, recentFavoriteInstances.get(item.id));
  const path = (existing && surfaces.get(existing.focused)?.cwd) || item.tab.paths[0] || defaultPath();
  await newSurface(path, undefined, undefined, { shell: true, favoriteId: item.id, parentId: existing ? rootOf(existing).id : undefined });
}
// Right-click menu of a favorite row: new tabs even when an instance is already open.
function favoriteMenuItems(item: WorkspaceFavorite): MenuEntry[] {
  return [
    { text: t("app.open"), action: () => openFavorite(item) },
    { text: t("app.duplicateTab"), action: () => openFavorite(item, true) },
    { text: t("app.shellNewTab"), action: () => favoriteShellTab(item) },
    { item: "Separator" },
    { text: t("app.editFavoriteEllipsis"), action: () => editFavorite(item) },
  ];
}
async function popupMenu(items: MenuEntry[]) {
  try {
    await showMenu({ items: items.map((item) => "item" in item ? item : { text: item.text, action: () => { Promise.resolve().then(item.action).catch(notify); } }) });
  } catch (error) { notify(error); }
}
function appendWorkspaceFavoriteRow(parent: HTMLElement, item: WorkspaceFavorite, folder?: FavoriteFolder) {
  const row = document.createElement("div"); row.className = "row favorite-workspace-row"; row.dataset.favoriteId = item.id;
  if (folder) row.style.setProperty("--group-color", folder.color);
  wireRowDrag(row, "fav", item.id);
  const state = document.createElement("span"); state.className = "status-dot inactive"; state.title = t("app.terminalNotOpen");
  const label = button(item.name, () => openFavorite(item), `${item.name}\n${item.tab.paths[0] || ""}`); label.className = "row-label";
  const edit = button("", () => editFavorite(item), t("app.editFavorite")); edit.className = "icon-btn row-action"; edit.innerHTML = icons.pencil;
  row.oncontextmenu = (event) => { event.preventDefault(); if (event.ctrlKey) { openFavoriteShell(item).catch(notify); return; } popupMenu(favoriteMenuItems(item)); };
  row.append(state, label, edit); parent.append(row);
}
// A linked tab is named by its favorite; anything else keeps its own title.
function renameLinked(tab: Tab, value: string) {
  const favorite = favoriteOf(tab);
  if (!favorite) { tab.title = value || undefined; return; }
  if (!value || value === favorite.name) return;
  persistFavorites(favorites.map((item) => item.id === favorite.id ? { ...item, name: value } : item)).then(() => { renderTabs(); renderFavorites(); }).catch(notify);
}
function inlineRename(tab: Tab, label: HTMLButtonElement) {
  const input = document.createElement("input"); input.className = "inline-rename"; input.value = tabName(tab);
  label.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = (save: boolean) => { if (done) return; done = true; if (save) renameLinked(tab, input.value.trim()); renderTabs(); };
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
function scheduleLayout() {
  if (!initialized || layoutPending) return;
  layoutPending = true;
  requestAnimationFrame(() => {
    layoutPending = false;
    updateLayout().catch(notify);
  });
}
async function updateLayout() {
  filesPanel.sync();
  const area = $("terminals").getBoundingClientRect();
  const full = terminalHidden();
  const split = splitBox(
    { x: area.x, y: area.y, width: area.width, height: area.height },
    active && !full ? active.preview : undefined,
  );
  const box = split.terminals;
  previewPanel.sync(split.preview, { x: area.x, y: area.y, width: area.width, height: area.height });
  const visible = active && !full
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
  host.querySelectorAll(".surface-outline").forEach((node) => node.remove());
  for (const r of visible) {
    const outline = document.createElement("div");
    outline.className =
      "surface-outline" + (r.id === active?.focused ? " focused" : "") + (surfaces.get(r.id)?.tmuxSession ? " tmux" : "");
    outline.dataset.id = r.id;
    outline.style.cssText = `left:${r.x - area.x}px;top:${r.y - area.y}px;width:${r.width}px;height:${r.height}px`;
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
// 只切換外框的 focused class，不重建 DOM、不送原生 layout。
function syncOutlines() {
  for (const el of $("terminals").querySelectorAll<HTMLElement>(".surface-outline"))
    el.classList.toggle("focused", el.dataset.id === active?.focused);
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
  syncOutlines();
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
  clearViewed();
  renderTabs();
  await updateLayout();
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
  renderConfigText();
  if (value.diagnostics.length) notify(value.diagnostics.join("\n"));
}
// 設定面板中隨語系變動的文字；語言切換時也會重畫。
function renderConfigText() {
  if (!config) return;
  $("config-path").textContent = config.path;
  $("config-summary").textContent =
    t("settings.configSummary", { version: config.version, size: config.fontSize, opacity: config.opacity });
  $("config-diagnostics").textContent =
    config.diagnostics.join("\n") || t("settings.configLoaded");
}
async function newSurface(path: string, source?: string, direction?: number, options: { command?: string; commandInShell?: boolean; tmux?: boolean; tmuxHideStatus?: boolean; tmuxSession?: string; parentId?: string; favoriteId?: string; background?: boolean; shell?: boolean } = {}) {
  const parent = source && direction !== undefined ? tabFor(source) : undefined;
  const sibling = options.parentId ? tabs.find((tab) => tab.id === options.parentId) : undefined;
  // ⌘⇧T 的子頁籤沿用來源頁籤的啟動命令、tmux 設定與收藏。
  // shell：純 shell，不繼承啟動命令與 tmux，但仍歸在來源頁籤（收藏／群組）底下。
  const command = options.shell ? undefined : options.command ?? sibling?.command;
  const commandInShell = options.shell ? undefined : options.commandInShell ?? sibling?.commandInShell;
  const useTmux = options.shell ? false : !!(options.tmux ?? parent?.tmux ?? sibling?.tmux);
  const hideStatus = options.shell ? false : !!(options.tmuxHideStatus ?? parent?.tmuxHideStatus ?? sibling?.tmuxHideStatus);
  const tmuxSession = useTmux ? (validSession(options.tmuxSession) ? options.tmuxSession : newSessionName()) : undefined;
  const tmuxBin = tmuxSession ? await invoke<string | null>("tmux_path").catch(() => null) : null;
  if (tmuxSession && !tmuxBin) throw new Error(t("app.tmuxMissing"));
  // HIGHOSTTY_* 給 session 內的程式（tmux 3.2 以下為空表）；失敗不影響開頁籤。
  const program = startProgram(command);
  const tmuxProgramPath = tmuxSession && program && !program.includes("/") ? await invoke<string | null>("program_path", { name: program }).catch(() => null) : null;
  let tmuxEnv = tmuxSession ? await invoke<Record<string, string>>("control_env", { session: tmuxSession }).catch(() => ({})) : undefined;
  // control_env 為空表代表 tmux 不支援 -e；支援時一併帶入登入 shell 的 PATH，pane 內的程式才找得到 Homebrew 等工具。
  if (tmuxEnv && Object.keys(tmuxEnv).length) {
    const loginPath = await invoke<string | null>("login_path").catch(() => null);
    if (loginPath) tmuxEnv = { ...tmuxEnv, PATH: loginPath };
  }
  const normalized = await invoke<string>("resolve_path", {
    path,
    base: homePath || undefined,
  });
  opening++;
  let result: { id: string; cwd: string };
  try {
    result = await native<{ id: string; cwd: string }>({
      op: "open",
      path: normalized,
      source,
      split: direction !== undefined,
      command: tmuxSession && tmuxBin ? tmuxCommand(tmuxSession, normalized, withProgramDir(withProgramPath(command, tmuxProgramPath), tmuxProgramPath), hideStatus, tmuxBin, tmuxEnv) : command,
      commandInShell: tmuxSession ? false : commandInShell,
      tmux: !!tmuxSession,
    });
  } finally {
    opening--;
  }
  surfaces.set(result.id, {
    id: result.id,
    cwd: result.cwd,
    title: "",
    exited: false,
    tmuxSession,
    openedAt: Date.now(),
    command,
  });
  let foreground = true;
  if (source && direction !== undefined) {
    const tab = tabFor(source);
    if (!tab) throw new Error(t("app.splitWorkspaceMissing"));
    tab.tree = split(tab.tree, source, result.id, direction);
    tab.focused = result.id;
    active = tab;
  } else {
    const tab: Tab = {
      id: crypto.randomUUID(),
      tree: { kind: "leaf", id: result.id },
      focused: result.id,
      command,
      commandInShell,
      favoriteId: options.favoriteId ?? sibling?.favoriteId,
      tmux: useTmux || undefined,
      tmuxHideStatus: useTmux && hideStatus || undefined,
      parentId: options.parentId,
    };
    // background：新頁籤不切過去、不搶焦點（agent 控制指令）；空工作區仍照常顯示。
    foreground = !options.background || !active;
    tabs.push(tab);
    if (foreground) active = tab;
  }
  for (const event of pendingEvents.get(result.id) || [])
    await handleEvent(event);
  pendingEvents.delete(result.id);
  renderTabs();
  await updateLayout();
  if (foreground) await native({ op: "focus", id: result.id });
  syncOutlines();
  return { surface: result.id, tab: tabFor(result.id)?.id };
}
// ⌘⇧T: another terminal in the same directory, shown one level under the root tab.
async function duplicateTab(tab: Tab, cwd: string) {
  // 套用來源的設定（啟動命令、tmux、收藏）；已連結收藏時以收藏目前的設定為準。
  const root = rootOf(tab), favorite = favoriteOf(root), config = favorite?.tab ?? root;
  await newSurface(cwd, undefined, undefined, {
    parentId: root.id,
    command: config.command,
    commandInShell: config.commandInShell,
    tmux: !!config.tmux,
    tmuxHideStatus: !!config.tmuxHideStatus,
    favoriteId: favorite?.id ?? root.favoriteId,
  });
}
function restoreTree(node: Node, ids: string[]): Node {
  if (node.kind === "leaf") return { kind: "leaf", id: ids[Number(node.id)] || ids[0] };
  return { ...node, first: restoreTree(node.first, ids), second: restoreTree(node.second, ids) };
}
// Older snapshots may still carry workspace groups; they are ignored now that
// a tab's group comes from its favorite.
async function restoreSnapshot(value: { tabs?: SavedTab[] }) {
  restoring = true;
  const restoredTabs = new Map<number, Tab>();
  try {
    for (const [position, saved] of (value.tabs || []).entries()) {
      const paths = saved.paths.filter(Boolean);
      if (!paths.length) continue;
      await newSurface(paths[0], undefined, undefined, { command: saved.command, commandInShell: saved.commandInShell, tmux: saved.tmux, tmuxHideStatus: saved.tmuxHideStatus, tmuxSession: saved.tmuxSessions?.[0] });
      const tab = active!;
      const ids = [tab.focused];
      for (const path of paths.slice(1)) {
        await newSurface(path, ids[0], 0, { tmuxSession: saved.tmuxSessions?.[ids.length] });
        ids.push(active!.focused);
      }
      tab.tree = restoreTree(saved.tree, ids);
      tab.focused = ids[saved.focused] || ids[0];
      tab.title = saved.favoriteId ? undefined : saved.title;
      tab.command = saved.command;
      tab.commandInShell = saved.commandInShell;
      tab.favoriteId = saved.favoriteId;
      const root = saved.parent !== undefined && saved.parent >= 0 ? restoredTabs.get(saved.parent) : undefined;
      if (root && !root.parentId) tab.parentId = root.id;
      restoredTabs.set(position, tab);
      tab.files = restoreFiles(saved.files) ?? tab.files;
    }
    if (tabs.length) active = tabs.at(-1);
    if (active) rememberFavoriteInstance(active);
    // newSurface already synced the panel while it still had no saved state.
    filesPanel.invalidate();
    // Panels that were popped out come back as their own windows.
    for (const tab of restoredTabs.values()) if (tab.files?.detached) openFilesWindow(tab, false).catch(notify);
  } finally { restoring = false; }
  renderTabs();
  renderDrawer();
  if (active) { await updateLayout(); await native({ op: "focus", id: active.focused }); }
}
// ── tmux 工作階段：只在主視窗保存／恢復；結束 app 時 session 留在背景 ─────────
let keepTmux = false, sessionFrozen = false, sessionTimer: ReturnType<typeof setTimeout> | undefined;
const sessionDocument = () => {
  const saved = orderWithChildren(tabs).filter((tab) => tab.tmux);
  return { tabs: saved.map((tab) => ({ ...savedTab(tab, true), parent: tab.parentId ? saved.findIndex((item) => item.id === tab.parentId) : undefined })) };
};
function scheduleSessionSave() {
  if (win.label !== "main" || sessionFrozen || restoring || !initialized) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { if (!sessionFrozen) invoke("save_session", { session: sessionDocument() }).catch(() => {}); }, 400);
}
// 離開前寫入最後狀態，之後關閉頁籤不再覆寫，也不結束 tmux session。
async function freezeSession() {
  clearTimeout(sessionTimer);
  if (win.label === "main") {
    await invoke("save_session", { session: sessionDocument() }).catch(notify);
    keepTmux = true;
  }
  sessionFrozen = true;
}
async function restoreSession() {
  if (win.label !== "main") return;
  const document = await invoke<{ tabs?: unknown }>("load_session").catch(() => ({}) as { tabs?: unknown });
  const saved = restorable<SavedTab>(document.tabs);
  if (!saved.length) return;
  if (!(await invoke<boolean>("tmux_available").catch(() => false))) { notify(t("app.tmuxMissingRestore")); return; }
  await restoreSnapshot({ tabs: saved }).catch(notify);
}
async function destroy(id: string, force: boolean) {
  await native({ op: "close", id, force });
  await forgetSurface(id);
}
async function forgetSurface(id: string) {
  const tab = tabFor(id);
  const session = surfaces.get(id)?.tmuxSession;
  surfaces.delete(id);
  // 結束 app 時保留 session；其餘（手動關閉、shell 結束）一併結束 session，避免殘留。
  if (session && !keepTmux) invoke("tmux_kill_session", { name: session }).catch(() => {});
  if (!tab) return;
  const tree = removeLeaf(tab.tree, id);
  if (!tree) {
    const heir = promoteChildren(tabs, tab.id);
    if (heir && tab.favoriteId) heir.favoriteId = tab.favoriteId;
    tabs = tabs.filter((t) => t !== tab);
    if (tab.files?.detached) invoke("close_files_window", { tab: tab.id }).catch(() => {});
    if (active === tab) active = heir || tabs.at(-1);
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
    title: tabName(tab),
  };
  if (remember) await syncFavoriteLayout(tab);
  for (const id of ids) await destroy(id, force);
  if (remember) {
    closedHistory.push(item);
    redoHistory = [];
  }
}
type ConfirmText = { title: string; message: string; cancel: string; force: string };
const confirmDefaults = (): ConfirmText => ({
  title: t("app.confirmTitle"),
  message: t("app.confirmBody"),
  cancel: t("app.cancel"),
  force: t("app.forceClose"),
});
function setConfirmText(text: Partial<ConfirmText> = {}) {
  const texts = { ...confirmDefaults(), ...text };
  document.querySelector("#confirm h3")!.textContent = texts.title;
  document.querySelector("#confirm p")!.textContent = texts.message;
  $("cancel-close").textContent = texts.cancel;
  $("force-close").textContent = texts.force;
}
async function requestClose(
  ids: string[],
  fn: (force: boolean) => Promise<void>,
  alwaysAsk: Partial<ConfirmText> | undefined = undefined,
) {
  if (closing) return;
  // tmux 頁籤的前景行程只是 tmux client，不算「仍有工作執行」。
  const infos = (await Promise.all(
    ids.map((id) => native<Info>({ op: "info", id })),
  )).map((info, index) => surfaces.get(ids[index])?.tmuxSession ? { ...info, running: [], needsConfirm: false } : info);
  const running = infos.flatMap((info, index) =>
    info.running.map(
      (p) => `${name(surfaces.get(ids[index])?.cwd || "/")}: ${p}`,
    ),
  );
  if (alwaysAsk || infos.some((i) => i.needsConfirm) || running.length) {
    setConfirmText(alwaysAsk);
    $("processes").textContent =
      running.join("\n") ||
      (alwaysAsk
        ? plainTabs().map(tabName).join("\n")
        : t("app.stillRunningTerminal"));
    closeAction = () => fn(true);
    await showDialog("confirm");
  } else await fn(false);
}
// 排除整個都是 tmux 窗格的頁籤：它們在背景持續執行，關視窗不會終止。
const plainTabs = () => tabs.filter((tab) => leaves(tab.tree).some((id) => !surfaces.get(id)?.tmuxSession));
async function shutdown(all = false) {
  if (all) {
    const info = await native<{ running: string[]; needsConfirm: boolean }>({
      op: "all-info",
    });
    const finish = async (force: boolean) => {
      await freezeSession();
      await native({ op: "close-all", force });
      await invoke("quit_app");
    };
    if (info.running.length || info.needsConfirm) {
      $("processes").textContent = info.running.join("\n") || t("app.stillRunning");
      closeAction = () => finish(true);
      await showDialog("confirm");
    } else await finish(false);
    return;
  }
  await requestClose(
    [...surfaces.keys()],
    async (force) => {
      await freezeSession();
      for (const tab of [...tabs]) await closeTab(tab, force, false);
      await native({ op: "forget-window" });
      await win.destroy();
    },
    plainTabs().length
      ? {
          title: t("app.closeWindowTitle"),
          message: t("app.closeWindowBody", { n: plainTabs().length }),
          cancel: t("app.closeWindowCancel"),
          force: t("app.closeWindowForce"),
        }
      : undefined,
  );
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
function displayPath(path: string) {
  return homePath && (path === homePath || path.startsWith(homePath + "/")) ? "~" + path.slice(homePath.length) : path;
}
function defaultPath() {
  return currentSurface()?.cwd || homePath;
}
// "terminal" opens a new tab in the chosen folder; "favorite" fills the editor.
async function pick(field: "terminal" | "favorite") {
  await updateLayout();
  const initial =
    field === "favorite"
      ? $<HTMLInputElement>("favorite-path").value
      : defaultPath();
  // Suspend all native surfaces while the OS sheet owns keyboard input.
  await native({
    op: "layout",
    rects: [],
    viewportWidth: window.innerWidth,
    suspended: true,
  });
  try {
    const path = await invoke<string | null>("pick_directory", {
      path: initial || defaultPath() || (await invoke<string>("home")),
    });
    if (path) {
      if (field === "favorite") {
        $<HTMLInputElement>("favorite-path").value = path;
        $("favorite-path").dispatchEvent(new Event("input"));
      }
      else await newSurface(path);
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
  ungrouped.append(caption(t("app.ungrouped")));
  for (const item of loose) appendFavoriteRow(ungrouped, item);
  if (!favorites.length && !folders.length) ungrouped.append(help(t("app.noFavorites")));
  else if (!loose.length) ungrouped.append(help(t("app.noUngroupedFavorites")));
  list.append(ungrouped, Object.assign(document.createElement("div"), { className: "section-divider" }), caption(t("app.group")));
  if (!folders.length) { const empty = button(t("app.createFirstGroup"), () => createFolder()); empty.className = "ghost-btn wide-button"; list.append(empty); }
  const stack = drawerState.detailStack;
  for (const folder of folders) {
    const items = folderFavorites(folder.id);
    const row = document.createElement("div"); row.className = "row group-row"; row.dataset.groupId = folder.id;
    row.classList.toggle("selected", stack.some((item) => (item.kind === "group" || item.kind === "edit-group") && item.groupId === folder.id));
    const dot = document.createElement("span"); dot.className = "group-dot"; dot.style.background = folder.color;
    const label = button(folder.name, () => toggleFolderDetail(folder), folder.name); label.className = "row-label";
    const count = document.createElement("span"); count.className = "badge"; count.textContent = String(items.length);
    const openMark = document.createElement("span"); openMark.className = "active-mark"; openMark.title = t("app.groupHasOpen"); openMark.hidden = !items.some(favoriteIsOpen);
    const chevron = document.createElement("span"); chevron.className = "row-chevron"; chevron.innerHTML = icons.chevron;
    const edit = button("", () => editFolder(folder), t("app.editGroup")); edit.className = "icon-btn row-action"; edit.innerHTML = icons.pencil;
    row.dataset.dragKind = "group"; row.dataset.dragId = folder.id;
    enableRowDrag(row, (moving, before) => {
      const movingId = moving.dataset.dragId!, beforeId = before?.dataset.dragId;
      const next = beforeId ? moveItemBefore(folders, movingId, beforeId) : [...folders.filter((item) => item.id !== movingId), ...folders.filter((item) => item.id === movingId)];
      persistFavorites(favorites, next).then(renderTabs).catch(notify);
    });
    row.append(dot, label, count, openMark, chevron, edit);
    list.append(row);
  }
  if (detail()?.kind === "group") renderDetail();
}
function appendFavoriteRow(parent: HTMLElement, item: WorkspaceFavorite) {
  const row = document.createElement("div"); row.className = "row favorite-row"; row.dataset.favoriteId = item.id;
  const top = detail();
  row.classList.toggle("selected", top?.kind === "edit-favorite" && top.favoriteId === item.id);
  row.dataset.dragKind = `favorites:${item.groupId || ""}`; row.dataset.dragId = item.id;
  enableRowDrag(row, (moving, before) => {
    persistFavorites(moveGroupedItem(favorites, moving.dataset.dragId!, item.groupId || null, before?.dataset.dragId)).then(renderTabs).catch(notify);
  });
  const icon = document.createElement("span"); icon.className = "favorite-icon"; icon.innerHTML = icons.tab;
  const label = button(item.name, () => openFavorite(item), `${item.name}\n${item.tab.paths[0] || ""}`); label.className = "row-label";
  const openMark = document.createElement("span"); openMark.className = "active-mark"; openMark.title = t("app.opened"); openMark.hidden = !favoriteIsOpen(item);
  const edit = button("", () => editFavorite(item), t("app.editFavorite")); edit.className = "icon-btn row-action"; edit.innerHTML = icons.pencil;
  row.oncontextmenu = (event) => { event.preventDefault(); if (event.ctrlKey) openFavoriteShell(item).catch(notify); else popupMenu(favoriteMenuItems(item)); };
  row.append(icon, label);
  if (item.tab.paths.length > 1) { const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = String(item.tab.paths.length); badge.title = t("app.splitTitle", { n: item.tab.paths.length }); row.append(badge); }
  row.append(openMark, edit);
  parent.append(row);
}
function toggleFolderDetail(folder: FavoriteFolder) {
  const top = detail();
  if (top?.kind === "group" && top.groupId === folder.id) { drawerState = { ...drawerState, detailStack: [] }; renderDrawer(); return; }
  showRootDetail({ kind: "group", groupId: folder.id });
}
function createFolder() { showDetail({ kind: "edit-group" }, false, true); }
function editFolder(folder: FavoriteFolder) { showDetail({ kind: "edit-group", groupId: folder.id }); }
async function saveFolder(folder: FavoriteFolder | undefined, folderName: string, color: string) {
  if (folder) {
    await persistFavorites(favorites, folders.map((item) => item.id === folder.id ? { ...item, name: folderName, color } : item));
    renderTabs(); backDetail(); return;
  }
  const created: FavoriteFolder = { id: crypto.randomUUID(), kind: "folder", name: folderName, color };
  await persistFavorites(favorites, [...folders, created]);
  // Opened from a favorite editor's t("app.newGroupOption"): select the new group there.
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
// Write the tab's current directories, splits and files panel into its favorite;
// name, command and tmux options live only in the favorite.
async function updateFavoriteLayout(tab: Tab) {
  const favorite = favoriteOf(tab);
  if (!favorite) return;
  const { paths, tree, focused, files } = savedTab(tab);
  const updated: WorkspaceFavorite = { ...favorite, tab: { ...favorite.tab, paths, tree, focused, files } };
  await persistFavorites(favorites.map((item) => item.id === favorite.id ? updated : item));
  // 編輯面板的「內容」「目前開啟」是建立時取的快照，強制重建才會反映新版面。
  renderedDetail = undefined;
  renderTabs(); renderDrawer();
}
// 手動關閉分割／頁籤時自動寫回收藏；失敗不影響關閉。
function syncFavoriteLayout(tab: Tab) {
  if (!favoriteOf(tab) || tab.parentId) return Promise.resolve(); // 子頁籤的版面不代表收藏
  return updateFavoriteLayout(tab).catch(() => {});
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
    const path = await invoke<string>("resolve_path", { path: input.value, base: defaultPath() });
    if (error) error.hidden = true;
    return path;
  } catch (reason) {
    if (!error) throw reason;
    error.textContent = String(reason); error.hidden = false; input.focus();
    return undefined;
  }
}
async function saveFavoriteEditor(current: Detail, item: WorkspaceFavorite | undefined, sourceTab: Tab | undefined, alias: string, groupId: string, pathInput: HTMLInputElement | undefined, launch: { command: string; commandInShell: boolean; tmux: boolean; tmuxHideStatus: boolean }) {
  if (!alias) { $("alias").focus(); return; }
  const group = groupId || undefined;
  const options: Partial<SavedTab> = { command: launch.command || undefined, commandInShell: launch.command ? launch.commandInShell || undefined : undefined, tmux: launch.tmux || undefined, tmuxHideStatus: launch.tmux && launch.tmuxHideStatus || undefined };
  let createdId: string | undefined;
  if (item) {
    let tab = item.tab;
    if (pathInput) {
      const path = await resolveFavoritePath();
      if (!path) return;
      tab = { ...tab, paths: [path, ...tab.paths.slice(1)] };
    }
    const updated: WorkspaceFavorite = { id: item.id, kind: "tab", name: alias, tab: { ...tab, title: undefined, ...options }, groupId: group };
    await persistFavorites(favorites.map((value) => value.id === item.id ? updated : value));
  } else {
    const id = crypto.randomUUID();
    let tab: SavedTab;
    if (sourceTab) {
      const saved = savedTab(sourceTab);
      tab = { ...saved, favoriteId: id, title: undefined, ...options };
    } else {
      const path = await resolveFavoritePath();
      if (!path) return;
      tab = { paths: [path], tree: { kind: "leaf", id: "0" }, focused: 0, ...options };
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
  const favorite = favoriteOf(tab);
  if (favorite) { editFavorite(favorite); return; }
  showDetail({ kind: "edit-tab", tabId: tab.id, focus: "name" });
}
async function showPalette(overview = false) {
  $("palette-title").textContent = overview ? t("app.workspaceOverview") : t("app.paletteTitle");
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
      add(tabName(tab), () =>
        activate(tab),
      );
  } else {
    add(t("app.filesPanel"), () => filesPanel.toggle());
    if (active?.preview) {
      add(t("app.togglePreviewSide"), async () => togglePreview());
      add(t("app.closePreview"), async () => closePreview());
    }
    add(t("app.newWorkspace"), () => newSurface(defaultPath()));
    add(t("app.newWindow"), () =>
      invoke("new_window", {
        path: defaultPath(),
        quick: false,
      }),
    );
    add(t("app.quickTerminal"), () =>
      invoke("new_window", {
        path: defaultPath(),
        quick: true,
      }),
    );
    for (const [label, direction] of [
      [t("app.splitRight"), 0],
      [t("app.splitDown"), 1],
    ] as const)
      add(label, () =>
        currentSurface()
          ? newSurface(currentSurface()!.cwd, active!.focused, direction)
          : Promise.resolve(),
      );
    add(t("app.shareGhosttyConfig"), async () => { setPanel("settings"); applyConfig(await native<NativeConfig>({ op: "config" })); });
    add(t("app.reloadGhosttyConfig"), async () =>
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
    case "pointer-terminal":
      document.body.classList.toggle("term-pointer", !!event.on);
      break;
    case "focus": {
      const tab = event.id ? tabFor(event.id) : undefined;
      if (tab) {
        const changed = active !== tab || tab.focused !== event.id;
        if (active !== tab) revealTab(tab);
        active = tab; rememberFavoriteInstance(tab);
        tab.focused = event.id!;
        clearViewed(true);
        syncOutlines();
        if (changed) { renderTabs(); filesPanel.sync(); await filesPanel.cwdChanged(s!.cwd); }
      }
      break;
    }
    case "cwd":
      if (s && event.path && event.path !== s.cwd) {
        s.cwd = event.path;
        renderTabs();
        if (event.id === active?.focused) await filesPanel.cwdChanged(event.path);
      }
      break;
    case "bell":
      if (s) raiseAlert(s.id, "signal", t("app.alertBell"), "");
      break;
    case "notify":
      if (s) raiseAlert(s.id, "signal", event.title || t("app.alertNotification"), event.body || "");
      break;
    case "title":
      if (s) {
        if (titleSpinnerStopped(s.title, event.title || "")) raiseAlert(s.id, "signal", t("app.alertStopped"), "");
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
        // tmux 頁籤以命令啟動，Ghostty 會強制 wait-after-command；session 結束就直接關閉，不等按鍵。
        if (s.tmuxSession) {
          if (s.openedAt && Date.now() - s.openedAt < 5000) notify(t("app.tmuxExitedEarly", { command: s.command || "" }));
          await destroy(s.id, true);
          break;
        }
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
      await filesPanel.toggle();
      break;
    case "quicklook-key":
    case "quicklook-closed":
      filesPanel.handleEvent(event);
      break;
    case "toggle-palette":
      // 待處理浮層開著時，⌘⇧P 只負責關掉它。
      if (attentionDrop.isOpen()) attentionDrop.close();
      else snippets.toggle();
      break;
    case "toggle-sidebar":
      toggleDrawerPanel(drawerState.panel || drawerState.lastPanel);
      break;
    case "new-tab":
      // 繼承來源 surface 的設定失敗時（例如分割中的收藏終端機），退回只用目錄開新頁籤。
      try { await newSurface(s?.cwd || currentSurface()?.cwd || defaultPath(), event.id || active?.focused); }
      catch (error) { console.warn("new-tab 繼承來源失敗，改用目錄開啟", error); await newSurface(s?.cwd || currentSurface()?.cwd || defaultPath()); }
      break;
    case "duplicate-tab":
      // 快捷鍵事件不帶 surface id，用目前聚焦的終端機。
      if (active) await duplicateTab(active, currentSurface()?.cwd || defaultPath());
      break;
    case "new-window":
      await invoke("new_window", {
        path: s?.cwd || defaultPath(),
        quick: false,
      });
      break;
    case "quick-terminal":
      await invoke("new_window", {
        path: defaultPath(),
        quick: true,
      });
      break;
    case "split":
      if (s) await newSurface(s.cwd, s.id, event.direction);
      break;
    case "close-surface":
      if (s) await requestClose([s.id], async (force) => {
        const tab = tabFor(s.id);
        await destroy(s.id, force);
        // 只剩最後一個分割時整個頁籤會關閉，保留收藏原本的版面。
        if (tab && tabs.includes(tab)) await syncFavoriteLayout(tab);
      });
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
      if (active && !active.parentId) {
        const folder = tabFolder(active);
        if (folder && active.favoriteId) {
          // Grouped: move the favorite, since favorite order is the tab order.
          const siblings = folderFavorites(folder.id).filter((item) => item.id !== active!.favoriteId);
          const from = folderFavorites(folder.id).findIndex((item) => item.id === active!.favoriteId);
          const to = Math.max(0, Math.min(siblings.length, from + event.value!));
          await persistFavorites(moveGroupedItem(favorites, active.favoriteId, folder.id, siblings[to]?.id));
          renderTabs();
          break;
        }
        const arranged = orderedTabs().filter((tab) => !tab.parentId);
        const loose = arranged.filter((tab) => !tabFolder(tab)).length;
        const i = arranged.indexOf(active), next = Math.max(0, Math.min(loose - 1, i + event.value!));
        arranged.splice(i, 1); arranged.splice(next, 0, active); tabs = [...arranged, ...tabs.filter((tab) => tab.parentId)];
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
      $("search-status").textContent = t("app.searchResult", { value: event.value ?? "" });
      break;
    case "search-selected":
      $("search-status").textContent = t("app.searchResult", { value: event.value ?? "" });
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
action("first", () => pick("terminal"));
action("files-toggle", () => filesPanel.toggleOpen());
action("new", () => popupMenu([
  { text: t("app.openFromCurrent"), action: () => newSurface(defaultPath()) },
  { text: t("app.chooseFolderEllipsis"), action: () => pick("terminal") },
]));
action("favorite-group-add", () => createFolder());
action("favorite-add", () => {
  const options = $("favorite-add-options"); options.hidden = !options.hidden;
  refreshFavoriteCurrentTab();
  $("favorite-current-tab").hidden = !active;
});
function refreshFavoriteCurrentTab() {
  $("favorite-current-tab").textContent = active ? t("app.favoriteCurrentTab", { name: tabName(active) }) : "";
}
action("favorite-current-tab", () => { $("favorite-add-options").hidden = true; if (active) newFavorite({ tabId: active.id }); });
action("favorite-from-dir", () => { $("favorite-add-options").hidden = true; edit().catch(notify); });
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
action("open-rules", () => invoke("prompt_rules_open"));
{
  const placement = $("window-placement") as HTMLSelectElement;
  invoke<string>("window_placement").then((mode) => { placement.value = mode; }).catch(() => {});
  placement.addEventListener("change", () => { invoke("set_window_placement", { mode: placement.value }).catch(notify); });
}
{
  const mode = $("control-mode") as HTMLSelectElement;
  invoke<string>("control_mode").then((current) => { mode.value = current; }).catch(() => {});
  mode.addEventListener("change", () => { invoke("set_control_mode", { mode: mode.value }).catch(notify); });
}
// agent skill：只在使用者按下按鈕時才寫入；不是 HiGhostty 安裝的同名檔案不覆蓋（Rust 端判斷）。
const skillState = (state: string) => (["missing", "current", "outdated", "foreign"].includes(state) ? t(`settings.skill.${state}`) : state);
type SkillRow = { id: string; label: string; path: string; state: string };
const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
async function refreshSkillStatus() {
  const rows = await invoke<SkillRow[]>("skill_status");
  $("skill-list").innerHTML = rows
    .map((row) => `<div class="skill-row"><strong>${esc(row.label)}</strong><span class="help" title="${esc(row.path)}">${skillState(row.state)}</span><div class="button-row"><button class="ghost-btn" data-skill="install" data-target="${row.id}"${row.state === "foreign" || row.state === "current" ? " disabled" : ""}>${row.state === "outdated" ? t("settings.skill.update") : t("settings.skill.install")}</button><button class="ghost-btn" data-skill="uninstall" data-target="${row.id}"${row.state === "missing" || row.state === "foreign" ? " disabled" : ""}>${t("settings.skill.remove")}</button></div></div>`)
    .join("");
}
$("skill-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-skill]");
  if (!button) return;
  const target = button.dataset.target!;
  const install = button.dataset.skill === "install";
  Promise.resolve()
    .then(() => invoke(install ? "skill_install" : "skill_uninstall", { target }))
    .then(refreshSkillStatus)
    .then(() => { $("skill-status").textContent = install ? t("settings.skill.written") : t("settings.skill.removed"); })
    .catch(notify);
});
action("copy-skill", async () => { await native({ op: "files-pasteboard-text", text: await invoke<string>("skill_text") }); $("skill-status").textContent = t("settings.skill.copied"); });
action("reload-rules", () => loadPromptRules());
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
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.isComposing || dialogsOpen() || attentionDrop.isOpen()) return;
  // Inputs with their own Escape behavior handle it; don't also close drawers.
  if (event.target instanceof Element && event.target.closest(".inline-rename, #search, #files, #palette-drop, #attention-drop")) return;
  if (!$("favorite-add-options").hidden) { event.preventDefault(); $("favorite-add-options").hidden = true; return; }
  if (detail()) { event.preventDefault(); backDetail(); }
  else if (drawerState.panel) { event.preventDefault(); closeDrawers(); }
}, true);
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", scheduleLayout);
  if (dialog.id === "confirm") dialog.addEventListener("close", () => setConfirmText());
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
  await initI18n();
  $("panel-settings").querySelector(".settings-content")!.prepend(createLanguageSection({
    native,
    notify,
    openEditor: (code) => showDetail({ kind: "edit-locale", code }),
  }));
  // 語言切換：重畫所有由程式產生的文字。開著的編輯器不重建（會丟掉未存的輸入）。
  onLocaleChange(() => {
    if (!detail()?.kind.startsWith("edit-")) renderedDetail = undefined;
    renderTabs();
    renderFavorites();
    renderDrawer();
    refreshSnippetList();
    renderAttention();
    renderConfigText();
    refreshFavoriteCurrentTab();
    loadPromptRules().catch(() => {});
    if (drawerState.panel === "settings") refreshSkillStatus().catch(() => {});
  });
  try { collapsedWorkspaceGroups = new Set(JSON.parse(localStorage.getItem("workspace-collapsed-groups") || "[]")); } catch {}
  const savedPanel = localStorage.getItem("drawer-panel") as Panel | null;
  // The old directories panel moved to the per-tab files panel.
  drawerState.lastPanel = savedPanel && savedPanel !== ("directories" as string) ? savedPanel : "workspace";
  for (const [key, panel] of [["rail-workspace", "workspace"], ["rail-favorites", "favorites"], ["rail-snippets", "snippets"], ["rail-settings", "settings"]] as [string, Panel][]) {
    $(key).onclick = () => {
      if (panel === "settings" && drawerState.panel !== panel) native<NativeConfig>({ op: "config" }).then(applyConfig).catch(notify);
      if (panel === "settings" && drawerState.panel !== panel) loadPromptRules().catch(notify);
      if (panel === "settings" && drawerState.panel !== panel) refreshSkillStatus().catch(notify);
      toggleDrawerPanel(panel);
    };
  }
  $("workspace").append(snippets.element, attentionDrop.element);
  $("rail-attention").onclick = toggleAttention;
  $("snippet-add").onclick = () => snippets.newScoped(currentSurface()?.cwd || "global");
  snippets.store.onChange(() => { refreshSnippetList(); renderDetailIfSnippet(); });
  await snippets.store.load();
  await listen<FavoritesDocument>("group-favorites-changed", ({ payload }) => {
    applyFavoritesDocument(payload);
    renderTabs();
    renderDrawer();
    renderTabs();
  });
  await win.onDragDropEvent(async ({ payload }) => {
    const dpr = window.devicePixelRatio || 1;
    const elementAt = (position: { x: number; y: number }) => document.elementFromPoint(position.x / dpr, position.y / dpr);
    const targetAt = (position: { x: number; y: number }): { kind: string; groupId?: string; item?: Element } => {
      const element = elementAt(position);
      if (filesPanel.dropTarget(element)) return { kind: "files" };
      // Group rows/blocks add the directory to that specific group.
      const workspaceGroup = element?.closest<HTMLElement>("#tabs [data-group-id]");
      if (workspaceGroup) return { kind: "workspace-group", groupId: workspaceGroup.dataset.groupId, item: workspaceGroup };
      const favoritesGroup = element?.closest<HTMLElement>("#favorites .group-row");
      if (favoritesGroup) return { kind: "favorites-group", groupId: favoritesGroup.dataset.groupId, item: favoritesGroup };
      if (element?.closest("#favorites, #rail-favorites")) return { kind: "favorites" };
      if (element?.closest("#panel-snippets, #rail-snippets")) return { kind: "snippets" };
      // Dropping on an open favorite group adds the directory to that group.
      const top = detail();
      if (element?.closest("#drawer-detail") && top?.kind === "group") return { kind: "group", groupId: top.groupId };
      if (element?.closest("#panel-workspace")) return { kind: "workspace-panel" };
      if (element?.closest("#workspace")) return { kind: "workspace" };
      return { kind: "" };
    };
    const clearDropHighlight = () => {
      $("workspace").classList.remove("drop-target");
      $("favorites").classList.remove("drop-target-list");
      $("panel-snippets").classList.remove("drop-target-list");
      $("drawer-detail").classList.remove("drop-target-list");
      $("panel-workspace").classList.remove("drop-target-list");
      for (const el of document.querySelectorAll(".drop-target-item")) el.classList.remove("drop-target-item");
      filesPanel.highlightDrop(undefined);
    };
    if (payload.type === "enter" || payload.type === "over") {
      const { kind, item } = targetAt(payload.position);
      clearDropHighlight();
      $("workspace").classList.toggle("drop-target", kind === "workspace");
      $("favorites").classList.toggle("drop-target-list", kind === "favorites");
      $("panel-snippets").classList.toggle("drop-target-list", kind === "snippets");
      $("drawer-detail").classList.toggle("drop-target-list", kind === "group");
      $("panel-workspace").classList.toggle("drop-target-list", kind === "workspace-panel");
      item?.classList.add("drop-target-item");
      filesPanel.highlightDrop(filesPanel.dropTarget(elementAt(payload.position)));
      return;
    }
    clearDropHighlight();
    if (payload.type !== "drop") return;
    // Files dropped on the files panel are copied into the folder under the pointer.
    const filesDestination = filesPanel.dropTarget(elementAt(payload.position));
    if (filesDestination) { await filesPanel.drop(payload.paths, filesDestination); return; }
    const { kind: target, groupId } = targetAt(payload.position);
    for (const path of payload.paths) {
      try {
        const directory = await invoke<string>("resolve_path", { path, base: homePath });
        if (target === "snippets") snippets.newScoped(directory);
        else if (target === "favorites" || target === "group" || target === "favorites-group" || target === "workspace-group") {
          const item: WorkspaceFavorite = { id: crypto.randomUUID(), kind: "tab", name: name(directory), tab: { paths: [directory], tree: { kind: "leaf", id: "0" }, focused: 0 }, groupId };
          await persistFavorites([...favorites, item]);
          renderFavorites();
          if (target === "workspace-group") await openFavorite(item);
        } else if (target === "workspace" || target === "workspace-panel") await newSurface(directory);
      } catch (error) {
        notify(t("app.skipFolder", { path, error: String(error) }));
      }
    }
  });
  await listen<NativeEvent>("native-event", ({ payload }) => {
    eventQueue = eventQueue.then(() => handleEvent(payload)).catch(notify);
  });
  await listen<ControlRequest>("control-request", ({ payload }) => { handleControl(payload).catch(notify); });
  applyConfig(await native<NativeConfig>({ op: "init" }));
  initialized = true;
  keepTerminalFocus();
  // Directories dropped on the app icon (Finder/Dock); may arrive before or after startup.
  const openPending = async () => {
    for (const path of await invoke<string[]>("take_pending_open_paths")) {
      try { await newSurface(path); } catch (error) { notify(t("app.skipFolder", { path, error: String(error) })); }
    }
  };
  // A standalone preview window sent its file back ("放回頁籤"): show it in the tab it came from.
  await listen<{ path: string; tab?: string | null }>("preview-dock", (event) => {
    const tab = tabs.find((item) => item.id === event.payload.tab) ?? active;
    if (!tab) return notify(t("app.noTabForPreview"));
    showPreview(tab, event.payload.path);
    if (tab !== active) activate(tab).catch(notify);
  });
  // Messages from a popped-out files panel (files-window.ts).
  type FilesMessage = { tab: string; files?: FilesState; close?: boolean; op?: string; path?: string; directory?: string; command?: string; text?: string };
  await listen<FilesMessage>("files-state", ({ payload }) => {
    const tab = tabs.find((item) => item.id === payload.tab);
    if (!tab?.files?.detached || !payload.files) return;
    tab.files = { ...payload.files, open: true, full: false, detached: true };
    rememberFilesState(tab);
  });
  await listen<FilesMessage>("files-dock", ({ payload }) => {
    const tab = tabs.find((item) => item.id === payload.tab);
    if (!tab || closing || sessionFrozen) return;
    dockFiles(tab, payload.files, !!payload.close);
    if (!payload.close) activate(tab).catch(notify);
  });
  await listen<FilesMessage>("files-request", ({ payload }) => {
    eventQueue = eventQueue.then(async () => {
      const tab = tabs.find((item) => item.id === payload.tab);
      if (!tab) return;
      if (payload.op === "open-terminal" && payload.path) await newSurface(payload.path);
      else if (payload.op === "edit" && payload.directory) { await activate(tab); await newSurface(payload.directory, tab.focused, 0, { command: payload.command, commandInShell: true }); }
      else if (payload.op === "insert" && payload.text) await native({ op: "insert-text", id: tab.focused, text: payload.text });
      else if (payload.op === "preview" && payload.path) { showPreview(tab, payload.path); if (tab !== active) await activate(tab); }
      else if (payload.op === "follow-preview" && payload.path && tab.preview && tab.preview.path !== payload.path) showPreview(tab, payload.path);
    }).catch(notify);
  });
  await listen("open-paths", () => { eventQueue = eventQueue.then(openPending).catch(notify); });
  // Convert old group favorites once and write the new format back.
  if (applyFavoritesDocument(await invoke<FavoritesDocument>("group_favorites")))
    await persistFavorites(favorites, folders).catch(notify);
  renderFavorites();
  homePath = await invoke<string>("home");
  await loadPromptRules();
  await restoreSession();
  eventQueue = eventQueue.then(openPending).catch(notify);
  await win.onCloseRequested((event) => {
    event.preventDefault();
    shutdown().catch(notify);
  });
  let openOnStart = true;
  try { openOnStart = localStorage.getItem("drawer-open") !== "false"; } catch {}
  if (openOnStart) drawerState = openPanel(drawerState, drawerState.lastPanel || "workspace");
  wireDrawerResizer();
  renderDrawer();
  renderTabs();
  setInterval(() => {
    if (document.visibilityState === "visible" && !closing)
      refreshCwd().catch(notify);
  }, 1000);
  $("bell-btn").onclick = toggleAttention;
  window.addEventListener("focus", () => clearViewed());
  setInterval(() => {
    if (document.visibilityState === "visible" && !closing) scanAttention().catch(() => {});
  }, 1500);
}
// agent 控制指令（highostty ctl）。Rust 把請求廣播給所有視窗，每個視窗各回一次並宣告 claim：
// owner（這是我的事）、part（跨視窗列表中我這一份）、none（與我無關）；指令名稱、參數、權限與 claim 的純邏輯在 control.ts。
type ControlRequest = { reqId: string; mode: ControlMode; caller: unknown; argv: unknown; input?: unknown };
async function handleControl({ reqId, mode, caller, argv, input }: ControlRequest) {
  const callerId = resolveCaller(caller, surfaces.values());
  const parsed = parseArgv(argv);
  let claim: Claim = callerId ? "owner" : "none";
  let reply: Reply | null = null;
  if (!parsed.ok) reply = callerId ? parsed.reply : null;
  else {
    const denied = authorize(mode, parsed.parsed.op);
    if (denied) reply = callerId ? denied : null;
    else {
      claim = claimFor(parsed.parsed, { callerHere: !!callerId, ownsSurface: (id) => surfaces.has(id) });
      if (claim !== "none") reply = await runControl({ caller: callerId, mode, input }, parsed.parsed).catch((error) => errReply("failed", String(error)));
    }
  }
  await invoke("control_reply", { reqId, window: win.label, claim, reply });
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Poll until `step` returns something, or the limit passes (undefined).
async function poll<T>(limit: number, step: () => Promise<T | undefined>): Promise<T | undefined> {
  const end = Date.now() + limit;
  for (;;) {
    const hit = await step();
    if (hit !== undefined) return hit;
    const left = end - Date.now();
    if (left <= 0) return undefined;
    await pause(Math.min(500, left));
  }
}
// The agent in a terminal and its state, or undefined when no agent is detected there.
async function pickAgent(id: string) {
  const screen = (await scanScreens([id]))[id];
  return screen?.agent ? { screen, state: agentState(screen.text, surfaces.get(id)?.title ?? "", promptRules) } : undefined;
}
// Poll until `accept` holds on two readings in a row; "gone" when the agent is no longer there.
async function awaitState(id: string, limit: number, accept: (state: AgentState) => boolean): Promise<AgentState | "gone" | undefined> {
  let previous: AgentState | undefined;
  return poll<AgentState | "gone">(limit, async () => {
    const seen = await pickAgent(id);
    if (!seen) return "gone";
    const done = confirmedState(previous, seen.state, accept);
    previous = seen.state;
    return done ? seen.state : undefined;
  });
}
const readText = async (id: string, scrollback: boolean) => (await native<{ text: string }>({ op: "read", id, scrollback })).text;
// shell 在提示字元、前景沒有程式。tmux 頁籤的原生前景只是 tmux client，改問 tmux 窗格正在跑的指令。
async function shellIdle(id: string): Promise<boolean> {
  const surface = surfaces.get(id);
  if (!surface || surface.exited) return false;
  if (surface.tmuxSession) {
    const command = (await invoke<Record<string, string>>("tmux_panes").catch(() => ({} as Record<string, string>)))[surface.tmuxSession];
    return !!command && isShellName(command);
  }
  return (await native<Info>({ op: "info", id })).running.length === 0;
}
async function runControl(ctx: { caller?: string; mode: ControlMode; input?: unknown }, { op, args, flags, rest }: Parsed): Promise<Reply> {
  const here = flags.here === true;
  // `--here` keeps only the window the caller is in; other windows contribute nothing.
  const visibleTabs = here && !ctx.caller ? [] : tabs;
  const describe = (id: string) => ({ id, cwd: surfaces.get(id)?.cwd, title: surfaces.get(id)?.title, exited: !!surfaces.get(id)?.exited, tmux: !!surfaces.get(id)?.tmuxSession, caller: id === ctx.caller });
  switch (op.name) {
    case "ping": return okReply({ pong: true, mode: ctx.mode });
    case "whoami": {
      const tab = ctx.caller ? tabFor(ctx.caller) : undefined;
      return okReply({ window: win.label, surface: ctx.caller, tab: tab?.id, title: tab && tabName(tab), cwd: ctx.caller && surfaces.get(ctx.caller)?.cwd });
    }
    case "help": return okReply(helpResult());
    case "window list": return okReply({ focused: document.hasFocus(), tabs: tabs.length, active: active?.id, caller: !!ctx.caller });
    case "tab list": return okReply({ tabs: visibleTabs.map((tab) => ({ id: tab.id, title: tabName(tab), active: tab === active, surfaces: leaves(tab.tree).map(describe) })) });
    case "agent list": {
      const owners = new Map(visibleTabs.flatMap((tab) => leaves(tab.tree).map((id) => [id, tab] as const)));
      const ids = [...owners.keys()].filter((id) => !surfaces.get(id)?.exited);
      const found = ids.length ? await scanScreens(ids) : {};
      return okReply({ agents: Object.entries(found).filter(([, screen]) => screen.agent).map(([id, screen]) => ({ surface: id, tab: owners.get(id)?.id, cwd: surfaces.get(id)?.cwd, agent: screen.agent, state: agentState(screen.text, surfaces.get(id)?.title ?? "", promptRules), caller: id === ctx.caller })) });
    }
    case "surface read": {
      const text = await readText(args.id, flags.scrollback === true);
      const lines = typeof flags.lines === "number" ? Math.min(Math.max(1, flags.lines), 5000) : undefined;
      return okReply({ surface: args.id, text: lines ? tailLines(text, lines) : text });
    }
    case "surface wait": {
      const made = makeMatcher(flags);
      if (!made.ok) return made.reply;
      const lines = typeof flags.lines === "number" ? flags.lines : 200;
      const line = await poll(waitLimit(flags.timeout), async () => findMatch(tailLines(await readText(args.id, true), lines), made.matcher));
      return line === undefined ? errReply("timeout", "逾時，輸出沒有出現") : okReply({ surface: args.id, matched: line });
    }
    case "agent wait": {
      const until = typeof flags.until === "string" ? flags.until : undefined;
      if (until && !(WAIT_STATES as readonly string[]).includes(until)) return errReply("bad_args", `--until 必須是 ${WAIT_STATES.join("／")}`);
      const state = await awaitState(args.id, waitLimit(flags.timeout), (current) => waitSatisfied(current, until));
      if (state === "gone") return errReply("not_found", "這個終端機沒有偵測到 agent");
      return state === undefined ? errReply("timeout", "逾時，agent 狀態沒有達成") : okReply({ surface: args.id, state });
    }
    case "agent start": {
      const made = agentCommand(args.kind, rest);
      if (!made.ok) return made.reply;
      const cwd = typeof flags.cwd === "string" ? flags.cwd : (ctx.caller && surfaces.get(ctx.caller)?.cwd) || homePath || "~";
      const opened = await newSurface(cwd, undefined, undefined, { command: made.line, commandInShell: true, background: flags.focus !== true });
      let previousText: string | undefined;
      const ready = await poll(waitLimit(flags.timeout), async () => {
        const seen = await pickAgent(opened.surface);
        const done = !!seen && startReady(previousText, seen.screen.text, seen.state);
        previousText = seen?.screen.text;
        return done ? seen : undefined;
      });
      if (!ready) return errReply("timeout", `逾時：頁籤已開啟（surface ${opened.surface}），但 agent 還沒就緒；可用 surface read 查看`);
      return okReply({ ...opened, window: win.label, agent: ready.screen.agent, state: ready.state, ready: ready.state === "idle" });
    }
    case "agent prompt": {
      if (args.id === ctx.caller) return errReply("bad_args", "不能對自己所在的終端機送 prompt");
      const problem = promptProblem(args.text);
      if (problem) return errReply("bad_args", problem);
      const before = await pickAgent(args.id);
      if (!before) return errReply("not_found", "這個終端機沒有偵測到 agent；一般命令請用 surface run");
      // Typing into an open question would answer it; that is the user's call, not another agent's.
      if (before.state === "blocked") return errReply("agent_blocked", "agent 正在等人回答；請先用 surface read 查看並詢問使用者，不要代答。沒有送出任何輸入");
      await native({ op: "insert-text", id: args.id, text: args.text });
      await native({ op: "key", id: args.id, key: "enter" });
      if (flags.wait !== true) return okReply({ surface: args.id, submitted: true, state: before.state });
      const limit = waitLimit(flags.timeout);
      const started = Date.now();
      if (before.state !== "working") {
        const seen = await awaitState(args.id, Math.min(PROMPT_STALL_MS, limit), (current) => current !== "idle");
        if (seen === "gone") return errReply("not_found", "agent 已不在這個終端機");
        if (seen === undefined) return errReply("agent_prompt_stalled", "已送出，但 5 秒內沒有看到 agent 開始工作或提問；不要重送，先用 surface read 確認");
      }
      const state = await awaitState(args.id, Math.max(0, limit - (Date.now() - started)), (current) => current !== "working");
      if (state === "gone") return errReply("not_found", "agent 已不在這個終端機");
      return state === undefined ? errReply("timeout", "已送出，但逾時前 agent 還沒完成這一輪；不要重送，之後再用 agent wait 或 surface read 確認") : okReply({ surface: args.id, submitted: true, state });
    }
    case "agent keys": {
      if (args.id === ctx.caller) return errReply("bad_args", "不能對自己所在的終端機送按鍵");
      const keys = rest.map((key) => key.toLowerCase());
      const problem = keysProblem(keys);
      if (problem) return errReply("bad_args", problem);
      if (!(await pickAgent(args.id))) return errReply("not_found", "這個終端機沒有偵測到 agent；一般按鍵請用 surface key");
      for (const [index, key] of keys.entries()) {
        if (index) await pause(60);
        await native({ op: "key", id: args.id, key });
      }
      return okReply({ surface: args.id, keys });
    }
    case "alert raise": {
      if (!ctx.caller) return errReply("not_found", "找不到呼叫者的終端機");
      const made = alertInput(flags);
      if (!made.ok) return made.reply;
      if (viewing(ctx.caller)) return okReply({ raised: false, reason: "使用者正在看這個終端機" });
      const { title, body, options } = made.input;
      raiseAlert(ctx.caller, "agent", title, body, undefined, { kind: "input", label: title, question: body || title, options });
      return okReply({ raised: true });
    }
    case "alert clear": {
      if (!ctx.caller) return errReply("not_found", "找不到呼叫者的終端機");
      const had = attention.get(ctx.caller)?.source === "agent";
      setAttention(clearSource(attention, ctx.caller, "agent"));
      return okReply({ cleared: had });
    }
    case "tab status": {
      const tab = ctx.caller ? tabFor(ctx.caller) : undefined;
      if (!tab) return errReply("not_found", "找不到呼叫者的頁籤");
      const text = statusText(args.text);
      if (flags.clear !== true && !text) return errReply("bad_args", "需要 <text> 或 --clear");
      tab.status = flags.clear === true ? undefined : text;
      renderTabs();
      return okReply({ tab: tab.id, status: tab.status ?? null });
    }
    case "preview open": {
      const tab = ctx.caller ? tabFor(ctx.caller) : undefined;
      if (!tab) return errReply("not_found", "找不到呼叫者的頁籤");
      const picked = previewSide(flags);
      if (!picked.ok) return picked.reply;
      const base = (ctx.caller && surfaces.get(ctx.caller)?.cwd) || homePath || undefined;
      const [path] = await invoke<string[]>("control_resolve_files", { paths: [args.path], base });
      try { await invoke("preview_stat", { path }); } catch (error) { return errReply("bad_args", `${args.path}：${String(error)}`); }
      showPreview(tab, path, picked.side);
      return okReply({ path, side: tab.preview!.side, kind: previewKind(path) });
    }
    case "preview window": {
      const base = (ctx.caller && surfaces.get(ctx.caller)?.cwd) || homePath || undefined;
      const [path] = await invoke<string[]>("control_resolve_files", { paths: [args.path], base });
      try { await invoke("preview_stat", { path }); } catch (error) { return errReply("bad_args", `${args.path}：${String(error)}`); }
      const tab = ctx.caller ? tabFor(ctx.caller) : undefined;
      const label = await invoke<string>("open_preview_window", { path, focus: false, origin: { window: win.label, tab: tab?.id } });
      return okReply({ path, window: label, kind: previewKind(path) });
    }
    case "preview close": {
      const tab = ctx.caller ? tabFor(ctx.caller) : undefined;
      if (!tab) return errReply("not_found", "找不到呼叫者的頁籤");
      const had = !!tab.preview;
      closePreview(tab);
      return okReply({ closed: had });
    }
    case "preview status": {
      const tab = ctx.caller ? tabFor(ctx.caller) : undefined;
      if (!tab) return errReply("not_found", "找不到呼叫者的頁籤");
      return okReply({ preview: tab.preview ? { path: tab.preview.path, side: tab.preview.side, kind: previewKind(tab.preview.path) } : null });
    }
    case "files reveal":
    case "files quicklook": {
      const base = (ctx.caller && surfaces.get(ctx.caller)?.cwd) || homePath || undefined;
      const paths = await invoke<string[]>("control_resolve_files", { paths: rest, base });
      await native(op.name === "files reveal" ? { op: "files-reveal", paths } : { op: "files-quicklook", paths, index: 0 });
      return okReply({ paths });
    }
    case "snippet add": {
      const made = snippetInput(flags, ctx.caller ? surfaces.get(ctx.caller)?.cwd : undefined);
      if (!made.ok) return made.reply;
      const same = snippets.store.all().find((item) => item.name === made.input.name && item.scope === made.input.scope && item.text === made.input.text);
      if (same) return okReply({ id: same.id, name: same.name, scope: same.scope, created: false });
      // A stale revision (another window saved first) refreshes the list; one retry is enough.
      const saved = await snippets.store.save(made.input).catch(() => snippets.store.save(made.input));
      return okReply({ id: saved.id, name: saved.name, scope: saved.scope, created: true });
    }
    case "tab new": {
      const line = rest.length ? commandLine(rest) : "";
      const problem = line ? commandProblem(line) : undefined;
      if (problem) return errReply("bad_args", problem);
      const cwd = typeof flags.cwd === "string" ? flags.cwd : (ctx.caller && surfaces.get(ctx.caller)?.cwd) || homePath || "~";
      const tmux = flags.tmux === true;
      const background = flags.focus !== true;
      const opened = await newSurface(cwd, undefined, undefined, { command: line || undefined, commandInShell: !!line && !tmux, tmux, background });
      return okReply({ ...opened, window: win.label, background });
    }
    case "surface run": {
      const line = commandLine(rest);
      const problem = commandProblem(line);
      if (problem) return errReply("bad_args", problem);
      if (!(await shellIdle(args.id))) return errReply("busy", "終端機的 shell 不在提示字元（有程式在前景執行，或已結束）；先用 surface read 確認");
      await native({ op: "insert-text", id: args.id, text: line });
      await native({ op: "key", id: args.id, key: "enter" });
      return okReply({ surface: args.id, command: line });
    }
    case "surface key": {
      const key = args.key.toLowerCase();
      if (!validKey(key)) return errReply("bad_args", `不支援的按鍵「${args.key}」；用法：${usage(op)}`);
      await native({ op: "key", id: args.id, key });
      return okReply({ surface: args.id, key });
    }
    default: return errReply("unknown_op", `尚未實作：${op.name}`);
  }
}
start().catch(notify);
