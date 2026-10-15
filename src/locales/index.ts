/// <reference types="vite/client" />
import type { Messages } from "../i18n";

// 內建語系：src/locales/<code>/*.json，每個檔案是一個區域的扁平 key（settings.*、files.* …），載入時合併。
const modules = import.meta.glob<Messages>("./*/*.json", { eager: true, import: "default" });

export const builtinLocales: Record<string, Messages> = {};
for (const [path, messages] of Object.entries(modules)) {
  const code = path.split("/")[1];
  Object.assign((builtinLocales[code] ??= {}), messages);
}

// 內建語系的顯示名稱（語言自己的名字）。
export const builtinNames: Record<string, string> = { en: "English", "zh-Hant": "繁體中文" };
