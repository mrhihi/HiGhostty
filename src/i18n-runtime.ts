import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { builtinLocales, builtinNames } from "./locales";
import { FALLBACK_LOCALE, mergeLocales, parseLocaleFile, resolveLocale, setActive, t, type LocaleFile, type Messages } from "./i18n";

export type LocaleInfo = { code: string; name: string; builtin: boolean; custom: boolean };
type UserLocale = { code: string; text: string };

let setting = "system";
let resolved = FALLBACK_LOCALE;
const user = new Map<string, LocaleFile>();
// 使用者語系檔解析失敗的原因（code → 錯誤），顯示在設定面板；失敗的檔案不套用，內建語系照常運作。
export const userLocaleErrors = new Map<string, string[]>();
const listeners = new Set<() => void>();
let pushNative = true;

export const onLocaleChange = (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); };
export const languageSetting = () => setting;
export const resolvedLocale = () => resolved;
export const enMessages = (): Messages => builtinLocales[FALLBACK_LOCALE] ?? {};
export const builtinMessages = (code: string): Messages | undefined => builtinLocales[code];
export const userLocale = (code: string): LocaleFile | undefined => user.get(code);
// 某語系目前實際生效的內容（內建＋使用者覆蓋）。
export const effectiveMessages = (code: string): Messages => mergeLocales(builtinLocales[code], user.get(code)?.messages);

export function availableLocales(): LocaleInfo[] {
  const codes = new Set([...Object.keys(builtinLocales), ...user.keys()]);
  return [...codes].sort().map((code) => ({
    code,
    name: user.get(code)?.name ?? builtinNames[code] ?? code,
    builtin: code in builtinLocales,
    custom: user.has(code),
  }));
}

async function systemLanguages(): Promise<string[]> {
  // WKWebView 的 navigator.languages 可能不是使用者的系統偏好，所以優先問原生；預覽窗等沒有原生引擎時退回 navigator。
  try {
    const r = await invoke<{ languages?: string[] }>("native", { request: { op: "preferred-languages" } });
    if (r.languages?.length) return r.languages;
  } catch {}
  return [...navigator.languages];
}

export function applyI18n(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n!); });
  for (const name of ["title", "aria-label", "placeholder"]) {
    root.querySelectorAll<HTMLElement>(`[data-i18n-${name}]`).forEach((el) => { el.setAttribute(name, t(el.getAttribute(`data-i18n-${name}`)!)); });
  }
}

async function recompute() {
  resolved = resolveLocale(setting, await systemLanguages(), availableLocales().map((l) => l.code));
  const base = enMessages();
  setActive(effectiveMessages(resolved), base, resolved);
  document.documentElement.lang = resolved;
  applyI18n(document);
  if (pushNative) {
    const strings: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...base, ...effectiveMessages(resolved) })) if (k.startsWith("native.")) strings[k] = v;
    invoke("native", { request: { op: "set-strings", strings } }).catch(() => {});
  }
  listeners.forEach((cb) => cb());
}

async function loadUser() {
  user.clear();
  userLocaleErrors.clear();
  for (const { code, text } of await invoke<UserLocale[]>("locales_list")) {
    const parsed = parseLocaleFile(text, enMessages());
    if (!parsed.file || parsed.file.locale !== code) userLocaleErrors.set(code, parsed.file ? ["_meta.locale does not match the file name"] : parsed.errors);
    else user.set(code, parsed.file);
  }
}

// native:false 給沒有原生引擎的視窗（預覽窗），不推原生字串。
export async function initI18n(options: { native?: boolean } = {}) {
  pushNative = options.native !== false;
  try { setting = await invoke<string>("ui_language"); } catch {}
  try { await loadUser(); } catch {}
  await recompute();
  await listen<string>("language-changed", async ({ payload }) => { setting = payload; await recompute(); });
  await listen("locales-changed", async () => { try { await loadUser(); } catch {} await recompute(); });
}

export const setLanguage = (language: string) => invoke("set_ui_language", { language });
