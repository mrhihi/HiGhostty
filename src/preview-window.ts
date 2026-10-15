// Entry of the standalone preview window (preview.html). It is a plain page:
// no terminals, no native layer. The path comes from the init script that
// `open_preview_window` injects.
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { baseName, createPreviewView } from "./preview-view";
import { t } from "./i18n";
import { applyI18n, initI18n } from "./i18n-runtime";

type Origin = { window: string; tab?: string | null };
declare global {
  interface Window { __HIGHOSTTY_PREVIEW__?: { path?: string; origin?: Origin | null } }
}
// 先載入語系再畫面；不用 top-level await（vite 預設 target 不支援）。
async function main() {
  const { path, origin } = window.__HIGHOSTTY_PREVIEW__ ?? {};
  document.body.classList.add("standalone");
  const notice = document.createElement("div");
  notice.id = "notice";
  notice.setAttribute("role", "alert");
  function notify(error: unknown) {
    notice.textContent = String(error);
    notice.classList.add("show");
    setTimeout(() => notice.classList.remove("show"), 7000);
  }
  const view = createPreviewView({
    notify,
    openFile: (next) => { view.show(next); document.title = baseName(next); },
  });
  const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  view.actions.innerHTML = `<button type="button" class="icon-btn" data-act="dock" data-i18n-title="preview.dock" data-i18n-aria-label="preview.dock">${icon("M10 20H4v-6M4 20l9-9M6 10V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4")}</button>
  <button type="button" class="icon-btn" data-act="reveal" data-i18n-title="preview.reveal" data-i18n-aria-label="preview.reveal">${icon("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z")}</button>`;
  view.actions.addEventListener("click", (event) => {
    const act = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    const shown = view.shown();
    if (!shown) return;
    if (act === "reveal") invoke("preview_reveal", { path: shown }).catch(notify);
    else if (act === "dock") invoke("preview_dock", { path: shown, origin }).catch(notify);
  });
  applyI18n(view.actions);
  document.title = t("preview.title");
  document.getElementById("app")!.append(view.root, notice);
  if (path) { view.show(path); document.title = baseName(path); }
  else view.root.querySelector(".preview-body")!.textContent = t("preview.noFile");
}
initI18n({ native: false }).catch(() => {}).then(main);
