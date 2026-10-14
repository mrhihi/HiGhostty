// Native context menus (Tauri Menu.popup) shared by every right-click menu.
//
// Tauri's popup command holds the webview resources-table lock until the
// NSMenu closes, while the main thread keeps serving web IPC inside the menu's
// tracking loop. Any IPC that needs that lock meanwhile (Menu.new, close)
// blocks the main thread forever, freezing the app. So while a menu is open
// nothing else is created or closed: extra right-clicks are ignored, and old
// menus are released at the start of the next popup instead of on a timer.
type PopupMenu = { popup(): Promise<void>; close(): Promise<void> };

export function createMenuPopup<Options, M extends PopupMenu>(newMenu: (options: Options) => Promise<M>) {
  let open = false;
  const stale: M[] = [];
  return async function popup(options: Options) {
    if (open) return;
    open = true;
    try {
      // Their item actions were delivered long ago, and no menu is open now.
      for (const menu of stale.splice(0)) await menu.close().catch(() => {});
      const menu = await newMenu(options);
      try { await menu.popup(); } finally { stale.push(menu); }
    } finally { open = false; }
  };
}
