// Pure logic for the agent control socket: `highostty ctl <words…>` sends its argv
// as-is, and everything about what a command means (names, flags, which ones are
// allowed in which mode, how replies look) lives here so it can be tested. DOM-free.
export const CONTROL_MODES = ["off", "readonly", "full"] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];
export const DEFAULT_CONTROL_MODE: ControlMode = "readonly";

import type { AgentState } from "./attention";

export type FlagKind = "string" | "number" | "boolean" | "list";
export type OpSpec = {
  // One or more words, e.g. "tab list".
  name: string;
  // Changes the app or types into a terminal; needs mode "full".
  write: boolean;
  summary: string;
  // Positional arguments in order; a trailing "?" marks an optional one.
  args?: string[];
  flags?: Record<string, FlagKind>;
  // Accepts `-- …` and returns what follows as `rest` (a command line to run).
  rest?: boolean;
  // Name of a trailing positional that takes any number of values (returned in `rest`).
  variadic?: string;
  // Which window answers: "caller" (default) the window of the calling terminal;
  // "surface" the window that owns the terminal named by the first positional;
  // "all" every window, results merged (list commands).
  scope?: "caller" | "surface" | "all";
  // Reads a JSON document from the CLI's stdin (`--json-stdin`), passed to the app as `input`.
  stdin?: boolean;
};

// Keys `surface key` can send, by logical name (the native side owns the key codes).
export const KEY_NAMES = ["enter", "tab", "esc", "backspace", "up", "down", "left", "right"] as const;
const KEY_HINT = `${KEY_NAMES.join("、")}、ctrl+a 到 ctrl+z`;
export function validKey(name: string): boolean {
  return (KEY_NAMES as readonly string[]).includes(name) || /^ctrl\+[a-z]$/.test(name);
}

// Agents `agent start` can launch; the name is also the executable.
export const AGENT_KINDS = ["claude", "codex", "gemini", "opencode", "copilot", "aider"] as const;

