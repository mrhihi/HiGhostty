// Entry of the popped-out files panel (files.html): the same panel as beside a terminal,
// in its own window. Anything that needs a terminal is sent to the window it came from;
// the panel state is sent back so the tab keeps (and saves) it.
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initFilesPanel } from "./files-panel";
import type { FilesState } from "./files";
import { icons } from "./icons";
import { applyI18n, initI18n } from "./i18n-runtime";

type Init = { tab: string; origin: string; cwd?: string; home: string; files: FilesState };
declare global { interface Window { __HIGHOSTTY_FILES__?: Init } }
export const FILES_WINDOW_SIZE_KEY = "files-window-size";

async function main() {
  const init = window.__HIGHOSTTY_FILES__;
  if (!init) return;
  const notice = document.getElementById("notice")!;
  const notify = (error: unknown) => {
    notice.textContent = String(error);
    notice.classList.add("show");
    setTimeout(() => notice.classList.remove("show"), 7000);
  };
  let cwd = init.cwd;
  const tab = { files: { ...init.files, open: true, detached: undefined } as FilesState };
  const send = (event: string, payload: Record<string, unknown> = {}) => emitTo(init.origin, event, { tab: init.tab, ...payload }).catch(notify);
  const dock = async (close: boolean) => {
    await send("files-dock", { files: tab.files, close });
    await invoke("close_files_window", { tab: init.tab }).catch(notify);
  };
  const panel = initFilesPanel({
    native: (request) => invoke("native", { request }),
    activeTab: () => tab,
    cwd: () => cwd,
    home: () => init.home,
    displayPath: (path) => init.home && (path === init.home || path.startsWith(init.home + "/")) ? "~" + path.slice(init.home.length) : path,
    openTerminal: async (path) => { await send("files-request", { op: "open-terminal", path }); },
    editInTerminal: async (directory, command) => { await send("files-request", { op: "edit", directory, command }); },
    previewFile: (path) => { send("files-request", { op: "preview", path }); },
    followPreview: (path) => { send("files-request", { op: "follow-preview", path }); },
    insertIntoTerminal: async (text) => { await send("files-request", { op: "insert", text }); },
    focusTerminal: () => {},
    layoutChanged: () => {},
    visibilityChanged: (changed) => { send("files-state", { files: changed.files }); },
    notify,
    standalone: true,
    popOut: () => { dock(false); },
    closeWindow: () => { dock(true); },
    icons,
  });
  await listen<{ cwd: string }>("files-cwd", ({ payload }) => { cwd = payload.cwd; panel.cwdChanged(payload.cwd).catch(notify); });
  await listen<{ type: string; key?: string; shift?: boolean }>("native-event", ({ payload }) => panel.handleEvent(payload));
  // The close button returns the panel to a closed tab panel rather than leaving it popped out.
  await getCurrentWindow().onCloseRequested((event) => { event.preventDefault(); dock(true); });
  // Remember the window size for the next pop-out.
  let timer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { localStorage.setItem(FILES_WINDOW_SIZE_KEY, JSON.stringify({ width: window.innerWidth, height: window.innerHeight })); } catch {} }, 300);
  });
  panel.sync();
  applyI18n(document.body);
}
initI18n({ native: false }).catch(() => {}).then(() => main().catch((error) => document.body.append(String(error))));
