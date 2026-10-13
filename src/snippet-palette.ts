// ⌘⇧P snippet palette: store, drop-down UI and the form shared with the side
// panel editor. Matching/ordering rules are pure and live in snippets.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  applicable,
  expand,
  filterSnippets,
  GLOBAL,
  groupByScope,
  isGlobal,
  rememberRecent,
  scopeChoices,
  scopeLabel,
  type Match,
  type Snippet,
  type SnippetsDocument,
} from "./snippets";

export type SnippetsHost = {
  native: <T = Record<string, unknown>>(request: Record<string, unknown>) => Promise<T>;
  // cwd of the active tab's focused terminal.
  cwd(): string | undefined;
  home(): string;
  insertIntoTerminal(text: string): Promise<void>;
  focusTerminal(): void;
  // Open the side-panel editor (empty id = new snippet).
  editInDrawer(id?: string, scope?: string, text?: string): void;
  notify(error: unknown): void;
  // The files panel in full mode hides the terminals, so there is nothing to insert into.
  canInsert(): boolean;
};
type Draft = { name?: string; text?: string; scope?: string };

const RECENT_KEY = "snippet-recent";
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

export type SnippetForm = {
  element: HTMLElement;
  // Resolves a custom directory scope to a real path; throws when it is not a directory.
  read(): Promise<Omit<Snippet, "id" | "createdAt">>;
  valid(): boolean;
  dirty(): boolean;
  focus(): void;
  onChange(fn: () => void): void;
};

