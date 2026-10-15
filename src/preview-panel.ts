// DOM for the per-tab preview pane. It lives inside #terminals, in the strip
// that updateLayout leaves free of native terminal views. State and geometry
// are in preview.ts; rendering and polling are in preview-view.ts.
import { ratioFromPointer, type Box, type PreviewState } from "./preview";
import { createPreviewView } from "./preview-view";
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
  // Move the file into its own window and close the pane.
  popOut(path: string): void;
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
  const view = createPreviewView({
    notify: host.notify,
    openFile: (path) => {
      const state = host.activeTab()?.preview;
      if (state) { state.path = path; host.layoutChanged(); }
    },
  });
  const root = view.root;
  root.hidden = true;
  view.actions.innerHTML = `<button type="button" class="icon-btn" data-act="popout" data-i18n-title="preview.popout" data-i18n-aria-label="preview.popout">${icons.popout}</button>
<button type="button" class="icon-btn" data-act="side" data-i18n-title="preview.swapSide" data-i18n-aria-label="preview.swapSide">${icons.swap}</button>
<button type="button" class="icon-btn" data-act="reveal" data-i18n-title="preview.reveal" data-i18n-aria-label="preview.reveal">${icons.reveal}</button>
<button type="button" class="icon-btn" data-act="close" data-i18n-title="preview.close" data-i18n-aria-label="preview.close">${icons.close}</button>`;
  applyI18n(view.actions);
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
      if (!root.hidden) { root.hidden = true; resizer.hidden = true; }
      if (view.shown()) view.stop();
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
    if (view.shown() !== state.path) view.show(state.path);
  }

  view.actions.addEventListener("click", (event) => {
    const act = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    const state = host.activeTab()?.preview;
    if (act === "side") host.toggleSide();
    else if (act === "close") host.close();
    else if (act === "reveal" && state) host.reveal(state.path);
    else if (act === "popout" && state) host.popOut(state.path);
  });
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
