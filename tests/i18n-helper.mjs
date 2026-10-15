// 測試共用：把 src/locales/<code>/*.json 合併載入，並可把 t() 切到指定語系。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { setActive } from "../src/i18n.ts";

const root = new URL("../src/locales/", import.meta.url);

export function loadBuiltin(code) {
  const dir = new URL(`${code}/`, root);
  const out = {};
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) Object.assign(out, JSON.parse(readFileSync(new URL(file, dir), "utf8")));
  return out;
}
export const builtinCodes = () => readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

// 預設切到繁中，讓既有以中文字串為斷言的測試維持原樣。
export function useLocale(code = "zh-Hant") {
  setActive(loadBuiltin(code), loadBuiltin("en"), code);
}
