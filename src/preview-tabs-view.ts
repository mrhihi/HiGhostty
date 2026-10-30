// DOM for a preview tab strip with its panes: tabs on top, below them the active
// tab's 1–3 panes (columns or rows). Shared by the pane inside a terminal tab
// (preview-panel.ts) and the standalone preview window (preview-window.ts); each
// host owns the TabsState and adds its own buttons. Rules are in preview-tabs.ts.
import { createPreviewView } from "./preview-view";
import { popupMenu } from "./context-menu";
import {
  canMerge, closeGroup, closeGroups, closePane, detachPane, dropTarget, groupOf, groupTitle, mergeGroups, moveGroup, movePane,
  paneBoxes, replacePanePath, setLayout, setSizes, sizesFromDrag, splitGroup,
  type Group, type Pane, type TabsState,
} from "./preview-tabs";
import { t } from "./i18n";
import { applyI18n, onLocaleChange } from "./i18n-runtime";

export type TabsViewHost = {
  // undefined: nothing to show right now (the views are released, not "closed").
  state(): TabsState | undefined;
  set(next: TabsState): void;
  notify(error: unknown): void;
  // Extra buttons of every pane header / of the tab strip, as HTML with data-act.
  paneButtons: string;
  barButtons?: string;
  paneAction(act: string, pane: Pane): void;
  barAction?(act: string): void;
  // The last tab was closed.
  onEmpty(): void;
  onTitle?(title: string): void;
};

type View = ReturnType<typeof createPreviewView>;
const GAP = 6;
const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
export const tabIcons = {
  detach: icon("M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"),
  close: icon("M6 6l12 12M18 6L6 18"),
  columns: icon("M3 5h18v14H3zM9 5v14M15 5v14"),
  rows: icon("M3 5h18v14H3zM3 10h18M3 15h18"),
  refresh: icon("M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5"),
  left: icon("M15 6l-6 6 6 6"),
  right: icon("M9 6l6 6-6 6"),
  up: icon("M6 15l6-6 6 6"),
  down: icon("M6 9l6 6 6-6"),
};

