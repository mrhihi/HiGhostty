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
  const parts = [bin === "tmux" ? bin : quote(bin), "new-session", "-A", "-s", session];
  for (const [key, value] of Object.entries(env ?? {})) if (/^[A-Z][A-Z0-9_]*$/.test(key)) parts.push("-e", quote(`${key}=${value}`));
  if (cwd) parts.push("-c", quote(cwd));
  if (command?.trim()) parts.push(quote(command.trim()));
  // 狀態列是 session 層級設定；每次 attach 都明確套用，切換後重開才會一致。
  parts.push("\\;", "set-option", "status", hideStatus ? "off" : "on");
  return parts.join(" ");
}

export type TmuxSaved = { tmux?: boolean; tmuxSessions?: (string | undefined)[] };

// 啟動時只恢復啟用 tmux 的頁籤；無效的 session 名稱改成 undefined（還原時會重新建立）。
export function restorable<T extends TmuxSaved>(tabs: unknown): T[] {
  if (!Array.isArray(tabs)) return [];
  return tabs
    .filter((tab): tab is T => !!tab && typeof tab === "object" && (tab as T).tmux === true && Array.isArray((tab as { paths?: unknown }).paths))
    .map((tab) => ({ ...tab, tmuxSessions: (Array.isArray(tab.tmuxSessions) ? tab.tmuxSessions : []).map((name) => (validSession(name) ? name : undefined)) }));
}
