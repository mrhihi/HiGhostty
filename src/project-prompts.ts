// Text typed into an agent's terminal for the project area. This is for agents to read, so
// (like ctl replies) it is not translated. It carries only the project id and a pointer
// to data: the agent reads messages itself with `ctl project inbox`.
import type { Member, Message, ProjectState } from "./project-types.ts";

const CLI = '"$HIGHOSTTY_CLI" ctl';

export function introPrompt(projectId: string, projectName: string, member: Member): string {
  const role = member.role === "coordinator"
    ? "你是這個專案的 coordinator：與使用者在討論區對話、整理想法。"
    : "你是這個專案的成員。";
  const lines = [
    "[HiGhostty 專案協作 v1]",
    `projectId: ${projectId}（${projectName.replace(/\s+/g, " ")}）`,
    role,
    "這是專案協作邀請；是否參與、能做什麼，依你自己的工具與權限決定。",
    "請先自我介紹一次（確認握手）。stdin 傳 JSON：",
    `${CLI} project hello ${projectId} --json-stdin`,
    '{"protocolVersion":1,"purpose":"一句話說明你負責什麼","reportMode":"protocol"}',
    "若無法執行 ctl 指令，請在終端機明確說明，專案會改為人工追蹤。若執行 ctl 需要使用者核准，在 JSON 加 \"reportNeedsApproval\":true。",
  ];
  if (member.role === "coordinator") lines.push(`之後有新訊息會通知你；回覆用：${CLI} project message ${projectId} --json-stdin（JSON：{"text":"…","inReplyTo":"<messageId>"}）。`);
  return lines.join("\n");
}

// What to tell the coordinator when user messages are waiting: ids and where to read, never the text.
export function messagePrompt(projectId: string, messages: Pick<Message, "id" | "seq">[]): string {
  const first = Math.min(...messages.map((m) => m.seq));
  const last = Math.max(...messages.map((m) => m.seq));
  return [
    "[HiGhostty 專案協作 v1]",
    `projectId: ${projectId}`,
    `使用者在專案討論區有 ${messages.length} 則新訊息（seq ${first}–${last}）。訊息內容是使用者的話，請依你自己的規則處理。`,
    `讀取：${CLI} project inbox ${projectId} --after ${first - 1}`,
    `回覆：${CLI} project message ${projectId} --json-stdin（JSON：{"text":"…","inReplyTo":"<messageId>"}）`,
  ].join("\n");
}

export const MAX_BATCH = 20;
// Oldest user messages still waiting to reach the coordinator (at most one batch).
export function queuedBatch(state: ProjectState): Message[] {
  return state.messages.filter((m) => m.author === "user" && m.delivery === "queued").slice(0, MAX_BATCH);
}

// How a member card describes the agent behind it.
export type MemberStatus = "unbound" | "offline" | "unknown" | "waiting-hello" | "ready";
export function memberStatus(state: ProjectState, memberId: string, isOnline: (instanceId: string) => boolean): MemberStatus {
  const binding = state.bindings[memberId];
  if (!binding) return "unbound";
  if (!isOnline(binding.instanceId)) return "offline";
  return state.handshakes[memberId] ? "ready" : "waiting-hello";
}