export const OPS: OpSpec[] = [
  { name: "ping", write: false, summary: "確認 HiGhostty 控制指令可用" },
  { name: "whoami", write: false, summary: "呼叫者所在的視窗、頁籤與終端機" },
  { name: "help", write: false, summary: "列出所有指令" },
  { name: "window list", write: false, scope: "all", summary: "列出所有視窗" },
  { name: "tab list", write: false, scope: "all", flags: { here: "boolean" }, summary: "列出各視窗的頁籤與終端機（--here 只列呼叫者所在的視窗）" },
  { name: "agent list", write: false, scope: "all", flags: { here: "boolean" }, summary: "列出偵測到 agent 的終端機與狀態 blocked／working／idle（--here 只列呼叫者所在的視窗）" },
  { name: "surface read", write: false, scope: "surface", args: ["id"], flags: { lines: "number", scrollback: "boolean" }, summary: "讀終端機畫面；--lines 只取最後 N 行，--scrollback 含捲動緩衝" },
  { name: "surface wait", write: false, scope: "surface", args: ["id"], flags: { match: "list", regex: "string", lines: "number" }, summary: "等輸出出現（--match 字串可多個、--regex）；檢查最後 --lines 行（預設 200）含捲動緩衝；用 --timeout 限時" },
  { name: "tab new", write: true, flags: { cwd: "string", tmux: "boolean", focus: "boolean" }, rest: true, summary: "開新頁籤（預設在背景、不搶焦點，--focus 才切過去）；-- 後面是要在 shell 裡執行的命令（--tmux 時改為 tmux 頁籤的啟動命令，命令結束頁籤就關閉）" },
  { name: "surface run", write: true, scope: "surface", args: ["id"], rest: true, summary: "在終端機的 shell 提示字元送出一行命令並按 Enter；shell 忙碌時回 busy。-- 後只有一個字詞時視為完整命令列，多個字詞時各自加引號" },
  { name: "surface key", write: true, scope: "surface", args: ["id", "key"], summary: `送出一個按鍵：${KEY_HINT}` },
  { name: "alert raise", write: false, flags: { title: "string", body: "string", option: "list" }, summary: "對使用者發出待處理提示（待處理面板與頁籤上顯示標題、說明與選項）；使用者正在看這個終端機時不會提示。--title 必填" },
  { name: "alert clear", write: false, summary: "清除自己發出的待處理提示" },
  { name: "tab status", write: false, args: ["text?"], flags: { clear: "boolean" }, summary: "在頁籤列顯示一行短狀態（最多 40 字，不會存入工作階段）；--clear 清除" },
  { name: "preview open", write: false, args: ["path"], flags: { side: "string" }, summary: "在呼叫者所在頁籤的檔案浮層右半開預覽顯示檔案（Markdown 會排版；浮層沒開會自動展開），檔案被改動時自動更新，不必重開；--side 已無作用（相容舊用法，忽略）。相對路徑以呼叫者的目錄為準；不搶焦點" },
  { name: "preview window", write: true, args: ["path"], summary: "把檔案加到獨立預覽視窗的新頁籤（同樣會自動更新；所有檔案共用一個視窗，同一個檔案只開一個頁籤，不搶焦點，使用者自行關閉）。可能多出視窗，所以需要完整模式；相對路徑以呼叫者的目錄為準" },
  { name: "preview close", write: false, summary: "關閉呼叫者所在頁籤的預覽（檔案浮層本身不關）" },
  { name: "preview status", write: false, summary: "呼叫者所在頁籤目前預覽的檔案；沒有開則 preview 為 null" },
  { name: "files reveal", write: true, variadic: "path", summary: "在 Finder 顯示檔案（會把 Finder 帶到前景）；相對路徑以呼叫者的目錄為準" },
  { name: "files quicklook", write: true, variadic: "path", summary: "用 Quick Look 預覽檔案給使用者看（會取得視窗的鍵盤焦點，使用者按空白鍵或 Esc 關閉）" },
  { name: "snippet add", write: true, flags: { name: "string", text: "string", scope: "string", keyword: "list" }, summary: "新增指令片段到 ⌘⇧P 面板：--name、--text 必填；--scope global、cwd（呼叫者目前的目錄，預設）或絕對目錄。片段不會自動執行，由使用者在面板選取" },
  { name: "agent start", write: true, args: ["kind"], flags: { cwd: "string", focus: "boolean" }, rest: true, summary: `在新頁籤（預設背景）啟動 agent（${AGENT_KINDS.join("、")}），等它就緒後回傳 surface id；-- 後是傳給 agent 的參數；用 --timeout 限時（預設 30 秒）` },
  { name: "agent prompt", write: true, scope: "surface", args: ["id", "text"], flags: { wait: "boolean" }, summary: "對終端機裡的 agent 送出一段 prompt 並按 Enter。agent 正在等人回答（blocked）時回 agent_blocked、什麼都不送；不能對自己送。--wait 等這一輪結束（先觀察到 working 或 blocked，5 秒內沒有回 agent_prompt_stalled），搭配 --timeout" },
  { name: "agent keys", write: true, scope: "surface", args: ["id"], variadic: "key", summary: `對 agent 送出按鍵（依序）：${KEY_HINT}；先全部驗證才送。不能對自己送` },
  { name: "agent wait", write: false, scope: "surface", args: ["id"], flags: { until: "string" }, summary: "等 agent 到 idle／blocked／working（預設 idle 或 blocked）；用 --timeout 限時" },
];

// Flags every command accepts. `--timeout` (ms) bounds how long the CLI waits for the reply.
const GLOBAL_FLAGS: Record<string, FlagKind> = { timeout: "number" };

export type ErrorCode = "disabled" | "forbidden" | "busy" | "agent_blocked" | "agent_prompt_stalled" | "unknown_op" | "bad_args" | "not_found" | "failed" | "timeout" | "unavailable";
export type Reply = { ok: true; result: unknown } | { ok: false; error: { code: ErrorCode; message: string } };
export const okReply = (result: unknown): Reply => ({ ok: true, result });
export const errReply = (code: ErrorCode, message: string): Reply => ({ ok: false, error: { code, message } });

// What a window tells the server about a request: it is the one that answers
// ("owner"), one of several that each contribute a part ("part"), or not involved.
export type Claim = "owner" | "part" | "none";
export function claimFor({ op, args }: Parsed, here: { callerHere: boolean; ownsSurface: (id: string) => boolean }): Claim {
  switch (op.scope ?? "caller") {
    case "all": return "part";
    case "surface": return here.ownsSurface(args[(op.args?.[0] ?? "").replace(/\?$/, "")] ?? "") ? "owner" : "none";
    default: return here.callerHere ? "owner" : "none";
  }
}

export type Caller = { surface?: string; tmuxSession?: string };
export type Parsed = {
  op: OpSpec;
  args: Record<string, string>;
  flags: Record<string, string | number | boolean | string[]>;
  rest: string[];
};

