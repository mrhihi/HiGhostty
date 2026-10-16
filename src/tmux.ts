// tmux 持久化的純邏輯：session 命名、啟動命令、工作階段快照。
import { t } from "./i18n.ts";
export const SESSION_PREFIX = "hg-";

export function newSessionName(random: () => number = Math.random): string {
  let id = "";
  while (id.length < 8) id += Math.floor(random() * 36).toString(36);
  return SESSION_PREFIX + id.slice(0, 8);
}

// session 名稱會進 shell 與 tmux target，只接受自己產生的格式。
export function validSession(name: unknown): name is string {
  return typeof name === "string" && /^hg-[a-z0-9]{8}$/.test(name);
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

// -A：session 已存在就 attach，否則建立；首次啟動與恢復用同一條命令。
// bin 為 tmux 的絕對路徑（GUI app 的 PATH 找不到 Homebrew）；命令直接當 surface 的啟動命令，不經互動式 shell，所以不會進 history。
// env：給 session 的環境變數（new-session -e，tmux 3.2 起支援；呼叫端確認版本）。pane 不會繼承 tmux client 的環境，所以要這樣給；
// 只對新建的 session 有效，-A 接上既有 session 時 tmux 會忽略。key 只收大寫識別字，避免進 shell。
export function tmuxCommand(session: string, cwd: string, command?: string, hideStatus?: boolean, bin = "tmux", env?: Record<string, string>): string {
  if (!validSession(session)) throw new Error(t("common.invalidTmuxSession"));
  // tmux 預設 extended-keys off，Shift+Enter 會被壓成單純 Enter（Claude Code 等會直接送出）。server 選項要在 attach 前設好，
  // terminal-features 用固定索引指定，重複執行不會一直附加。
  const parts = [bin === "tmux" ? bin : quote(bin), "start-server", "\\;", "set-option", "-s", "extended-keys", "on", "\\;",
    "set-option", "-s", quote("terminal-features[100]"), quote("xterm*:extkeys"), "\\;", "new-session", "-A", "-s", session];
  for (const [key, value] of Object.entries(env ?? {})) if (/^[A-Z][A-Z0-9_]*$/.test(key)) parts.push("-e", quote(`${key}=${value}`));
  if (cwd) parts.push("-c", quote(cwd));
  if (command?.trim()) parts.push(quote(command.trim()));
  // 狀態列是 session 層級設定；每次 attach 都明確套用，切換後重開才會一致。
  parts.push("\\;", "set-option", "status", hideStatus ? "off" : "on");
  return parts.join(" ");
}

// tmux 不經互動式 shell，PATH 可能找不到 ~/.local/bin 之類的程式：把命令第一個字換成絕對路徑（已含 / 或沒有路徑就原樣）。
export function withProgramPath(command: string | undefined, path: string | null | undefined): string | undefined {
  if (!command?.trim() || !path || !path.startsWith("/")) return command;
  const match = command.trim().match(/^((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(\S+)(.*)$/s);
  if (!match || match[2].includes("/")) return command;
  return `${match[1]}${quote(path)}${match[3]}`;
}

export type TmuxSaved = { tmux?: boolean; tmuxSessions?: (string | undefined)[] };

// 啟動時只恢復啟用 tmux 的頁籤；無效的 session 名稱改成 undefined（還原時會重新建立）。
export function restorable<T extends TmuxSaved>(tabs: unknown): T[] {
  if (!Array.isArray(tabs)) return [];
  return tabs
    .filter((tab): tab is T => !!tab && typeof tab === "object" && (tab as T).tmux === true && Array.isArray((tab as { paths?: unknown }).paths))
    .map((tab) => ({ ...tab, tmuxSessions: (Array.isArray(tab.tmuxSessions) ? tab.tmuxSessions : []).map((name) => (validSession(name) ? name : undefined)) }));
}

// Programs installed as scripts (`#!/usr/bin/env node`) need their own folder on PATH, which a tmux
// pane started without the user's shell does not have: prefix PATH with the program's folder.
// Standard system folders are already on every PATH and are left alone.
// basePath：登入 shell 的 PATH。new-session -e PATH 不會套用到第一個 pane 的啟動命令（tmux 沿用 client 的 PATH），
// 所以直接寫進命令；沒給就沿用 $PATH。
export function withProgramDir(command: string | undefined, path: string | null | undefined, basePath?: string | null): string | undefined {
  if (!command?.trim()) return command;
  const hasPath = !!path && path.startsWith("/");
  if (!hasPath && !basePath?.startsWith("/")) return command;
  const escape = (value: string) => value.replace(/["$`\\]/g, "\\$&");
  const base = basePath?.startsWith("/") ? escape(basePath) : "$PATH";
  const dir = hasPath ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!dir || dir === "/usr/bin" || dir === "/bin") return base === "$PATH" ? command : `PATH="${base}" ${command}`;
  return `PATH="${escape(dir)}:${base}" ${command}`;
}
