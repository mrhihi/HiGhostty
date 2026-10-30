// DOM for the per-tab preview pane. It lives in the right half of the files overlay
// (#files-main, built by files-panel.ts). State and geometry are in preview.ts;
// rendering and polling are in preview-view.ts.
import { clampPreviewRatio, DEFAULT_RATIO, ratioFromPointer, type PreviewState } from "./preview";
import { createTabsView } from "./preview-tabs-view";
import type { GroupSeed, TabsState } from "./preview-tabs";
import { applyI18n } from "./i18n-runtime";

export type PreviewTab = { preview?: PreviewState };
export type PreviewHost = {
  activeTab(): PreviewTab | undefined;
  close(): void;
  reveal(path: string): void;
  // Move every tab (merged groups and their layout included) into the standalone preview window.
  popOut(groups: GroupSeed[], active: number): Promise<unknown>;
  notify(error: unknown): void;
};

export const RATIO_KEY = "files-preview-ratio";

const icons = {
  popout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
  reveal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

export function initPreviewPanel(host: PreviewHost) {
  const main = document.getElementById("files-main")!;
  const slot = document.getElementById("files-pv")!;
  const resizer = document.getElementById("files-pv-resizer")!;
  // Shown only while the files overlay is open and wide enough; otherwise the views are released.
  let visible = false;
  let lastTabs: TabsState | undefined;
  let ratio = DEFAULT_RATIO;
  try { ratio = Number(localStorage.getItem(RATIO_KEY)) || DEFAULT_RATIO; } catch {}
  const tabsOf = () => (visible ? host.activeTab()?.preview?.tabs : undefined);
  const view = createTabsView({
    state: tabsOf,
    set: (next) => { const state = host.activeTab()?.preview; if (state) state.tabs = next; lastTabs = next; },
    notify: host.notify,
    paneButtons: `<button type="button" class="icon-btn" data-act="reveal" data-i18n-title="preview.reveal" data-i18n-aria-label="preview.reveal">${icons.reveal}</button>`,
    barButtons: `<button type="button" class="icon-btn" data-bar="popout" data-i18n-title="preview.popout" data-i18n-aria-label="preview.popout">${icons.popout}</button><button type="button" class="icon-btn" data-bar="close" data-i18n-title="preview.close" data-i18n-aria-label="preview.close">${icons.close}</button>`,
    paneAction: (act, pane) => {
      if (act === "reveal") host.reveal(pane.path);
    },
    barAction: (act) => {
      if (act === "close") host.close();
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
  slot.append(root);
  applyI18n(resizer);

  const applyRatio = () => main.style.setProperty("--pv-ratio", String(clampPreviewRatio(ratio, main.clientWidth)));
  applyRatio();

  // Called from updateLayout once the overlay knows whether the preview fits.
  function sync(shown: boolean) {
    const state = shown ? host.activeTab()?.preview : undefined;
    if (!state) {
      if (visible) { visible = false; lastTabs = undefined; view.render(); }
      return;
    }
    applyRatio();
    // Re-render only when this is another terminal tab's pane or its tabs changed.
    if (!visible || lastTabs !== state.tabs) { visible = true; lastTabs = state.tabs; view.render(); }
  }

  resizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");
    const move = (e: PointerEvent) => {
      const box = main.getBoundingClientRect();
      ratio = ratioFromPointer(box.left, box.width, e.clientX);
      applyRatio();
    };
    const end = () => {
      resizer.classList.remove("dragging");
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", end);
      resizer.removeEventListener("pointercancel", end);
      try { localStorage.setItem(RATIO_KEY, String(ratio)); } catch {}
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", end);
    resizer.addEventListener("pointercancel", end);
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== RATIO_KEY) return;
    ratio = Number(event.newValue) || DEFAULT_RATIO;
    applyRatio();
  });

  return { sync };
}