export function usage(op: OpSpec): string {
  const args = (op.args ?? []).map((name) => (name.endsWith("?") ? `[<${name.slice(0, -1)}>]` : `<${name}>`));
  const flags = Object.entries(op.flags ?? {}).map(([name, kind]) => (kind === "boolean" ? `[--${name}]` : `[--${name} <${kind === "list" ? "string…" : kind}>]`));
  return ["highostty ctl", op.name, ...args, ...(op.variadic ? [`<${op.variadic}…>`] : []), ...flags, ...(op.rest ? ["[-- <command…>]"] : [])].join(" ");
}

export function helpResult(): { commands: { name: string; write: boolean; usage: string; summary: string }[] } {
  return { commands: OPS.map((op) => ({ name: op.name, write: op.write, usage: usage(op), summary: op.summary })) };
}

// Longest command name that is a prefix of argv wins ("tab list" before "tab").
function findOp(argv: string[]): { op: OpSpec; used: number } | undefined {
  let best: { op: OpSpec; used: number } | undefined;
  for (const op of OPS) {
    const words = op.name.split(" ");
    if (words.every((word, index) => argv[index] === word) && (!best || words.length > best.used)) best = { op, used: words.length };
  }
  return best;
}

export function parseArgv(argv: unknown): { ok: true; parsed: Parsed } | { ok: false; reply: Reply } {
  const bad = (code: ErrorCode, message: string) => ({ ok: false as const, reply: errReply(code, message) });
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string")) return bad("bad_args", "argv 必須是字串陣列");
  const words = argv.length ? (argv as string[]) : ["help"];
  const found = findOp(words);
  if (!found) return bad("unknown_op", `未知的指令「${words.slice(0, 2).join(" ")}」；用 highostty ctl help 查看`);
  const { op } = found;
  const specs = { ...GLOBAL_FLAGS, ...(op.flags ?? {}) };
  const positional = op.args ?? [];
  const parsed: Parsed = { op, args: {}, flags: {}, rest: [] };
  const given: string[] = [];
  const tokens = words.slice(found.used);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--") {
      if (!op.rest) return bad("bad_args", `${op.name} 不接受 --`);
      parsed.rest = tokens.slice(index + 1);
      break;
    }
    if (!token.startsWith("--") || token.length === 2) { given.push(token); continue; }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq < 0 ? undefined : eq);
    const kind = specs[name];
    if (!kind) return bad("bad_args", `${op.name} 沒有 --${name} 這個選項`);
    let value: string | undefined = eq < 0 ? undefined : token.slice(eq + 1);
    if (kind === "boolean") {
      if (value !== undefined && value !== "true" && value !== "false") return bad("bad_args", `--${name} 不需要值`);
      parsed.flags[name] = value !== "false";
      continue;
    }
    if (value === undefined) {
      value = tokens[++index];
      if (value === undefined) return bad("bad_args", `--${name} 需要一個值`);
    }
    if (kind === "number") {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number)) return bad("bad_args", `--${name} 必須是數字`);
      parsed.flags[name] = number;
    } else if (kind === "list") {
      parsed.flags[name] = [...((parsed.flags[name] as string[] | undefined) ?? []), value];
    } else parsed.flags[name] = value;
  }
  if (op.variadic) parsed.rest = [...parsed.rest, ...given.splice(positional.length)];
  if (given.length > positional.length) return bad("bad_args", `${op.name} 多了參數「${given[positional.length]}」；用法：${usage(op)}`);
  for (const [index, name] of positional.entries()) {
    const optional = name.endsWith("?");
    if (index < given.length) parsed.args[optional ? name.slice(0, -1) : name] = given[index];
    else if (!optional) return bad("bad_args", `缺少 <${name}>；用法：${usage(op)}`);
  }
  return { ok: true, parsed };
}

// null when allowed.
export function authorize(mode: unknown, op: OpSpec): Reply | null {
  if (mode !== "readonly" && mode !== "full") return errReply("disabled", "agent 控制指令已關閉；請在 HiGhostty 設定開啟");
  if (op.write && mode !== "full") return errReply("forbidden", "這個指令會改動終端機或送出輸入；請在 HiGhostty 設定把「agent 控制指令」改為「完整」");
  return null;
}

// The surface a request came from. Inside tmux the session name wins: it is set per session with
// `new-session -e`, while HIGHOSTTY_SURFACE_ID leaks in from the tmux server's global environment
// (whichever terminal started the server), so every tmux pane would otherwise look like that terminal.
export function resolveCaller(caller: unknown, surfaces: Iterable<{ id: string; tmuxSession?: string }>): string | undefined {
  if (!caller || typeof caller !== "object") return undefined;
  const { surface, tmuxSession } = caller as Caller;
  const list = [...surfaces];
  if (typeof tmuxSession === "string" && tmuxSession) return list.find((item) => item.tmuxSession === tmuxSession)?.id;
  if (typeof surface === "string" && list.some((item) => item.id === surface)) return surface;
  return undefined;
}

