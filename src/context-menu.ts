// The one popup shared by every native right-click menu; see native-menu.ts.
import { Menu, type MenuOptions } from "@tauri-apps/api/menu";
import { createMenuPopup } from "./native-menu";

export const popupMenu = createMenuPopup((options: MenuOptions) => Menu.new(options));
