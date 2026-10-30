// 頁籤／收藏的額外環境變數：解析、格式化、讀檔時的正規化。純邏輯，錯誤回結構化資料（顯示時才翻譯）。
export type EnvError = { line: number; code: "syntax" | "name" | "reserved" | "duplicate" };
export type Env = Record<string, string>;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reserved = (name: string) => name.toUpperCase().startsWith("HIGHOSTTY_");

// 一行一個 KEY=value；空行與 # 開頭略過。值照字面保留（不展開、不去引號）。
export function parseEnv(text: string): { env: Env; errors: EnvError[] } {
  const env: Env = {};
  const errors: EnvError[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim() || raw.trimStart().startsWith("#")) return;
    const eq = raw.indexOf("=");
    if (eq < 0) { errors.push({ line, code: "syntax" }); return; }
    const name = raw.slice(0, eq).trim();
    if (!NAME.test(name)) errors.push({ line, code: "name" });
    else if (reserved(name)) errors.push({ line, code: "reserved" });
    else if (Object.hasOwn(env, name)) errors.push({ line, code: "duplicate" });
    else env[name] = raw.slice(eq + 1);
  });
  return { env, errors };
}

export function formatEnv(env: Env | undefined): string {
  return Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n");
}

// 讀 session.json／收藏時過濾不合法的項目；沒有任何項目回 undefined。
export function normalizeEnv(value: unknown): Env | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const env: Env = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "string" && NAME.test(key) && !reserved(key)) env[key] = item;
  return Object.keys(env).length ? env : undefined;
}

export const sameEnv = (a: Env | undefined, b: Env | undefined) => formatEnv(a) === formatEnv(b);
