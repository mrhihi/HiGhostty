// Entry of the standalone preview window (preview.html). It is a plain page:
// no terminals, no native layer. Every popped-out file is a tab here, and tabs
// can be merged (preview-tabs-view.ts). The one thing specific to this window:
// files arrive through a queue in Rust, and "dock" sends one back to its tab.
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createTabsView } from "./preview-tabs-view";
import { closePane, emptyTabs, importGroups, openPath, type GroupSeed, type Origin, type TabsState } from "./preview-tabs";
import { t } from "./i18n";
import { applyI18n, initI18n } from "./i18n-runtime";

const dockIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 20H4v-6M4 20l9-9M6 10V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4"/></svg>';
const revealIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

// 先載入語系再畫面；不用 top-level await（vite 預設 target 不支援）。
function main() {
  document.body.classList.add("standalone");
  const notice = document.createElement("div");
  notice.id = "notice";
  notice.setAttribute("role", "alert");
  function notify(error: unknown) {
    notice.textContent = String(error);
    notice.classList.add("show");
    setTimeout(() => notice.classList.remove("show"), 7000);
  }

  let tabs: TabsState = emptyTabs();
  const view = createTabsView({
    state: () => tabs,
    set: (next) => { tabs = next; },
    notify,
    paneButtons: `<button type="button" class="icon-btn" data-act="dock" data-i18n-title="preview.dock" data-i18n-aria-label="preview.dock">${dockIcon}</button><button type="button" class="icon-btn" data-act="reveal" data-i18n-title="preview.reveal" data-i18n-aria-label="preview.reveal">${revealIcon}</button>`,
    barButtons: `<button type="button" class="icon-btn" data-bar="dockAll" data-i18n-title="preview.dockAll" data-i18n-aria-label="preview.dockAll">${dockIcon}</button>`,
    barAction: (act) => {
      if (act !== "dockAll") return;
      // Tabs go back to the terminal tab each came from, merged groups intact (a group follows its first pane);
      // the window closes when the last one is gone.
      const targets = new Map<string, { origin: Origin | null; items: GroupSeed[] }>();
      for (const group of tabs.groups) {
        const origin = group.panes[0].origin ?? null;
        const key = origin ? `${origin.window}\n${origin.tab ?? ""}` : "";
        const target = targets.get(key) ?? { origin, items: [] };
        target.items.push({ paths: group.panes.map((p) => p.path), layout: group.layout, sizes: group.sizes });
        targets.set(key, target);
      }
      (async () => {
        for (const { origin, items } of targets.values()) {
          await invoke("preview_dock", { groups: { items, active: 0 }, origin });
        }
        tabs = emptyTabs();
        view.render();
      })().catch((error) => { notify(error); view.render(); });
    },
    paneAction: (act, pane) => {
      if (act === "reveal") invoke("preview_reveal", { path: pane.path }).catch(notify);
      else if (act === "dock") {
        invoke("preview_dock", { path: pane.path, origin: pane.origin ?? null })
          .then(() => { tabs = closePane(tabs, pane.id); view.render(); })
          .catch(notify);
      }
    },
    onEmpty: () => { getCurrentWindow().destroy().catch(notify); },
    onTitle: (title) => { document.title = title; getCurrentWindow().setTitle(title).catch(() => {}); },
  });
  document.getElementById("app")!.append(view.root, notice);
  applyI18n(document.body);
  document.title = t("preview.title");

  type Pending = { path?: string; origin?: Origin | null; groups?: { items: GroupSeed[]; active?: number } };
  async function takePending() {
    const items = await invoke<Pending[]>("preview_take_pending");
    if (!items.length) return;
    for (const item of items) {
      if (item.groups) tabs = importGroups(tabs, item.groups.items, item.groups.active ?? 0, item.origin);
      else if (item.path) tabs = openPath(tabs, item.path, item.origin);
    }
    view.render();
  }
  // Listen before the first take so a file requested in between is not missed.
  listen("preview-open", () => takePending().catch(notify))
    .then(() => takePending())
    .catch(notify);
}
initI18n({ native: false }).catch(() => {}).then(main);
