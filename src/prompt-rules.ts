// Matching rules for "an agent is waiting on you", kept as data so they can be
// maintained without recompiling: a built-in file (prompt-rules.json) plus an
// optional user file in the data directory. DOM-free so it can be tested directly.
export const PROMPT_KINDS = ["menu", "yesno", "confirm", "press-enter", "password", "login", "trust", "input"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];
// `exact`: the options are one contiguous numbered block 1..n with a single cursor row, so "row N" on screen is
// `options[N]` and arrow keys move one row at a time. Only then may a card press keys for the person.
export type Prompt = { kind: PromptKind; label: string; question: string; options: string[]; selected?: number; low?: boolean; exact?: boolean };
export const SCOPES = ["last", "tail", "after-rule", "box-body", "above-box"] as const;
export type Scope = (typeof SCOPES)[number];
export type CompiledRule = {
  id: string;
  kind: PromptKind;
  label: string;
  scope: Scope;
  low: boolean;
  re?: RegExp;
  not?: RegExp[];
  layout?: "cursor-menu" | "confirm-menu";
  confirmText?: string;
};
// 閒置的背景行程（例如 dotnet 建置伺服器）：不算「仍在執行」。name 為行程名（完全相符），args 為命令列必須全部包含的字串。
export type IdleProcess = { name: string; args?: string[] };
export type CompiledRules = { agents: string[]; footers: RegExp[]; working: RegExp[]; idle: IdleProcess[]; rules: CompiledRule[] };
// 錯誤以結構化資料回傳（key＋參數），顯示時才翻譯（formatRuleError），避免驗證邏輯依賴 UI 語系。
export type RuleErrorSource = "builtin" | "user";
export type RuleError = { key: string; source: RuleErrorSource; params: Record<string, string | number> };
export const formatRuleError = (e: RuleError, t: (key: string, params?: Record<string, string | number>) => string) =>
  t(e.key, { ...e.params, source: t(`rules.source.${e.source}`) });
const fail = (errors: RuleError[], source: RuleErrorSource, key: string, params: RuleError["params"] = {}) => { errors.push({ key: `rules.err.${key}`, source, params }); };
type Parsed = { agents: string[]; footers: string[]; working: string[]; idle: IdleProcess[]; disable: string[]; rules: CompiledRule[] };

// "\\d+\\.\\d+\\.\\d+": Claude Code's native binary is named after its version (e.g. 2.1.296).
export const DEFAULT_AGENTS = ["claude", "codex", "gemini", "copilot", "aider", "opencode", "\\d+\\.\\d+\\.\\d+", "node", "python3?", "bun", "deno"];
const LAYOUTS = ["cursor-menu", "confirm-menu"];