// The last `count` lines of terminal text, without the blank tail a screen leaves.
export function tailLines(text: string, count: number): string {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-Math.max(1, Math.floor(count))).join("\n");
}
// The first line containing one of the literals or matching the regex; undefined when none does.
export type Matcher = { literals: string[]; regex?: RegExp };
export function makeMatcher(flags: Parsed["flags"]): { ok: true; matcher: Matcher } | { ok: false; reply: Reply } {
  const literals = Array.isArray(flags.match) ? flags.match.filter(Boolean) : [];
  let regex: RegExp | undefined;
  if (typeof flags.regex === "string" && flags.regex) {
    try { regex = new RegExp(flags.regex); } catch (error) { return { ok: false, reply: errReply("bad_args", `--regex 無法編譯：${(error as Error).message}`) }; }
  }
  if (!literals.length && !regex) return { ok: false, reply: errReply("bad_args", "需要 --match 或 --regex") };
  return { ok: true, matcher: { literals, regex } };
}
export function findMatch(text: string, { literals, regex }: Matcher): string | undefined {
  return text.split("\n").find((line) => literals.some((literal) => line.includes(literal)) || regex?.test(line));
}
// `agent wait`: no target means "settled" (idle or blocked).
export const WAIT_STATES = ["idle", "blocked", "working"] as const;
export function waitSatisfied(state: AgentState, until: string | undefined): boolean {
  return until ? state === until : state === "idle" || state === "blocked";
}
export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 600_000;
export function waitLimit(timeout: unknown): number {
  return typeof timeout === "number" && timeout > 0 ? Math.min(timeout, MAX_WAIT_MS) : DEFAULT_WAIT_MS;
}

// A command line from the words after `--`. One word is a whole shell line, typed as given
// (`-- "npm run dev && echo up"`); several words are an argv, each quoted so it stays one word.
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
export const shellQuote = (word: string) => (SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
export function commandLine(rest: string[]): string {
  return rest.length === 1 ? rest[0] : rest.map(shellQuote).join(" ");
}
// A line typed into a shell must be a single line of reasonable length.
export const MAX_COMMAND_CHARS = 8000;
export function commandProblem(line: string): string | undefined {
  if (!line.trim()) return "缺少命令；用 -- 接在後面";
  if (/[\r\n\0]/.test(line)) return "命令不可包含換行";
  if (line.length > MAX_COMMAND_CHARS) return `命令太長（上限 ${MAX_COMMAND_CHARS} 字元）`;
  return undefined;
}
// pane_current_command values that mean "a shell at its prompt".
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "elvish"]);
export const isShellName = (command: string) => SHELLS.has(command.replace(/^-/, ""));

// `alert raise`: what the user will read. Title is required; everything is bounded.
export const ALERT_LIMITS = { title: 80, body: 2000, option: 120, options: 12 };
export type AlertInput = { title: string; body: string; options: string[] };
export function alertInput(flags: Parsed["flags"]): { ok: true; input: AlertInput } | { ok: false; reply: Reply } {
  const bad = (message: string) => ({ ok: false as const, reply: errReply("bad_args", message) });
  const title = typeof flags.title === "string" ? flags.title.trim() : "";
  const body = typeof flags.body === "string" ? flags.body.trim() : "";
  const options = (Array.isArray(flags.option) ? flags.option : []).map((option) => option.trim()).filter(Boolean);
  if (!title) return bad("需要 --title");
  if (title.length > ALERT_LIMITS.title || /[\r\n]/.test(title)) return bad(`--title 必須是單行，最多 ${ALERT_LIMITS.title} 字`);
  if (body.length > ALERT_LIMITS.body) return bad(`--body 最多 ${ALERT_LIMITS.body} 字`);
  if (options.length > ALERT_LIMITS.options || options.some((option) => option.length > ALERT_LIMITS.option)) return bad(`--option 最多 ${ALERT_LIMITS.options} 個、每個最多 ${ALERT_LIMITS.option} 字`);
  return { ok: true, input: { title, body, options } };
}

