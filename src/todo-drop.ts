import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { applyI18n, onLocaleChange } from "./i18n-runtime";
import { icons } from "./icons";
import {
  categoriesOf,
  cleanText,
  filterTodos,
  formatSend,
  normalizeCategory,
  todoProblem,
  UNCATEGORIZED,
  type Todo,
  type TodoProblem,
  type TodosDocument,
} from "./todo";

// ⌘⇧L 待辦浮層：置中蓋在終端機 NSView 之上，靠 overlay-cutout 顯示（規則同待處理浮層）。
// 待辦只存在 data_dir/todos.json，送出時才貼到目前終端機，不碰 agent 自己的 todo list。
// 開關／遮罩／焦點的規則見 docs/todo-drop.md。
export type TodoDropHost = {
  native: (request: Record<string, unknown>) => Promise<unknown>;
  focusTerminal: () => void;
  insertIntoTerminal: (text: string) => Promise<void>;
  // False when there is no active tab to paste into.
  canInsert: () => boolean;
  // Category pre-filled when the panel opens (the active tab's name).
  defaultCategory: () => string;
  notify: (error: unknown) => void;
  closeIcon: string;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const problemText = (problem: TodoProblem) => {
  if (problem === "empty") return t("todo.errEmpty");
  if (problem === "tooLong") return t("todo.errTooLong");
  return t("todo.errNul");
};

export function initTodoDrop(host: TodoDropHost) {
  let items: Todo[] = [];
  let revision = 0;
  // null shows every item; UNCATEGORIZED shows items without a category; otherwise one category.
  let filter: string | null = null;
  const checked = new Set<string>();
  let editingId: string | undefined;
  // Set when an edit starts so the editor takes focus on the next render only.
  let focusEditor = false;

  const drop = el("div");
  drop.id = "todo-drop";
  drop.setAttribute("role", "dialog");
  drop.tabIndex = -1;
  drop.hidden = true;

  const bar = el("div", "todo-bar");
  const title = el("strong", "", "Todo");
  title.dataset.i18n = "todo.title";
  const closeBtn = el("button", "icon-btn");
  closeBtn.setAttribute("data-i18n-title", "todo.close");
  closeBtn.setAttribute("data-i18n-aria-label", "todo.close");
  closeBtn.innerHTML = host.closeIcon;
  closeBtn.onclick = () => close();
  bar.append(title, el("span", "todo-spacer"), closeBtn);

  const chips = el("div", "todo-chips");
  chips.setAttribute("role", "toolbar");
  const list = el("div", "todo-list");

  // Composer: stays mounted while the list re-renders, so typed text survives other changes.
  const composer = el("div", "todo-composer");
  const input = el("textarea", "todo-input");
  input.rows = 3;
  input.setAttribute("data-i18n-placeholder", "todo.inputPlaceholder");
  input.setAttribute("data-i18n-aria-label", "todo.input");
  const composerRow = el("div", "todo-composer-row");
  const category = el("input");
  category.maxLength = 40;
  category.setAttribute("list", "todo-categories");
  category.setAttribute("data-i18n-placeholder", "todo.categoryPlaceholder");
  category.setAttribute("data-i18n-aria-label", "todo.category");
  const categoryOptions = el("datalist");
  categoryOptions.id = "todo-categories";
  const add = el("button", "primary-btn", "Add");
  add.dataset.i18n = "todo.add";
  composerRow.append(category, categoryOptions, add);
  const formError = el("p", "todo-error");
  formError.hidden = true;
  composer.append(input, composerRow, formError);

  const foot = el("div", "todo-foot");
  const selectVisible = el("button", "ghost-btn", "Select all");
  selectVisible.dataset.i18n = "todo.selectVisible";
  const clearChecks = el("button", "ghost-btn", "Clear selection");
  clearChecks.dataset.i18n = "todo.clearChecks";
  const hint = el("span", "todo-hint", "↵ add · ⇧↵ new line · Esc close");
  hint.dataset.i18n = "todo.hint";
  const removeChecked = el("button", "danger-btn");
  const send = el("button", "primary-btn todo-send");
  foot.append(selectVisible, clearChecks, el("span", "todo-spacer"), hint, removeChecked, send);

  drop.append(bar, chips, list, composer, foot);
  const labelRoot = () => { applyI18n(drop); drop.setAttribute("aria-label", t("todo.title")); };
  labelRoot();
  // Static labels are re-applied above; dynamic rows and chips are rebuilt by render().
  onLocaleChange(() => { labelRoot(); if (!drop.hidden) render(); });

  let observer: ResizeObserver | undefined;
  const isOpen = () => !drop.hidden;

  function apply(document: TodosDocument) {
    items = document.items;
    revision = document.revision;
    for (const id of [...checked]) if (!items.some((item) => item.id === id)) checked.delete(id);
    if (isOpen()) render();
  }
  async function persist(next: Todo[]) {
    try {
      apply(await invoke<TodosDocument>("save_todos", { items: next, expectedRevision: revision }));
    } catch (error) {
      // A stale revision means another window saved first; show their version.
      apply(await invoke<TodosDocument>("todos"));
      throw error;
    }
  }
  const addTodo = (text: string, label: string) =>
    persist([...items, { id: crypto.randomUUID(), text, category: label, createdAt: Date.now() }]);
  const updateTodo = (id: string, text: string, label: string) =>
    persist(items.map((item) => (item.id === id ? { ...item, text, category: label } : item)));
  const removeTodo = (id: string) => {
    checked.delete(id);
    return persist(items.filter((item) => item.id !== id));
  };

  function setError(problem?: TodoProblem) {
    formError.hidden = !problem;
    formError.textContent = problem ? problemText(problem) : "";
  }

  // Send pastes the checked items as one message (no Enter), then removes them from the list.
  async function sendChecked() {
    const sent = items.filter((item) => checked.has(item.id));
    if (!sent.length || !host.canInsert()) return;
    try {
      await host.insertIntoTerminal(formatSend(sent));
    } catch (error) {
      host.notify(error);
      return;
    }
    const sentIds = new Set(sent.map((item) => item.id));
    checked.clear();
    close();
    await persist(items.filter((item) => !sentIds.has(item.id))).catch(host.notify);
  }

  function chip(label: string, value: string | null) {
    const node = el("button", "todo-chip", label);
    node.setAttribute("aria-pressed", String(filter === value));
    node.onclick = () => { filter = value; render(); };
    return node;
  }

  function row(item: Todo) {
    if (item.id === editingId) return editor(item);
    const node = el("div", "todo-row" + (checked.has(item.id) ? " checked" : ""));
    const box = el("input");
    box.type = "checkbox";
    box.checked = checked.has(item.id);
    box.setAttribute("aria-label", t("todo.check"));
    box.onchange = () => {
      if (box.checked) checked.add(item.id); else checked.delete(item.id);
      node.classList.toggle("checked", box.checked);
      updateFoot();
    };
    const text = el("div", "todo-text", item.text);
    text.onclick = () => box.click();
    // Right side: category tag, then icon buttons; the labels become tooltips and accessible names.
    const actions = el("div", "todo-actions");
    if (item.category) actions.append(el("span", "todo-cat", item.category));
    const edit = el("button", "icon-btn todo-icon");
    edit.innerHTML = icons.pencil;
    edit.title = t("todo.edit");
    edit.setAttribute("aria-label", t("todo.edit"));
    edit.onclick = () => { editingId = item.id; focusEditor = true; render(); };
    const remove = el("button", "icon-btn todo-icon danger");
    remove.innerHTML = icons.trash;
    remove.title = t("todo.delete");
    remove.setAttribute("aria-label", t("todo.delete"));
    remove.onclick = () => { removeTodo(item.id).catch(host.notify); };
    actions.append(edit, remove);
    node.append(box, text, actions);
    return node;
  }

  function editor(item: Todo) {
    const node = el("div", "todo-row editing");
    const text = el("textarea", "todo-input");
    text.rows = 4;
    text.value = item.text;
    text.setAttribute("aria-label", t("todo.input"));
    const label = el("input");
    label.value = item.category;
    label.maxLength = 40;
    label.placeholder = t("todo.categoryPlaceholder");
    label.setAttribute("list", "todo-categories");
    const error = el("p", "todo-error");
    error.hidden = true;
    const save = el("button", "primary-btn", t("todo.save"));
    const cancel = el("button", "ghost-btn", t("todo.cancel"));
    const finish = () => { editingId = undefined; render(); };
    const submit = async () => {
      const problem = todoProblem(text.value);
      if (problem) { error.textContent = problemText(problem); error.hidden = false; return; }
      try {
        await updateTodo(item.id, cleanText(text.value), normalizeCategory(label.value));
        finish();
      } catch (failure) {
        host.notify(failure);
      }
    };
    save.onclick = () => { submit(); };
    cancel.onclick = finish;
    text.oninput = () => { error.hidden = true; };
    // Esc and Enter are handled here and stop propagation, so they never close the whole drop.
    text.onkeydown = (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(); }
      else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); submit(); }
    };
    label.onkeydown = (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); submit(); }
    };
    const actions = el("div", "todo-actions");
    actions.append(cancel, save);
    node.append(text, label, error, actions);
    return node;
  }

  function updateFoot() {
    const visible = filterTodos(items, filter);
    selectVisible.disabled = !visible.length;
    clearChecks.disabled = !checked.size;
    removeChecked.textContent = t("todo.deleteChecked", { count: checked.size });
    removeChecked.disabled = !checked.size;
    send.textContent = t("todo.send", { count: checked.size });
    send.disabled = !checked.size || !host.canInsert();
  }

  // Deletes every checked item at once, whatever filter is showing.
  function deleteChecked() {
    const ids = new Set(checked);
    if (!ids.size) return;
    checked.clear();
    persist(items.filter((item) => !ids.has(item.id))).catch(host.notify);
  }

  function render() {
    const uncategorized = items.some((item) => !item.category);
    // The active filter keeps its chip even with no items yet (e.g. a new tab's default name), so it can be cleared.
    const categories = categoriesOf(items);
    const names = new Set(categories);
    if (filter) names.add(filter);
    chips.replaceChildren(
      chip(t("todo.filterAll"), null),
      ...[...names].sort((a, b) => a.localeCompare(b)).map((name) => chip(name, name)),
      ...(uncategorized || filter === UNCATEGORIZED ? [chip(t("todo.filterNone"), UNCATEGORIZED)] : []),
    );
    const visible = filterTodos(items, filter);
    list.replaceChildren(...(visible.length
      ? visible.map((item) => row(item))
      : [el("p", "todo-empty", t(items.length ? "todo.emptyFilter" : "todo.emptyAll"))]));
    categoryOptions.replaceChildren(...categories.map((name) => {
      const option = el("option");
      option.value = name;
      return option;
    }));
    updateFoot();
    if (focusEditor) {
      focusEditor = false;
      list.querySelector<HTMLTextAreaElement>(".todo-row.editing textarea")?.focus();
    }
  }

  async function submitNew() {
    const problem = todoProblem(input.value);
    setError(problem);
    if (problem) return;
    try {
      await addTodo(cleanText(input.value), normalizeCategory(category.value));
      input.value = "";
      input.focus();
    } catch (error) {
      host.notify(error);
    }
  }
  add.onclick = () => { submitNew(); };
  input.oninput = () => setError();
  // Enter adds; Shift+Enter inserts a line break.
  input.onkeydown = (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitNew(); }
  };
  category.onkeydown = (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); submitNew(); }
  };
  selectVisible.onclick = () => { filterTodos(items, filter).forEach((item) => checked.add(item.id)); render(); };
  clearChecks.onclick = () => { checked.clear(); render(); };
  removeChecked.onclick = () => { deleteChecked(); };
  send.onclick = () => { sendChecked().catch(host.notify); };

  // Keep the native terminals from covering the panel (see docs/todo-drop.md).
  function reportCutout(restoreFocus = false) {
    const box = drop.getBoundingClientRect();
    const open = isOpen() && box.height > 0;
    host.native({ op: "overlay-cutout", x: box.x - 8, y: box.y - 8, width: open ? box.width + 16 : 0, height: open ? box.height + 24 : 0, viewportWidth: window.innerWidth, restoreFocus }).catch(host.notify);
  }
  async function open() {
    if (isOpen()) return;
    drop.hidden = false;
    // The active tab's name is both the default filter and the default category; "" would mean uncategorized, so it falls back to all.
    const name = normalizeCategory(host.defaultCategory());
    filter = name || null;
    checked.clear();
    editingId = undefined;
    category.value = name;
    render();
    // The panel is centered, so a size change of either the panel or the workspace moves it.
    observer = new ResizeObserver(() => reportCutout());
    observer.observe(drop);
    if (drop.parentElement) observer.observe(drop.parentElement);
    reportCutout();
    await host.native({ op: "focus-web" });
    // Closed while focus-web was in flight: don't leave focus stuck in the WebView.
    if (!isOpen()) { host.focusTerminal(); return; }
    input.focus();
  }
  function close(refocus = true) {
    if (!isOpen()) return;
    observer?.disconnect();
    drop.hidden = true;
    editingId = undefined;
    reportCutout(refocus);
    if (refocus) host.focusTerminal();
  }

  drop.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  });
  // Focus can fall to <body> while the panel is open; Esc must still close it.
  // Events from inside the panel are left to its own handlers above (editor Esc cancels the edit first).
  document.addEventListener("keydown", (event) => {
    if (isOpen() && event.key === "Escape" && !event.isComposing && !(event.target instanceof Node && drop.contains(event.target))) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }, true);
  // The rail button toggles the panel itself; excluding it here stops mousedown from closing it just before the click reopens it.
  document.addEventListener("mousedown", (event) => {
    if (isOpen() && event.target instanceof Node && !drop.contains(event.target) && !(event.target instanceof Element && event.target.closest("#rail-todo"))) close();
  }, true);
  window.addEventListener("blur", () => { if (isOpen()) close(false); });

  async function load() {
    apply(await invoke<TodosDocument>("todos"));
    await listen<TodosDocument>("todos-changed", ({ payload }) => apply(payload));
  }

  return {
    element: drop,
    load,
    open,
    close,
    isOpen,
    toggle: () => (isOpen() ? close() : open().catch(host.notify)),
  };
}
export type TodoDrop = ReturnType<typeof initTodoDrop>;