export function initSnippets(host: SnippetsHost) {
  let items: Snippet[] = [];
  let revision = 0;
  let recent: string[] = [];
  try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch {}

  function apply(document: SnippetsDocument) {
    items = document.items;
    revision = document.revision;
    onItemsChanged.forEach((fn) => fn());
  }
  const onItemsChanged: (() => void)[] = [];
  async function persist(next: Snippet[]) {
    try {
      apply(await invoke<SnippetsDocument>("save_snippets", { items: next, expectedRevision: revision }));
    } catch (error) {
      // A stale revision means another window saved first; show their version.
      apply(await invoke<SnippetsDocument>("snippets"));
      throw error;
    }
  }
  const store = {
    all: () => items,
    get: (id: string) => items.find((item) => item.id === id),
    onChange: (fn: () => void) => void onItemsChanged.push(fn),
    async save(value: Omit<Snippet, "id" | "createdAt">, id?: string) {
      const existing = id ? items.find((item) => item.id === id) : undefined;
      const next: Snippet = { ...value, id: existing?.id || crypto.randomUUID(), createdAt: existing?.createdAt || Date.now() };
      await persist(existing ? items.map((item) => (item.id === next.id ? next : item)) : [...items, next]);
      return next;
    },
    remove: (id: string) => persist(items.filter((item) => item.id !== id)),
    async insert(snippet: Snippet) {
      recent = rememberRecent(recent, snippet.id);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch {}
      await host.insertIntoTerminal(expand(snippet, host.cwd() || host.home(), host.home()));
    },
    async load() {
      apply(await invoke<SnippetsDocument>("snippets"));
      await listen<SnippetsDocument>("snippets-changed", ({ payload }) => apply(payload));
    },
  };

  // ---- form shared by the palette and the side-panel editor ----
  function createForm(snippet: Snippet | undefined, draft: Draft = {}): SnippetForm {
    const form = el("div", "snippet-form");
    const field = (title: string, input: HTMLElement) => {
      const label = el("label", "field");
      label.append(document.createTextNode(title), input);
      return label;
    };
    const name = el("input"); name.value = draft.name ?? snippet?.name ?? ""; name.setAttribute("aria-label", "名稱"); name.placeholder = "例：看 git 記錄";
    const text = el("textarea", "mono"); text.rows = 4; text.value = draft.text ?? snippet?.text ?? ""; text.setAttribute("aria-label", "內容"); text.placeholder = "git log --oneline -20";
    const cwd = host.cwd();
    const scope = el("select");
    scope.add(new Option("全域（所有目錄）", GLOBAL));
    const choices = scopeChoices(cwd);
    choices.forEach((path, index) => scope.add(new Option(`${index === 0 ? "目前目錄　" : "上層　"}${scopeLabel(path, host.home())}`, path)));
    const initialScope = draft.scope ?? snippet?.scope ?? (cwd || GLOBAL);
    if (!isGlobal(initialScope) && !choices.includes(initialScope)) scope.add(new Option(scopeLabel(initialScope, host.home()), initialScope));
    scope.add(new Option("其他目錄…", "__custom__"));
    scope.value = initialScope;
    const custom = el("input", "mono"); custom.placeholder = "~/work 或絕對路徑"; custom.hidden = true; custom.setAttribute("aria-label", "目錄路徑");
    const keywords = el("input"); keywords.value = snippet?.keywords ?? ""; keywords.placeholder = "以空白分隔，輸入時可搜尋"; keywords.setAttribute("aria-label", "關鍵字");
    const run = el("input"); run.type = "checkbox"; run.checked = !!snippet?.run;
    const runLabel = el("label", "toggle"); runLabel.append(run, document.createTextNode("插入後自動執行（送出 Enter）"));
    const hint = el("p", "help", "可用變數：${cwd} 目前目錄、${dir} 目錄名、${home} 家目錄。範圍會套用到該目錄及其所有子目錄。");
    form.append(field("名稱", name), field("內容", text), field("適用目錄", scope), custom, field("關鍵字", keywords), runLabel, hint);
    const initial = JSON.stringify([name.value, text.value, scope.value, keywords.value, run.checked]);
    const current = () => JSON.stringify([name.value, text.value, scope.value, keywords.value, run.checked]);
    const listeners: (() => void)[] = [];
    const changed = () => { custom.hidden = scope.value !== "__custom__"; listeners.forEach((fn) => fn()); };
    for (const control of [name, text, scope, keywords, run, custom]) control.addEventListener("input", changed);
    scope.addEventListener("change", () => { changed(); if (!custom.hidden) custom.focus(); });
    return {
      element: form,
      valid: () => !!name.value.trim() && !!text.value.trim() && (scope.value !== "__custom__" || !!custom.value.trim()),
      dirty: () => !snippet || current() !== initial,
      focus: () => { name.focus(); name.select(); },
      onChange: (fn) => void listeners.push(fn),
      async read() {
        let resolved = scope.value;
        if (resolved === "__custom__") resolved = await invoke<string>("resolve_path", { path: custom.value.trim(), base: host.home() });
        return { name: name.value.trim(), text: text.value.replace(/\s+$/, ""), scope: resolved, keywords: keywords.value.trim() || undefined, run: run.checked || undefined };
      },
    };
  }

  // ---- drop-down palette ----
  const palette = el("div");
  palette.id = "palette-drop";
  palette.hidden = true;
  palette.setAttribute("role", "dialog");
  palette.setAttribute("aria-label", "指令片段");
  const input = el("input"); input.id = "palette-input"; input.placeholder = "輸入以搜尋片段…"; input.setAttribute("aria-label", "搜尋片段"); input.autocomplete = "off"; input.spellcheck = false;
  const add = el("button", "icon-btn", "＋"); add.title = "新增片段"; add.setAttribute("aria-label", "新增片段");
  const bar = el("div", "palette-bar"); bar.append(input, add);
  const list = el("div"); list.id = "palette-list"; list.setAttribute("role", "listbox");
  const editor = el("div", "palette-editor"); editor.hidden = true;
  const foot = el("div", "palette-foot");
  palette.append(bar, list, editor, foot);
  let results: Match[] = [];
  let selected = 0;
  let confirmDelete: string | undefined;
  let editing = false;
  let observer: ResizeObserver | undefined;

  const isOpen = () => !palette.hidden;
  function hints(...pairs: [string, string][]) {
    foot.replaceChildren();
    for (const [key, label] of pairs) { foot.append(el("kbd", "", key), el("span", "", label)); }
  }
  function highlight(target: HTMLElement, value: string, hits: number[]) {
    const set = new Set(hits);
    let run = "", marked = false;
    const flush = () => { if (!run) return; target.append(marked ? el("mark", "", run) : document.createTextNode(run)); run = ""; };
    for (let i = 0; i < value.length; i++) {
      const hit = set.has(i);
      if (hit !== marked) { flush(); marked = hit; }
      run += value[i];
    }
    flush();
  }
  function render() {
    const cwd = host.cwd();
    results = filterSnippets(applicable(items, cwd, recent), input.value);
    selected = Math.min(selected, Math.max(0, results.length - 1));
    list.replaceChildren();
    results.forEach((match, index) => {
      const row = el("div", "palette-row" + (index === selected ? " selected" : ""));
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === selected));
      const title = el("span", "palette-name");
      highlight(title, match.snippet.name, match.nameHits);
      const body = el("span", "palette-text mono", match.snippet.text.split("\n")[0] + (match.snippet.text.includes("\n") ? " …" : ""));
      const scope = el("span", "palette-scope", scopeLabel(match.snippet.scope, host.home()));
      if (match.snippet.run) title.append(el("span", "palette-run", "↵"));
      row.append(title, body, scope);
      row.onmousemove = () => { if (selected !== index) { selected = index; syncSelection(); } };
      row.onmousedown = (event) => event.preventDefault();
      row.onclick = () => chooseIndex(index, false).catch(host.notify);
      list.append(row);
    });
    if (!results.length) {
      const query = input.value.trim();
      const empty = el("div", "palette-empty", items.length ? "沒有符合的片段" : "這裡還沒有片段");
      list.append(empty);
      if (query) {
        const create = el("div", "palette-row create selected", `＋ 新增片段「${query}」`);
        create.onmousedown = (event) => event.preventDefault();
        create.onclick = () => openEditor(undefined, { name: query });
        list.append(create);
      }
    }
    confirmDelete = undefined;
    updateHints();
  }
  function updateHints() {
    hints(["↑↓", "選擇"], ["↵", "插入"], ["⌘↵", "插入並執行"], ["⌘E", "編輯"], ["⌘⌫", "刪除"], ["esc", "關閉"]);
  }
  function syncSelection() {
    list.querySelectorAll<HTMLElement>(".palette-row").forEach((row, index) => {
      row.classList.toggle("selected", index === selected);
      row.setAttribute("aria-selected", String(index === selected));
      if (index === selected) row.scrollIntoView({ block: "nearest" });
    });
  }
  async function chooseIndex(index: number, run: boolean) {
    const match = results[index];
    if (!match) {
      if (input.value.trim()) openEditor(undefined, { name: input.value.trim() });
      return;
    }
    close(false);
    try { await store.insert(run ? { ...match.snippet, run: true } : match.snippet); }
    finally { host.focusTerminal(); }
  }
  // Keep the native terminals from covering the palette (see docs/snippet-palette.md).
  function reportCutout(restoreFocus = false) {
    const box = palette.getBoundingClientRect();
    const open = isOpen() && box.height > 0;
    host.native({ op: "overlay-cutout", x: box.x - 8, y: box.y - 8, width: open ? box.width + 16 : 0, height: open ? box.height + 24 : 0, viewportWidth: window.innerWidth, restoreFocus }).catch(host.notify);
  }
  async function open() {
    if (isOpen()) return;
    palette.hidden = false;
    input.value = "";
    selected = 0;
    closeEditor();
    render();
    observer = new ResizeObserver(() => reportCutout());
    observer.observe(palette);
    reportCutout();
    await host.native({ op: "focus-web" });
    // Closed while focus-web was in flight: don't leave focus stuck in the WebView.
    if (!isOpen()) { host.focusTerminal(); return; }
    input.focus();
  }
  function close(refocus = true) {
    if (!isOpen()) return;
    observer?.disconnect();
    palette.hidden = true;
    closeEditor();
    reportCutout(refocus);
    if (refocus) host.focusTerminal();
  }
  function closeEditor() {
    editing = false;
    editor.hidden = true;
    editor.replaceChildren();
    list.hidden = false;
    bar.hidden = false;
  }
  function openEditor(snippet: Snippet | undefined, draft: Draft = {}) {
    editing = true;
    list.hidden = true;
    bar.hidden = true;
    editor.hidden = false;
    editor.replaceChildren();
    const form = createForm(snippet, draft);
    const title = el("strong", "palette-editor-title", snippet ? "編輯片段" : "新增片段");
    const save = el("button", "primary-btn", snippet ? "儲存" : "新增");
    const cancel = el("button", "ghost-btn", "取消");
    const actions = el("div", "palette-editor-actions");
    actions.append(cancel, save);
    const submit = async () => {
      if (!form.valid() || !form.dirty()) return;
      try { await store.save(await form.read(), snippet?.id); closeEditor(); render(); input.focus(); }
      catch (error) { host.notify(error); }
    };
    const update = () => { save.disabled = !form.valid() || !form.dirty(); };
    form.onChange(update);
    update();
    save.onclick = () => { submit(); };
    cancel.onclick = () => { closeEditor(); render(); input.focus(); };
    editor.append(title, form.element, actions);
    editor.onkeydown = (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel.click(); }
      // ⌘Enter saves; plain Enter stays a newline in the content box.
      else if (event.key === "Enter" && (event.metaKey || (event.target instanceof HTMLInputElement && !event.shiftKey))) { event.preventDefault(); submit(); }
    };
    hints(["⌘↵", "儲存"], ["esc", "取消"]);
    form.focus();
  }

  input.addEventListener("input", () => { selected = 0; render(); });
  add.onclick = () => openEditor(undefined, { name: input.value.trim() || undefined });
  palette.addEventListener("keydown", (event) => {
    if (editing || event.isComposing) return;
    const move = (delta: number) => {
      event.preventDefault();
      if (!results.length) return;
      selected = (selected + delta + results.length) % results.length;
      confirmDelete = undefined;
      syncSelection();
    };
    switch (event.key) {
      case "ArrowDown": return move(1);
      case "ArrowUp": return move(-1);
      case "Escape": event.preventDefault(); event.stopPropagation(); close(); return;
      case "Enter": event.preventDefault(); chooseIndex(selected, event.metaKey).catch(host.notify); return;
    }
    if (event.metaKey && event.key.toLowerCase() === "e" && results[selected]) { event.preventDefault(); openEditor(results[selected].snippet); }
    if (event.metaKey && event.key === "Backspace" && results[selected]) {
      event.preventDefault();
      const target = results[selected].snippet;
      if (confirmDelete !== target.id) { confirmDelete = target.id; hints(["⌘⌫", `再按一次刪除「${target.name}」`], ["esc", "取消"]); return; }
      store.remove(target.id).then(render).catch(host.notify);
    }
  });
  // Clicking outside the palette closes it.
  document.addEventListener("mousedown", (event) => { if (isOpen() && event.target instanceof Node && !palette.contains(event.target)) close(!(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]"))); }, true);
  window.addEventListener("blur", () => { if (isOpen() && !editing) close(false); });
  store.onChange(() => { if (isOpen() && !editing) render(); });

  // ---- side-panel list ----
  const COLLAPSED_KEY = "snippet-collapsed";
  let collapsed = new Set<string>();
  try { collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]")); } catch {}
  let panelQuery = "";
  function renderList(container: HTMLElement, selectedId?: string) {
    container.replaceChildren();
    const search = el("input", "snippet-search"); search.placeholder = "搜尋片段…"; search.value = panelQuery; search.setAttribute("aria-label", "搜尋片段");
    search.oninput = () => { panelQuery = search.value; renderList(container, selectedId); const again = container.querySelector<HTMLInputElement>(".snippet-search"); again?.focus(); again?.setSelectionRange(panelQuery.length, panelQuery.length); };
    container.append(search);
    const q = panelQuery.trim();
    const visible = q ? filterSnippets(items, q).map((match) => match.snippet) : items;
    if (!items.length) { container.append(el("p", "help", "還沒有片段。按右上角 ＋ 新增，或在終端機按 ⌘⇧P 開啟面板。片段可綁定到目錄，在該目錄及其子目錄的終端機才會出現。")); return; }
    if (!visible.length) container.append(el("p", "help", "沒有符合的片段"));
    const here = host.cwd();
    for (const group of groupByScope(visible)) {
      const open = q ? true : !collapsed.has(group.scope);
      const header = el("div", "row group-row snippet-group");
      const chevron = el("span", "group-chevron" + (open ? " expanded" : ""));
      chevron.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';
      const label = el("span", "row-label", scopeLabel(group.scope, host.home()));
      label.title = isGlobal(group.scope) ? "所有目錄" : group.scope;
      const count = el("span", "badge", String(group.items.length));
      const dot = here && !isGlobal(group.scope) && (here === group.scope || here.startsWith(group.scope + "/")) ? el("span", "snippet-here", "●") : undefined;
      if (dot) dot.title = "目前終端機位於此目錄";
      const addHere = el("button", "icon-btn row-action", "＋"); addHere.title = "在此範圍新增片段"; addHere.setAttribute("aria-label", "在此範圍新增片段");
      addHere.onclick = (event) => { event.stopPropagation(); host.editInDrawer(undefined, group.scope); };
      header.append(chevron, label, ...(dot ? [dot] : []), count, addHere);
      header.onclick = () => {
        if (collapsed.has(group.scope)) collapsed.delete(group.scope); else collapsed.add(group.scope);
        try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch {}
        renderList(container, selectedId);
      };
      container.append(header);
      if (!open) continue;
      for (const item of group.items) {
        const row = el("div", "row snippet-row" + (item.id === selectedId ? " selected" : ""));
        row.dataset.snippetId = item.id;
        const text = el("span", "snippet-row-text");
        text.append(el("span", "snippet-row-name", item.name), el("span", "snippet-row-body mono", item.text.split("\n")[0]));
        text.title = item.text;
        const insert = el("button", "icon-btn row-action", "↵"); insert.title = host.canInsert() ? "插入到終端機" : "目前沒有終端機"; insert.disabled = !host.canInsert();
        insert.onclick = (event) => { event.stopPropagation(); store.insert(item).catch(host.notify); };
        row.append(text, insert);
        row.onclick = () => host.editInDrawer(item.id);
        container.append(row);
      }
    }
  }

  return {
    store,
    createForm,
    renderList,
    element: palette,
    toggle: () => (isOpen() ? close() : open().catch(host.notify)),
    close,
    isOpen,
    // Dropping a folder on the snippet panel starts a snippet scoped to it.
    newScoped: (scope: string) => host.editInDrawer(undefined, scope),
  };
}
export type Snippets = ReturnType<typeof initSnippets>;
