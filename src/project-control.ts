// `highostty ctl project …`: input parsing, caller → member resolution and reply shapes.
// Pure; main.ts only wires it to the store. Command names live in control.ts's OPS.
import { errReply, okReply, type ErrorCode, type Reply } from "./control.ts";
import { coordinatorOf, inboxFor, memberForInstance, MAX_MESSAGE_CHARS } from "./projects.ts";
import type { ActionBody, ProjectError, ProjectState } from "./project-types.ts";

// The CLI reads at most this much from stdin (control.rs enforces the same limit).
export const MAX_INPUT_BYTES = 256 * 1024;

// A stable name for "the agent in this terminal". tmux sessions survive an app restart,
// surface ids do not, so a bound tmux agent stays bound and anything else shows offline.
export function instanceKey(surface: { id: string; tmuxSession?: string }): string {
  return surface.tmuxSession ? `tmux:${surface.tmuxSession}` : `surface:${surface.id}`;
}
export const INSTANCE_GENERATION = 1;
// Terminals that may become members: the first pane of a tab that was opened with a start
// command and runs in tmux. Only those keep the same identity (the tmux session) after a restart.
export function memberCandidates<S extends { id: string; tmuxSession?: string; exited?: boolean }>(
  tabs: { command?: string; tmux?: boolean; leaves: string[] }[],
  surfaces: Map<string, S>,
): S[] {
  const found: S[] = [];
  for (const tab of tabs) {
    const first = surfaces.get(tab.leaves[0] ?? "");
    if (tab.command?.trim() && tab.tmux && first?.tmuxSession && !first.exited) found.push(first);
  }
  return found;
}
// The open terminal an instance key points at, if any (a tmux key matches by session).
export function surfaceForInstance<T extends { id: string; tmuxSession?: string }>(key: string, surfaces: Iterable<T>): T | undefined {
  for (const surface of surfaces) if (instanceKey(surface) === key) return surface;
  return undefined;
}

const ERROR_CODES: Record<ProjectError["code"], ErrorCode> = {
  bad_args: "bad_args", not_found: "not_found", forbidden: "forbidden",
  already_exists: "bad_args", instance_in_use: "bad_args", needs_user_decision: "needs_user_decision",
};
export const projectErrorReply = (error: ProjectError): Reply => errReply(ERROR_CODES[error.code], error.message);

// Parse the stdin document of a `--json-stdin` command into a plain object.
export function parseInput(input: unknown, flags: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; reply: Reply } {
  const bad = (message: string) => ({ ok: false as const, reply: errReply("bad_args", message) });
  if (flags["json-stdin"] !== true) return bad("需要 --json-stdin，並由 stdin 傳入 JSON");
  if (typeof input !== "string" || !input.trim()) return bad("stdin 沒有內容");
  if (new TextEncoder().encode(input).length > MAX_INPUT_BYTES) return bad(`stdin 超過 ${MAX_INPUT_BYTES / 1024} KiB`);
  let value: unknown;
  try { value = JSON.parse(input); } catch (error) { return bad(`stdin 不是合法 JSON：${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("stdin 必須是 JSON 物件");
  return { ok: true, value: value as Record<string, unknown> };
}

const unknownKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).filter((key) => !allowed.includes(key));

export function helloBody(value: Record<string, unknown>): { ok: true; body: ActionBody } | { ok: false; reply: Reply } {
  const bad = (message: string) => ({ ok: false as const, reply: errReply("bad_args", message) });
  const extra = unknownKeys(value, ["protocolVersion", "purpose", "reportMode", "reportNeedsApproval"]);
  if (extra.length) return bad(`hello 不認得欄位：${extra.join("、")}`);
  if (value.protocolVersion !== 1) return bad("protocolVersion 必須是 1");
  if (value.reportMode !== "protocol" && value.reportMode !== "screen") return bad("reportMode 必須是 protocol 或 screen");
  if (typeof value.purpose !== "string") return bad("purpose 必須是字串");
  if (value.reportNeedsApproval !== undefined && typeof value.reportNeedsApproval !== "boolean") return bad("reportNeedsApproval 必須是布林值");
  return { ok: true, body: { type: "Hello", protocolVersion: 1, purpose: value.purpose, reportMode: value.reportMode, reportNeedsApproval: value.reportNeedsApproval } };
}

// `messageId` is optional for the agent; the caller supplies a generated one when absent.
export function messageBody(value: Record<string, unknown>, newId: () => string): { ok: true; body: ActionBody } | { ok: false; reply: Reply } {
  const bad = (message: string) => ({ ok: false as const, reply: errReply("bad_args", message) });
  const extra = unknownKeys(value, ["text", "inReplyTo", "messageId"]);
  if (extra.length) return bad(`message 不認得欄位：${extra.join("、")}`);
  if (typeof value.text !== "string" || !value.text.trim()) return bad("text 必須是非空字串");
  if (value.text.length > MAX_MESSAGE_CHARS) return bad(`text 最多 ${MAX_MESSAGE_CHARS} 字`);
  for (const key of ["inReplyTo", "messageId"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key])) return bad(`${key} 必須是非空字串`);
  }
  return {
    ok: true,
    body: { type: "CoordinatorMessage", messageId: (value.messageId as string | undefined) ?? newId(), inReplyTo: value.inReplyTo as string | undefined, text: value.text },
  };
}

// Who the caller is within this project; undefined when its terminal is not a member.
export function callerMember(state: ProjectState, instance: string | undefined) {
  return instance ? memberForInstance(state, instance) : undefined;
}

export const notMemberReply = () => errReply("forbidden", "這個終端機不是這個專案的成員；請由專案設定把它加入成員");

export function getResult(state: ProjectState, revision: number) {
  const coordinator = coordinatorOf(state);
  return {
    name: state.config?.name,
    revision,
    coordinator: coordinator?.id,
    members: state.members.map((m) => ({
      id: m.id, role: m.role, name: m.name, purpose: m.purpose, purposeSource: m.purposeSource, reportMode: m.reportMode,
      bound: !!state.bindings[m.id], handshake: !!state.handshakes[m.id],
    })),
    messages: state.messages.length,
  };
}

export function inboxResult(state: ProjectState, memberId: string, after: unknown) {
  const from = typeof after === "number" && after > 0 ? Math.floor(after) : 0;
  const messages = inboxFor(state, memberId, from).map((m) => ({ seq: m.seq, messageId: m.id, conversationId: m.conversationId, text: m.text, delivery: m.delivery }));
  return { messages, lastSeq: messages.length ? messages[messages.length - 1].seq : from };
}

export { okReply };