function strings(value: unknown, field: string, source: RuleErrorSource, errors: RuleError[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) { fail(errors, source, "array", { field }); return []; }
  return value as string[];
}
function compileRegex(pattern: string, flags: string, source: RuleErrorSource, key: string, params: RuleError["params"], errors: RuleError[]): RegExp | undefined {
  try { return new RegExp(pattern, flags); } catch (error) { fail(errors, source, key, { ...params, message: (error as Error).message }); }
}
function idleProcesses(value: unknown, source: RuleErrorSource, errors: RuleError[]): IdleProcess[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { fail(errors, source, "idle", { index: 0 }); return []; }
  const out: IdleProcess[] = [];
  value.forEach((raw, index) => {
    const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const args = r.args === undefined ? [] : r.args;
    if (typeof r.name !== "string" || !r.name || !Array.isArray(args) || args.some((arg) => typeof arg !== "string" || !arg)) { fail(errors, source, "idle", { index: index + 1 }); return; }
    out.push(args.length ? { name: r.name, args: args as string[] } : { name: r.name });
  });
  return out;
}
// Validate one rules document (already JSON.parse'd). Every problem is collected.
function parseDocument(doc: unknown, source: RuleErrorSource, errors: RuleError[]): Parsed {
  const out: Parsed = { agents: [], footers: [], working: [], idle: [], disable: [], rules: [] };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) { fail(errors, source, "root"); return out; }
  const file = doc as Record<string, unknown>;
  out.agents = strings(file.agents, "agents", source, errors);
  out.footers = strings(file.footers, "footers", source, errors);
  out.working = strings(file.working, "working", source, errors);
  out.disable = strings(file.disable, "disable", source, errors);
  out.idle = idleProcesses(file.idle, source, errors);
  for (const [field, list] of [["agents", out.agents], ["footers", out.footers], ["working", out.working]] as const) {
    for (const pattern of list) compileRegex(pattern, "i", source, "regexField", { field, pattern }, errors);
  }
  const rules = file.rules === undefined ? [] : file.rules;
  if (!Array.isArray(rules)) { fail(errors, source, "rulesArray"); return out; }
  const seen = new Set<string>();
  rules.forEach((raw, index) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = typeof r.id === "string" && r.id ? r.id : "";
    const at = { index: index + 1, id: id ? ` (${id})` : "" };
    if (!id) { fail(errors, source, "noId", at); return; }
    if (seen.has(id)) { fail(errors, source, "dupId", at); return; }
    seen.add(id);
    if (!PROMPT_KINDS.includes(r.kind as PromptKind)) { fail(errors, source, "kind", { ...at, allowed: PROMPT_KINDS.join(" / ") }); return; }
    if (typeof r.label !== "string" || !r.label) { fail(errors, source, "noLabel", at); return; }
    const scope = r.scope === undefined ? "last" : r.scope;
    if (!SCOPES.includes(scope as Scope)) { fail(errors, source, "scope", { ...at, allowed: SCOPES.join(" / ") }); return; }
    if (r.confidence !== undefined && r.confidence !== "low" && r.confidence !== "high") { fail(errors, source, "confidence", at); return; }
    const rule: CompiledRule = { id, kind: r.kind as PromptKind, label: r.label, scope: scope as Scope, low: r.confidence === "low" };
    if (r.not !== undefined) {
      const patterns = strings(r.not, `rule #${index + 1}${at.id} not`, source, errors);
      const compiled = patterns.map((pattern) => compileRegex(pattern, "i", source, "regexNot", { ...at, pattern }, errors));
      if (compiled.some((re) => !re)) return;
      rule.not = compiled as RegExp[];
    }
    if (r.layout !== undefined) {
      if (typeof r.layout !== "string" || !LAYOUTS.includes(r.layout)) { fail(errors, source, "layout", { ...at, allowed: LAYOUTS.join(" / ") }); return; }
      rule.layout = r.layout as CompiledRule["layout"];
      if (typeof r.confirmText === "string") rule.confirmText = r.confirmText.toLowerCase();
    } else {
      if (typeof r.pattern !== "string" || !r.pattern) { fail(errors, source, "noPattern", at); return; }
      const re = compileRegex(r.pattern, typeof r.flags === "string" ? r.flags : "", source, "regexRule", at, errors);
      if (!re) return;
      rule.re = re;
    }
    out.rules.push(rule);
  });
  return out;
}
function parseText(text: string, source: RuleErrorSource, errors: RuleError[]): Parsed | undefined {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (error) { fail(errors, source, "json", { message: (error as Error).message }); return undefined; }
  const before = errors.length;
  const parsed = parseDocument(doc, source, errors);
  return errors.length === before ? parsed : undefined;
}
const unique = (list: string[]) => [...new Set(list)];

// builtinText is the shipped file; userText the optional override. A broken
// user file is ignored as a whole (errors say why) so detection never goes dark.
export function buildRules(builtinText: string, userText?: string): { rules: CompiledRules; errors: RuleError[]; userRules: number; userBroken: boolean } {
  const errors: RuleError[] = [];
  const builtin = parseText(builtinText, "builtin", errors) ?? { agents: DEFAULT_AGENTS, footers: [], working: [], idle: [], disable: [], rules: [] };
  const userErrors: RuleError[] = [];
  const user = userText && userText.trim() ? parseText(userText, "user", userErrors) : undefined;
  errors.push(...userErrors);
  const disabled = new Set(user?.disable ?? []);
  const own = new Set((user?.rules ?? []).map((rule) => rule.id));
  const rules = [...(user?.rules ?? []), ...builtin.rules.filter((rule) => !disabled.has(rule.id) && !own.has(rule.id))];
  const agents = unique([...builtin.agents, ...(user?.agents ?? [])]);
  const footers = unique([...builtin.footers, ...(user?.footers ?? [])]).map((pattern) => new RegExp(pattern, "i"));
  const working = unique([...builtin.working, ...(user?.working ?? [])]).map((pattern) => new RegExp(pattern, "i"));
  const idleSeen = new Set<string>();
  const idle = [...builtin.idle, ...(user?.idle ?? [])].filter((item) => { const key = JSON.stringify(item); return idleSeen.has(key) ? false : (idleSeen.add(key), true); });
  return { rules: { agents: agents.length ? agents : DEFAULT_AGENTS, footers, working, idle, rules }, errors, userRules: user?.rules.length ?? 0, userBroken: userErrors.length > 0 };
}
