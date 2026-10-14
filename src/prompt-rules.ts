// Matching rules for "an agent is waiting on you", kept as data so they can be
// maintained without recompiling: a built-in file (prompt-rules.json) plus an
// optional user file in the data directory. DOM-free so it can be tested directly.
export const PROMPT_KINDS = ["menu", "yesno", "confirm", "press-enter", "password", "login", "trust", "input"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];
export type Prompt = { kind: PromptKind; label: string; question: string; options: string[]; selected?: number; low?: boolean };
export type Scope = "last" | "tail";
export type CompiledRule = {
  id: string;
  kind: PromptKind;
  label: string;
  scope: Scope;
  low: boolean;
  re?: RegExp;
  layout?: "cursor-menu" | "confirm-menu";
  confirmText?: string;
};
export type CompiledRules = { agents: string[]; footers: RegExp[]; rules: CompiledRule[] };
type Parsed = { agents: string[]; footers: string[]; disable: string[]; rules: CompiledRule[] };

// "\\d+\\.\\d+\\.\\d+": Claude Code's native binary is named after its version (e.g. 2.1.296).
export const DEFAULT_AGENTS = ["claude", "codex", "gemini", "copilot", "aider", "opencode", "\\d+\\.\\d+\\.\\d+", "node", "python3?", "bun", "deno"];
const LAYOUTS = ["cursor-menu", "confirm-menu"];

function strings(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) { errors.push(`${field} 必須是字串陣列`); return []; }
  return value as string[];
}
function compileRegex(pattern: string, flags: string, where: string, errors: string[]): RegExp | undefined {
  try { return new RegExp(pattern, flags); } catch (error) { errors.push(`${where}：正規表示式無法編譯（${(error as Error).message}）`); }
}
// Validate one rules document (already JSON.parse'd). Every problem is collected.
function parseDocument(doc: unknown, source: string, errors: string[]): Parsed {
  const out: Parsed = { agents: [], footers: [], disable: [], rules: [] };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) { errors.push(`${source}：最外層必須是物件`); return out; }
  const file = doc as Record<string, unknown>;
  out.agents = strings(file.agents, `${source} agents`, errors);
  out.footers = strings(file.footers, `${source} footers`, errors);
  out.disable = strings(file.disable, `${source} disable`, errors);
  for (const [field, list] of [["agents", out.agents], ["footers", out.footers]] as const) {
    for (const pattern of list) compileRegex(pattern, "i", `${source} ${field}「${pattern}」`, errors);
  }
  const rules = file.rules === undefined ? [] : file.rules;
  if (!Array.isArray(rules)) { errors.push(`${source} rules 必須是陣列`); return out; }
  const seen = new Set<string>();
  rules.forEach((raw, index) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = typeof r.id === "string" && r.id ? r.id : "";
    const where = `${source} 規則 #${index + 1}${id ? `（${id}）` : ""}`;
    if (!id) { errors.push(`${where}：缺少 id`); return; }
    if (seen.has(id)) { errors.push(`${where}：id 重複`); return; }
    seen.add(id);
    if (!PROMPT_KINDS.includes(r.kind as PromptKind)) { errors.push(`${where}：kind 必須是 ${PROMPT_KINDS.join("／")}`); return; }
    if (typeof r.label !== "string" || !r.label) { errors.push(`${where}：缺少 label`); return; }
    const scope = r.scope === undefined ? "last" : r.scope;
    if (scope !== "last" && scope !== "tail") { errors.push(`${where}：scope 必須是 last 或 tail`); return; }
    if (r.confidence !== undefined && r.confidence !== "low" && r.confidence !== "high") { errors.push(`${where}：confidence 必須是 low 或 high`); return; }
    const rule: CompiledRule = { id, kind: r.kind as PromptKind, label: r.label, scope, low: r.confidence === "low" };
    if (r.layout !== undefined) {
      if (typeof r.layout !== "string" || !LAYOUTS.includes(r.layout)) { errors.push(`${where}：layout 必須是 ${LAYOUTS.join("／")}`); return; }
      rule.layout = r.layout as CompiledRule["layout"];
      if (typeof r.confirmText === "string") rule.confirmText = r.confirmText.toLowerCase();
    } else {
      if (typeof r.pattern !== "string" || !r.pattern) { errors.push(`${where}：需要 pattern 或 layout`); return; }
      const re = compileRegex(r.pattern, typeof r.flags === "string" ? r.flags : "", where, errors);
      if (!re) return;
      rule.re = re;
    }
    out.rules.push(rule);
  });
  return out;
}
function parseText(text: string, source: string, errors: string[]): Parsed | undefined {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (error) { errors.push(`${source}：JSON 格式錯誤（${(error as Error).message}）`); return undefined; }
  const before = errors.length;
  const parsed = parseDocument(doc, source, errors);
  return errors.length === before ? parsed : undefined;
}
const unique = (list: string[]) => [...new Set(list)];

// builtinText is the shipped file; userText the optional override. A broken
// user file is ignored as a whole (errors say why) so detection never goes dark.
export function buildRules(builtinText: string, userText?: string): { rules: CompiledRules; errors: string[]; userRules: number } {
  const errors: string[] = [];
  const builtin = parseText(builtinText, "內建規則", errors) ?? { agents: DEFAULT_AGENTS, footers: [], disable: [], rules: [] };
  const userErrors: string[] = [];
  const user = userText && userText.trim() ? parseText(userText, "使用者規則", userErrors) : undefined;
  errors.push(...userErrors);
  const disabled = new Set(user?.disable ?? []);
  const own = new Set((user?.rules ?? []).map((rule) => rule.id));
  const rules = [...(user?.rules ?? []), ...builtin.rules.filter((rule) => !disabled.has(rule.id) && !own.has(rule.id))];
  const agents = unique([...builtin.agents, ...(user?.agents ?? [])]);
  const footers = unique([...builtin.footers, ...(user?.footers ?? [])]).map((pattern) => new RegExp(pattern, "i"));
  return { rules: { agents: agents.length ? agents : DEFAULT_AGENTS, footers, rules }, errors, userRules: user?.rules.length ?? 0 };
}
