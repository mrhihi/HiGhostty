// 多國語系的純邏輯（不碰 DOM、不 import Vite／Tauri 專屬模組，node test 可直接載入）。
export type Messages = Record<string, string>;
export type Params = Record<string, string | number>;
export type LocaleFile = { locale: string; name: string; messages: Messages };
export type ParsedLocale = { file: LocaleFile | null; errors: string[]; warnings: string[] };
export type Translator = (key: string, params?: Params) => string;

export const FALLBACK_LOCALE = "en";
// 會成為檔名，所以前端與 Rust 都用同一條規則驗證。
const LOCALE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const validLocaleCode = (code: unknown): code is string => typeof code === "string" && code.length <= 35 && LOCALE_CODE.test(code);

const PARAM = /\{([A-Za-z0-9_]+)\}/g;
export const paramsOf = (text: string): string[] => [...new Set([...text.matchAll(PARAM)].map((m) => m[1]))].sort();

export function parseLocaleFile(text: string, base?: Messages): ParsedLocale {
  const errors: string[] = [];
  const warnings: string[] = [];
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { return { file: null, errors: [`JSON: ${(e as Error).message}`], warnings }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { file: null, errors: ["root must be an object"], warnings };
  const root = data as Record<string, unknown>;
  const meta = root._meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object") errors.push("_meta is required");
  const locale = meta?.locale;
  if (!validLocaleCode(locale)) errors.push("_meta.locale is invalid");
  const name = typeof meta?.name === "string" && meta.name.trim() ? meta.name.trim() : String(locale ?? "");
  const raw = root.messages;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) errors.push("messages must be an object");
  const messages: Messages = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== "string") errors.push(`messages.${key} must be a string`);
      else messages[key] = value;
    }
  }
  if (errors.length) return { file: null, errors, warnings };
  if (base) {
    for (const key of Object.keys(messages)) {
      if (!(pluralBase(key) in base) && !(key in base)) warnings.push(`unknown key: ${key}`);
    }
    for (const key of placeholderMismatch(messages, base)) warnings.push(`placeholder mismatch: ${key}`);
  }
  return { file: { locale: locale as string, name, messages }, errors, warnings };
}

// `files.count.one` → `files.count`；複數 key 以基底 key 判斷是否存在。
const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;
const pluralBase = (key: string) => key.replace(PLURAL_SUFFIX, "");

function normalize(tag: string): string {
  const parts = tag.replace(/_/g, "-").split("-");
  const lang = parts[0].toLowerCase();
  const rest = parts.slice(1);
  if (lang === "zh") {
    const joined = rest.map((s) => s.toLowerCase());
    if (joined.includes("hant") || joined.some((s) => ["tw", "hk", "mo"].includes(s))) return "zh-Hant";
    if (joined.includes("hans") || joined.some((s) => ["cn", "sg"].includes(s))) return "zh-Hans";
    return "zh-Hans";
  }
  return [lang, ...rest.map((s, i) => (i === 0 && s.length === 4 ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s.length === 2 ? s.toUpperCase() : s))].join("-");
}

// 依序比對系統偏好：完整代碼 → 語言前綴；都沒有就用英文。
export function resolveLocale(setting: string, systemLanguages: readonly string[], available: readonly string[]): string {
  if (setting !== "system") return available.includes(setting) ? setting : FALLBACK_LOCALE;
  for (const tag of systemLanguages) {
    const code = normalize(tag);
    if (available.includes(code)) return code;
    const lang = code.split("-")[0];
    if (available.includes(lang)) return lang;
    const sibling = available.find((c) => c.split("-")[0] === lang);
    if (sibling && lang !== "zh") return sibling;
  }
  return FALLBACK_LOCALE;
}

// 使用者檔逐 key 覆蓋內建（內建檔唯讀）。
export const mergeLocales = (builtin: Messages | undefined, user: Messages | undefined): Messages => ({ ...(builtin ?? {}), ...(user ?? {}) });

export function createTranslator(messages: Messages, fallback: Messages, locale = FALLBACK_LOCALE): Translator {
  const rulesFor = (code: string) => { try { return new Intl.PluralRules(code); } catch { return new Intl.PluralRules(FALLBACK_LOCALE); } };
  const rules = rulesFor(locale);
  const fallbackRules = rulesFor(FALLBACK_LOCALE);
  return (key, params) => {
    let text: string | undefined;
    if (params && typeof params.n === "number") {
      // 目前語系用自己的複數規則；缺翻譯退回英文時要改用英文的規則，否則 "1 files"。
      const cat = rules.select(params.n);
      text = messages[`${key}.${cat}`] ?? messages[`${key}.other`];
      if (text === undefined) {
        const fcat = fallbackRules.select(params.n);
        text = fallback[`${key}.${fcat}`] ?? fallback[`${key}.other`];
      }
    }
    text ??= messages[key] ?? fallback[key] ?? key;
    return params ? text.replace(PARAM, (m, name) => (name in params ? String(params[name]) : m)) : text;
  };
}

// 編輯器用：以 en 的 key 為基準，列出尚未翻譯（缺少或為空字串）的 key。
export const missingKeys = (messages: Messages, base: Messages): string[] => Object.keys(base).filter((k) => !messages[k]?.trim());

export function placeholderMismatch(messages: Messages, base: Messages): string[] {
  return Object.keys(messages).filter((key) => {
    const ref = base[key];
    if (ref === undefined || !messages[key]) return false;
    return paramsOf(ref).join() !== paramsOf(messages[key]).join();
  });
}

// 只保留與內建不同的 key，使用者覆蓋檔才不會把整份內建複製一遍。
export function diffFromBuiltin(edited: Messages, builtin: Messages | undefined): Messages {
  const out: Messages = {};
  for (const [key, value] of Object.entries(edited)) if (value.trim() && value !== builtin?.[key]) out[key] = value;
  return out;
}

export const serializeLocale = (file: LocaleFile): string =>
  JSON.stringify({ _meta: { locale: file.locale, name: file.name }, messages: file.messages }, null, 2) + "\n";

// 目前啟用的翻譯函式。放在這個 DOM-free 模組，讓 files.ts、snippets.ts 這類純邏輯模組也能 import；
// 尚未載入語系時回傳 key 本身（測試可用 setActive 指定語系）。
let active: Translator = createTranslator({}, {});
let activeLocale = FALLBACK_LOCALE;
export const t: Translator = (key, params) => active(key, params);
export const currentLocale = () => activeLocale;
export function setActive(messages: Messages, fallback: Messages, locale: string) {
  active = createTranslator(messages, fallback, locale);
  activeLocale = locale;
}