export function createTabsView(host: TabsViewHost) {
  const root = document.createElement("div");
  root.className = "pv-root";
  root.innerHTML = `<div class="pv-tabbar"><div class="pv-tabs" role="tablist" data-i18n-aria-label="preview.tabs"></div><button type="button" class="icon-btn pv-refresh" data-i18n-title="preview.refresh" data-i18n-aria-label="preview.refresh">${tabIcons.refresh}</button><button type="button" class="icon-btn pv-layout" data-i18n-title="preview.layoutToggle" data-i18n-aria-label="preview.layoutToggle"></button>${host.barButtons ?? ""}</div><div class="preview-panes"></div>`;
  applyI18n(root);
  const tabsEl = root.querySelector<HTMLElement>(".pv-tabs")!;
  const layoutBtn = root.querySelector<HTMLButtonElement>(".pv-layout")!;
  const panesEl = root.querySelector<HTMLElement>(".preview-panes")!;
  const state = () => host.state();
  const apply = (next: TabsState) => { host.set(next); render(); };

  const views = new Map<string, View>();
  const containers = new Map<string, HTMLElement>();
  const findPane = (id: string): Pane | undefined => { const s = state(); return s ? groupOf(s, id)?.panes.find((p) => p.id === id) : undefined; };

  // ---- panes -------------------------------------------------------------
  function createView(pane: Pane): View {
    const view = createPreviewView({
      notify: host.notify,
      openFile: (next) => { const s = state(); if (s) apply(replacePanePath(s, pane.id, next)); },
    });
    view.actions.innerHTML = `<button type="button" class="icon-btn pv-multi" data-act="prev"></button><button type="button" class="icon-btn pv-multi" data-act="next"></button><button type="button" class="icon-btn pv-multi" data-act="detach" data-i18n-title="preview.detachPane" data-i18n-aria-label="preview.detachPane">${tabIcons.detach}</button>${host.paneButtons}<button type="button" class="icon-btn pv-multi" data-act="close" data-i18n-title="preview.closePane" data-i18n-aria-label="preview.closePane">${tabIcons.close}</button>`;
    applyI18n(view.actions);
    view.actions.addEventListener("click", (event) => {
      const act = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      const s = state();
      const current = findPane(pane.id);
      if (!act || !s || !current) return;
      if (act === "prev") apply(movePane(s, pane.id, -1));
      else if (act === "next") apply(movePane(s, pane.id, 1));
      else if (act === "detach") apply(detachPane(s, pane.id));
      else if (act === "close") apply(closePane(s, pane.id));
      else host.paneAction(act, { ...current, path: view.shown() ?? current.path });
    });
    return view;
  }
  // The move buttons point along the split direction and stop at the ends.
  function updateMoveButtons(group: Group) {
    group.panes.forEach((pane, i) => {
      const actions = views.get(pane.id)?.actions;
      if (!actions) return;
      const cols = group.layout === "columns";
      const set = (act: "prev" | "next", disabled: boolean) => {
        const btn = actions.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
        btn.innerHTML = cols ? (act === "prev" ? tabIcons.left : tabIcons.right) : (act === "prev" ? tabIcons.up : tabIcons.down);
        const label = t(act === "prev" ? "preview.movePrev" : "preview.moveNext");
        btn.title = label; btn.setAttribute("aria-label", label);
        btn.disabled = disabled;
      };
      set("prev", i === 0);
      set("next", i === group.panes.length - 1);
    });
  }

  // ---- layout of one tab's panes ----------------------------------------
  function layoutGroup(group: Group) {
    const hostEl = containers.get(group.id);
    if (!hostEl || !views.size) return;
    const area = { x: 0, y: 0, width: panesEl.clientWidth, height: panesEl.clientHeight };
    const boxes = paneBoxes(area, group.layout, group.sizes, GAP);
    group.panes.forEach((pane, i) => {
      const style = views.get(pane.id)?.root.style;
      if (!style) return;
      style.left = `${boxes[i].x}px`; style.top = `${boxes[i].y}px`;
      style.width = `${boxes[i].width}px`; style.height = `${boxes[i].height}px`;
    });
    hostEl.querySelectorAll(".pv-divider").forEach((el) => el.remove());
    for (let i = 0; i < group.panes.length - 1; i++) {
      const divider = document.createElement("div");
      divider.className = "pv-divider";
      divider.dataset.layout = group.layout;
      divider.setAttribute("role", "separator");
      divider.setAttribute("aria-label", t("preview.resizePane"));
      const before = boxes[i];
      divider.style.cssText = group.layout === "columns"
        ? `left:${before.x + before.width}px;top:0;width:${GAP}px;height:${area.height}px`
        : `left:0;top:${before.y + before.height}px;width:${area.width}px;height:${GAP}px`;
      divider.addEventListener("pointerdown", (event) => dragDivider(event, divider, group.id, i));
      hostEl.append(divider);
    }
  }
  function dragDivider(event: PointerEvent, divider: HTMLElement, groupId: string, index: number) {
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add("dragging");
    const move = (e: PointerEvent) => {
      const s = state();
      const group = s?.groups.find((g) => g.id === groupId);
      if (!s || !group) return;
      const rect = panesEl.getBoundingClientRect();
      const area = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      const sizes = sizesFromDrag(area, group.layout, group.sizes, index, group.layout === "columns" ? e.clientX : e.clientY, GAP);
      host.set(setSizes(s, groupId, sizes));
      layoutGroup(state()!.groups.find((g) => g.id === groupId)!);
      // layoutGroup rebuilt the dividers; the one being dragged is a new element now.
      containers.get(groupId)?.querySelectorAll<HTMLElement>(".pv-divider")[index]?.classList.add("dragging");
    };
    const end = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", end);
      divider.removeEventListener("pointercancel", end);
      render();
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", end);
    divider.addEventListener("pointercancel", end);
  }

  // ---- tab strip ---------------------------------------------------------
  function mergeInto(sourceId: string, targetId: string) {
    const s = state();
    if (!s) return;
    const result = mergeGroups(s, sourceId, targetId);
    if ("error" in result) { if (result.error === "tooMany") host.notify(t("preview.tooMany")); return; }
    apply(result.state);
  }
  function tabMenu(group: Group) {
    const s = state();
    if (!s) return;
    const others = s.groups.filter((g) => g.id !== group.id);
    const multi = group.panes.length > 1;
    const index = s.groups.findIndex((g) => g.id === group.id);
    popupMenu({ items: [
      ...(others.length
        ? others.map((other) => ({
            text: `${t("preview.mergeWith")}：${groupTitle(other)}`,
            enabled: canMerge(s, other.id, group.id),
            action: () => mergeInto(other.id, group.id),
          }))
        : [{ text: t("preview.mergeNone"), enabled: false }]),
      { item: "Separator" as const },
      { text: t("preview.refresh"), action: () => refreshGroup(state()?.groups.find((g) => g.id === group.id)) },
      { text: t("preview.tabMoveLeft"), enabled: index > 0, action: () => apply(moveGroup(state()!, group.id, index - 1)) },
      { text: t("preview.tabMoveRight"), enabled: index < s.groups.length - 1, action: () => apply(moveGroup(state()!, group.id, index + 1)) },
      { item: "Separator" as const },
      { text: t("preview.splitTab"), enabled: multi, action: () => apply(splitGroup(state()!, group.id)) },
      { text: t("preview.layoutColumns"), enabled: multi && group.layout !== "columns", action: () => apply(setLayout(state()!, group.id, "columns")) },
      { text: t("preview.layoutRows"), enabled: multi && group.layout !== "rows", action: () => apply(setLayout(state()!, group.id, "rows")) },
      { item: "Separator" as const },
      { text: t("preview.tabClose"), action: () => apply(closeGroup(state()!, group.id)) },
      { text: t("preview.closeOthers"), enabled: s.groups.length > 1, action: () => apply(closeGroups(state()!, group.id, "others")) },
      { text: t("preview.closeLeft"), enabled: index > 0, action: () => apply(closeGroups(state()!, group.id, "left")) },
      { text: t("preview.closeRight"), enabled: index < s.groups.length - 1, action: () => apply(closeGroups(state()!, group.id, "right")) },
      { text: t("preview.closeAll"), action: () => apply(closeGroups(state()!, group.id, "all")) },
    ] }).catch(host.notify);
  }
  function dragTab(event: PointerEvent, group: Group, el: HTMLElement) {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".pv-tab-close")) return;
    const startX = event.clientX;
    let dragging = false;
    let drop: ReturnType<typeof dropTarget>;
    const rects = () => [...tabsEl.querySelectorAll<HTMLElement>(".pv-tab")].map((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, width: r.width };
    });
    const clear = () => tabsEl.querySelectorAll(".pv-tab").forEach((node) => node.classList.remove("drop-merge", "drop-before", "drop-after"));
    const from = state()!.groups.findIndex((g) => g.id === group.id);
    const move = (e: PointerEvent) => {
      if (!dragging && Math.abs(e.clientX - startX) < 5) return;
      if (!dragging) { dragging = true; el.classList.add("dragging"); el.setPointerCapture(e.pointerId); }
      const s = state()!;
      drop = dropTarget(rects(), e.clientX);
      clear();
      const nodes = tabsEl.querySelectorAll<HTMLElement>(".pv-tab");
      if (!drop) return;
      if (drop.kind === "merge") {
        if (drop.index !== from && canMerge(s, group.id, s.groups[drop.index].id)) nodes[drop.index].classList.add("drop-merge");
        else drop = undefined;
      } else if (drop.index === nodes.length) nodes[nodes.length - 1].classList.add("drop-after");
      else nodes[drop.index].classList.add("drop-before");
    };
    const end = (e: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      clear();
      el.classList.remove("dragging");
      const s = state();
      if (!s) return;
      if (!dragging) { if (e.type === "pointerup") apply({ ...s, active: group.id }); return; }
      if (!drop || e.type === "pointercancel") return;
      if (drop.kind === "merge") mergeInto(group.id, s.groups[drop.index].id);
      else apply(moveGroup(s, group.id, drop.index > from ? drop.index - 1 : drop.index));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  function renderTabs(s: TabsState) {
    tabsEl.replaceChildren(...s.groups.map((group) => {
      const el = document.createElement("div");
      el.className = "pv-tab" + (group.id === s.active ? " active" : "");
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(group.id === s.active));
      const title = document.createElement("span");
      title.className = "pv-tab-title";
      title.textContent = groupTitle(group);
      title.title = group.panes.map((p) => p.path).join("\n");
      const close = document.createElement("button");
      close.type = "button";
      close.className = "icon-btn pv-tab-close";
      close.innerHTML = tabIcons.close;
      close.title = t("preview.tabClose");
      close.setAttribute("aria-label", t("preview.tabClose"));
      close.addEventListener("click", () => { const cur = state(); if (cur) apply(closeGroup(cur, group.id)); });
      el.append(title, close);
      el.addEventListener("pointerdown", (event) => dragTab(event, group, el));
      el.addEventListener("contextmenu", (event) => { event.preventDefault(); tabMenu(group); });
      return el;
    }));
  }

  // ---- reconcile state -> DOM -------------------------------------------
  let emptied = false;
  function releaseAll() {
    for (const view of views.values()) view.dispose();
    views.clear();
    for (const el of containers.values()) el.remove();
    containers.clear();
    tabsEl.replaceChildren();
  }
  function render() {
    const s = state();
    if (!s) { releaseAll(); emptied = false; return; }
    if (!s.groups.length) {
      releaseAll();
      if (!emptied) { emptied = true; host.onEmpty(); }
      return;
    }
    emptied = false;
    const livePanes = new Set(s.groups.flatMap((g) => g.panes.map((p) => p.id)));
    for (const [id, view] of views) if (!livePanes.has(id)) { view.dispose(); views.delete(id); }
    const liveGroups = new Set(s.groups.map((g) => g.id));
    for (const [id, el] of containers) if (!liveGroups.has(id)) { el.remove(); containers.delete(id); }
    let active = s.groups.find((g) => g.id === s.active);
    if (!active) { active = s.groups[0]; host.set({ ...s, active: active.id }); }
    for (const group of s.groups) {
      let hostEl = containers.get(group.id);
      if (!hostEl) {
        hostEl = document.createElement("div");
        hostEl.className = "pv-group";
        containers.set(group.id, hostEl);
        panesEl.append(hostEl);
      }
      hostEl.classList.toggle("multi", group.panes.length > 1);
      for (const pane of group.panes) {
        let view = views.get(pane.id);
        if (!view) { view = createView(pane); views.set(pane.id, view); }
        if (view.root.parentElement !== hostEl) hostEl.append(view.root);
        if (view.shown() !== pane.path) view.show(pane.path);
      }
      const shown = group.id === active.id;
      hostEl.hidden = !shown;
      for (const pane of group.panes) { const view = views.get(pane.id)!; if (shown) view.resume(); else view.pause(); }
      updateMoveButtons(group);
    }
    layoutGroup(active);
    layoutBtn.hidden = active.panes.length < 2;
    layoutBtn.innerHTML = active.layout === "columns" ? tabIcons.rows : tabIcons.columns;
    renderTabs(state()!);
    host.onTitle?.(groupTitle(active));
  }
  // Every pane of the tab reloads its file.
  const refreshGroup = (group: Group | undefined) => group?.panes.forEach((pane) => views.get(pane.id)?.refresh());
  root.querySelector(".pv-refresh")!.addEventListener("click", () => {
    const s = state();
    refreshGroup(s?.groups.find((g) => g.id === s.active));
  });
  layoutBtn.addEventListener("click", () => {
    const s = state();
    const group = s?.groups.find((g) => g.id === s.active);
    if (s && group) apply(setLayout(s, group.id, group.layout === "columns" ? "rows" : "columns"));
  });
  root.querySelector(".pv-tabbar")!.addEventListener("click", (event) => {
    const act = (event.target as HTMLElement).closest<HTMLElement>("[data-bar]")?.dataset.bar;
    if (act) host.barAction?.(act);
  });
  new ResizeObserver(() => {
    const s = state();
    const g = s?.groups.find((x) => x.id === s.active);
    if (g) layoutGroup(g);
  }).observe(panesEl);
  onLocaleChange(() => { applyI18n(root); const s = state(); if (s?.groups.length) { renderTabs(s); updateMoveButtons(s.groups.find((g) => g.id === s.active) ?? s.groups[0]); } });

  return { root, render };
}
