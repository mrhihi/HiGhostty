// DOM for the per-tab preview pane. It lives inside #terminals, in the strip
// that updateLayout leaves free of native terminal views. State and geometry
// are in preview.ts; rendering and polling are in preview-view.ts.
import { ratioFromPointer, type Box, type PreviewState } from "./preview";
import { createTabsView } from "./preview-tabs-view";
import type { GroupSeed, TabsState } from "./preview-tabs";
import { applyI18n } from "./i18n-runtime";

export type PreviewTab = { preview?: PreviewState };
export type PreviewHost = {
  activeTab(): PreviewTab | undefined;
  // Box of the whole #terminals area (client coordinates), for dragging the divider.
  area(): Box;
  layoutChanged(): void;
  toggleSide(): void;
  close(): void;
  reveal(path: string): void;
  // Move every tab (merged groups and their layout included) into the standalone preview window.
  popOut(groups: GroupSeed[], active: number): Promise<unknown>;
  notify(error: unknown): void;
};

const icons = {
  swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/></svg>',
  popout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
  reveal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

export function initPreviewPanel(host: PreviewHost) {
  const terminals = document.getElementById("terminals")!;
  // Shown only while updateLayout gives the pane a box; otherwise the views are released.
  let visible = false;
  let lastTabs: TabsState | undefined;
  const tabsOf = () => (visible ? host.activeTab()?.preview?.tabs : undefined);
  const view = createTabsView({
    state: tabsOf,
    set: (next) => { const state = host.activeTab()?.preview; if (state) state.tabs = next; lastTabs = next; },
    notify: host.notify,
    paneButtons: `<button type="button" class="icon-btn" data-act="reveal" data-i18n-title="preview.reveal" data-i18n-aria-label="preview.reveal">${icons.reveal}</button>`,
    barButtons: `<button type="button" class="icon-btn" data-bar="popout" data-i18n-title="preview.popout" data-i18n-aria-label="preview.popout">${icons.popout}</button><button type="button" class="icon-btn" data-bar="side" data-i18n-title="preview.swapSide" data-i18n-aria-label="preview.swapSide">${icons.swap}</button><button type="button" class="icon-btn" data-bar="close" data-i18n-title="preview.close" data-i18n-aria-label="preview.close">${icons.close}</button>`,
    paneAction: (act, pane) => {
      if (act === "reveal") host.reveal(pane.path);
    },
    barAction: (act) => {
      if (act === "side") host.toggleSide();
      else if (act === "close") host.close();
      else if (act === "popout") {
        const tabs = tabsOf();
        if (!tabs) return;
        const seeds = tabs.groups.map((g) => ({ paths: g.panes.map((p) => p.path), layout: g.layout, sizes: g.sizes }));
        host.popOut(seeds, Math.max(0, tabs.groups.findIndex((g) => g.id === tabs.active))).catch(host.notify);
      }
    },
    onEmpty: () => host.close(),
  });
  const root = view.root;
  root.id = "preview";
  root.hidden = true;
  const resizer = document.createElement("div");
  resizer.id = "preview-resizer";
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("data-i18n-aria-label", "preview.resize");
  resizer.hidden = true;
  terminals.append(resizer, root);

  // Called from updateLayout with the pane's box (client coordinates) or none.
  function sync(box: Box | undefined, area: Box) {
    const state = host.activeTab()?.preview;
    if (!state || !box) {
      if (visible || !root.hidden) { visible = false; root.hidden = true; resizer.hidden = true; lastTabs = undefined; view.render(); }
      return;
    }
    const right = state.side === "right";
    root.hidden = false;
    resizer.hidden = false;
    root.dataset.side = state.side;
    resizer.dataset.side = state.side;
    root.style.cssText = `left:${box.x - area.x}px;top:${box.y - area.y}px;width:${box.width}px;height:${box.height}px`;
    resizer.style.cssText = right
      ? `left:${box.x - area.x - 6}px;top:${box.y - area.y}px;width:6px;height:${box.height}px`
      : `left:${box.x - area.x}px;top:${box.y - area.y - 6}px;width:${box.width}px;height:6px`;
    // Re-render only when this is another terminal tab's pane or its tabs changed.
    if (!visible || lastTabs !== state.tabs) { visible = true; lastTabs = state.tabs; view.render(); }
  }

  resizer.addEventListener("pointerdown", (event) => {
    const state = host.activeTab()?.preview;
    if (!state) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");
    const move = (e: PointerEvent) => {
      const current = host.activeTab()?.preview;
      if (!current) return;
      current.ratio = ratioFromPointer(host.area(), current.side, current.side === "right" ? e.clientX : e.clientY);
      host.layoutChanged();
    };
    const end = () => {
      resizer.classList.remove("dragging");
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", end);
      resizer.removeEventListener("pointercancel", end);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", end);
    resizer.addEventListener("pointercancel", end);
  });

  return { sync };
}