// `tab status`: one short line.
export const STATUS_MAX_CHARS = 40;
export function statusText(text: string | undefined): string | undefined {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line ? (line.length > STATUS_MAX_CHARS ? line.slice(0, STATUS_MAX_CHARS - 1) + "…" : line) : undefined;
}

// `snippet add`. Scope "cwd" means the caller's directory. Agent-made snippets never auto-run.
export const SNIPPET_LIMITS = { name: 100, text: 8000, keyword: 40, keywords: 10 };
export type SnippetInput = { name: string; text: string; scope: string; keywords?: string };
export function snippetInput(flags: Parsed["flags"], cwd: string | undefined): { ok: true; input: SnippetInput } | { ok: false; reply: Reply } {
  const bad = (message: string) => ({ ok: false as const, reply: errReply("bad_args", message) });
  const name = typeof flags.name === "string" ? flags.name.trim() : "";
  const text = typeof flags.text === "string" ? flags.text : "";
  if (!name || !text.trim()) return bad("需要 --name 與 --text");
  if (name.length > SNIPPET_LIMITS.name || /[\r\n]/.test(name)) return bad(`--name 必須是單行，最多 ${SNIPPET_LIMITS.name} 字`);
  if (text.length > SNIPPET_LIMITS.text || text.includes("\0")) return bad(`--text 最多 ${SNIPPET_LIMITS.text} 字，且不可含 NUL`);
  const requested = typeof flags.scope === "string" ? flags.scope.trim() : "cwd";
  const scope = requested === "cwd" ? cwd : requested;
  if (scope !== "global" && !(scope && scope.startsWith("/"))) return bad(cwd === undefined && requested === "cwd" ? "找不到呼叫者的目前目錄；請用 --scope global 或絕對目錄" : "--scope 必須是 global、cwd 或絕對目錄");
  const keywords = (Array.isArray(flags.keyword) ? flags.keyword : []).map((word) => word.trim()).filter(Boolean);
  if (keywords.length > SNIPPET_LIMITS.keywords || keywords.some((word) => word.length > SNIPPET_LIMITS.keyword || /\s/.test(word))) return bad(`--keyword 最多 ${SNIPPET_LIMITS.keywords} 個，每個不含空白、最多 ${SNIPPET_LIMITS.keyword} 字`);
  return { ok: true, input: { name, text, scope, keywords: keywords.length ? keywords.join(" ") : undefined } };
}

// `agent start <kind> -- args…`: the shell line that launches it (each word quoted).
export function agentCommand(kind: string, rest: string[]): { ok: true; line: string } | { ok: false; reply: Reply } {
  if (!(AGENT_KINDS as readonly string[]).includes(kind)) return { ok: false, reply: errReply("bad_args", `不支援的 agent「${kind}」；可用：${AGENT_KINDS.join("、")}`) };
  const line = [kind, ...rest].map(shellQuote).join(" ");
  const problem = commandProblem(line);
  return problem ? { ok: false, reply: errReply("bad_args", problem) } : { ok: true, line };
}
// `agent prompt`: a prompt may span lines (it is pasted, so newlines do not submit it).
export const MAX_PROMPT_CHARS = 20_000;
export function promptProblem(text: string): string | undefined {
  if (!text.trim()) return "prompt 不可為空";
  if (text.length > MAX_PROMPT_CHARS) return `prompt 太長（上限 ${MAX_PROMPT_CHARS} 字元）`;
  if (text.includes("\0")) return "prompt 不可含 NUL";
  return undefined;
}
// `agent keys`: every key is checked before any is sent.
export const MAX_KEYS = 20;
export function keysProblem(keys: string[]): string | undefined {
  if (!keys.length) return `缺少按鍵；可用：${KEY_HINT}`;
  if (keys.length > MAX_KEYS) return `一次最多 ${MAX_KEYS} 個按鍵`;
  const bad = keys.find((key) => !validKey(key));
  return bad === undefined ? undefined : `不支援的按鍵「${bad}」；可用：${KEY_HINT}`;
}
// After submitting, how long to wait for the agent to visibly start (working) or ask (blocked).
export const PROMPT_STALL_MS = 5_000;
// A state counts only once it is seen on two polls in a row, so a one-frame flicker
// between tool calls does not end a wait.
export function confirmedState(previous: AgentState | undefined, current: AgentState, accept: (state: AgentState) => boolean): boolean {
  return accept(current) && previous === current;
}
// `agent start`: ready once the screen is unchanged between two polls and is idle or asking.
export function startReady(previousText: string | undefined, text: string, state: AgentState): boolean {
  return text.trim() !== "" && text === previousText && (state === "idle" || state === "blocked");
}
