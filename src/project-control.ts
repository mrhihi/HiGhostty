// `highostty ctl project …`: input parsing, caller → member resolution and reply shapes.
// Pure; main.ts only wires it to the store. Command names live in control.ts's OPS.
import { errReply, okReply, type ErrorCode, type Reply } from "./control.ts";
import { coordinatorOf, inboxFor, memberForInstance, MAX_MESSAGE_CHARS } from "./projects.ts";
import { activeRun, buildTaskPayload, queueReasonOf, stepOf } from "./project-tasks.ts";
import type { ActionBody, ProjectError, ProjectState, ReportKind } from "./project-types.ts";

// The CLI reads at most this much from stdin (control.rs enforces the same limit).
export const MAX_INPUT_BYTES = 256 * 1024;

// A stable name for "the agent in this terminal". tmux sessions survive an app restart,
// surface ids do not, so a bound tmux agent stays bound and anything else shows offline.
export function instanceKey(surface: { id: string; tmuxSession?: string }): string {
  return surface.tmuxSession ? `tmux:${surface.tmuxSession}` : `surface:${surface.id}`;
}
export const INSTANCE_GENERATION = 1;
// Agents a project can drive. Their start commands: claude, codex, copilot (or `gh copilot`), gemini.
export const PROJECT_AGENT_KINDS = ["claude", "codex", "copilot", "gemini"] as const;
export type ProjectAgentKind = (typeof PROJECT_AGENT_KINDS)[number];
// Which supported agent a start command launches; undefined for anything else. Leading
// `VAR=value` words are skipped; only the plain form counts (no `cd x && …`, pipes or wrappers).
export function agentKindOf(command: string | undefined): ProjectAgentKind | undefined {
  const words = (command ?? "").trim().split(/\s+/).filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const name = (words[0] ?? "").split("/").pop();
  if (name === "gh") return words[1] === "copilot" ? "copilot" : undefined;
  return (PROJECT_AGENT_KINDS as readonly string[]).includes(name ?? "") ? (name as ProjectAgentKind) : undefined;
}

// A supported agent's start command split for editing: the agent is chosen from a list, the
// rest (arguments) stays free text. `prefix` is any leading `VAR=value` words, `program` what ran.
export type AgentCommand = { prefix: string; program: string; kind: ProjectAgentKind; args: string };
export function parseAgentCommand(command: string | undefined): AgentCommand | undefined {
  const kind = agentKindOf(command);
  if (!kind) return undefined;
  const words = (command ?? "").trim().split(/\s+/).filter(Boolean);
  const prefix: string[] = [];
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) prefix.push(words.shift()!);
  const program = words.shift()!;
  const wrapped = program.split("/").pop() === "gh";
  const full = wrapped ? `${program} ${words.shift()}` : program;
  return { prefix: prefix.join(" "), program: full, kind, args: words.join(" ") };
}
// The command after the user picks an agent and edits the arguments; an unchanged agent keeps its exact program.
export function buildAgentCommand(parsed: AgentCommand, kind: ProjectAgentKind, args: string): string {
  const program = kind === parsed.kind ? parsed.program : kind;
  return [parsed.prefix, program, args.trim()].filter(Boolean).join(" ");
}

// Terminals that may become members: the first pane of a tab that was opened with a start
// command for a supported agent and runs in tmux. Only those keep the same identity (the tmux session) after a restart.
export function memberCandidates<S extends { id: string; tmuxSession?: string; exited?: boolean }>(
  tabs: { command?: string; tmux?: boolean; leaves: string[] }[],
  surfaces: Map<string, S>,
): S[] {
  const found: S[] = [];
  for (const tab of tabs) {
    const first = surfaces.get(tab.leaves[0] ?? "");
    if (agentKindOf(tab.command) && tab.tmux && first?.tmuxSession && !first.exited) found.push(first);
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
  invalid_plan: "invalid_plan", revision_conflict: "revision_conflict", stale_attempt: "stale_attempt", report_conflict: "report_conflict", invalid_state: "bad_args",
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
  const run = activeRun(state) ?? state.runs.at(-1);
  return {
    name: state.config?.name,
    revision,
    coordinator: coordinator?.id,
    members: state.members.map((m) => ({
      id: m.id, role: m.role, name: m.name, purpose: m.purpose, purposeSource: m.purposeSource, reportMode: m.reportMode,
      bound: !!state.bindings[m.id], handshake: !!state.handshakes[m.id],
    })),
    messages: state.messages.length,
    plan: state.plans.length ? { id: state.plans[0].id, latestVersion: state.plans.at(-1)!.version } : null,
    run: run
      ? {
          id: run.id, status: run.status, planVersion: run.planVersion,
          tasks: state.tasks.filter((t) => t.runId === run.id).map((t) => ({
            id: t.id, step: t.stepKey, member: t.memberId, status: t.status, attemptId: t.attempt?.id,
            waitingFor: t.status === "queued" ? queueReasonOf(state, t) ?? null : undefined, cancelRequested: t.cancelRequested || undefined,
          })),
        }
      : null,
  };
}

export function inboxResult(state: ProjectState, memberId: string, after: unknown) {
  const from = typeof after === "number" && after > 0 ? Math.floor(after) : 0;
  const messages = inboxFor(state, memberId, from).map((m) => ({ seq: m.seq, messageId: m.id, conversationId: m.conversationId, text: m.text, delivery: m.delivery }));
  return { messages, lastSeq: messages.length ? messages[messages.length - 1].seq : from };
}

export { okReply };

const bad = (message: string) => ({ ok: false as const, reply: errReply("bad_args", message) });
type Built = { ok: true; body: ActionBody; actionId?: string } | { ok: false; reply: Reply };
const optionalString = (v: unknown) => (v === undefined || (typeof v === "string" && !!v) ? undefined : "必須是非空字串");

export function planSubmitBody(value: Record<string, unknown>, newId: () => string): Built {
  const extra = unknownKeys(value, ["actionId", "basePlanVersion", "plan"]);
  if (extra.length) return bad(`plan submit 不認得欄位：${extra.join("、")}`);
  if (value.plan === undefined) return bad("缺少 plan");
  if (value.basePlanVersion !== undefined && !(Number.isInteger(value.basePlanVersion) && (value.basePlanVersion as number) >= 0)) return bad("basePlanVersion 必須是非負整數");
  const problem = optionalString(value.actionId);
  if (problem) return bad(`actionId ${problem}`);
  return { ok: true, actionId: value.actionId as string | undefined, body: { type: "SubmitPlan", planId: newId(), plan: value.plan, basePlanVersion: value.basePlanVersion as number | undefined } };
}

// The coordinator names the user's message; plan and version default to the latest.
export function runStartBody(state: ProjectState, value: Record<string, unknown>, newId: () => string): Built {
  const extra = unknownKeys(value, ["actionId", "planId", "version", "instructionMessageId"]);
  if (extra.length) return bad(`run start 不認得欄位：${extra.join("、")}`);
  for (const key of ["actionId", "planId", "instructionMessageId"]) { const p = optionalString(value[key]); if (p) return bad(`${key} ${p}`); }
  if (typeof value.instructionMessageId !== "string") return bad("缺少 instructionMessageId（使用者要求執行的那則訊息）");
  const latest = state.plans.at(-1);
  if (!latest) return bad("還沒有計畫；先用 plan submit 提交");
  const version = value.version === undefined ? latest.version : value.version;
  if (!Number.isInteger(version)) return bad("version 必須是整數");
  const plan = state.plans.find((p) => p.version === version);
  if (!plan) return bad(`沒有計畫版本 ${version}`);
  if (value.planId !== undefined && value.planId !== plan.id) return bad("planId 不符");
  return {
    ok: true, actionId: value.actionId as string | undefined,
    body: {
      type: "StartRun", runId: newId(), planId: plan.id, version: version as number, taskIds: plan.steps.map(() => newId()),
      consent: { id: newId(), source: "user-message", sourceMessageId: value.instructionMessageId },
    },
  };
}

const REPORT_KINDS: ReportKind[] = ["accepted", "progress", "needs-input", "declined", "result", "failed", "cancelled"];
export function taskReportBody(taskId: string, value: Record<string, unknown>): Built {
  const extra = unknownKeys(value, ["reportId", "attemptId", "kind", "summary", "question", "artifacts"]);
  if (extra.length) return bad(`task report 不認得欄位：${extra.join("、")}`);
  if (typeof value.reportId !== "string" || !value.reportId) return bad("reportId 必須是非空字串");
  if (typeof value.attemptId !== "string" || !value.attemptId) return bad("attemptId 必須是非空字串");
  if (!REPORT_KINDS.includes(value.kind as ReportKind)) return bad(`kind 必須是 ${REPORT_KINDS.join("、")}`);
  if (value.summary !== undefined && typeof value.summary !== "string") return bad("summary 必須是字串");
  if (value.question !== undefined && typeof value.question !== "string") return bad("question 必須是字串");
  const artifacts: { name: string; mediaType: "text/plain"; text: string }[] = [];
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts)) return bad("artifacts 必須是陣列");
    for (const raw of value.artifacts) {
      const a = raw as Record<string, unknown> | null;
      if (!a || typeof a.name !== "string" || typeof a.mediaType !== "string" || typeof a.text !== "string") return bad("每個附件需要字串 name、mediaType、text");
      const extraA = unknownKeys(a, ["name", "mediaType", "text"]);
      if (extraA.length) return bad(`附件不認得欄位：${extraA.join("、")}`);
      artifacts.push(a as never);
    }
  }
  return {
    ok: true,
    // Same report sent twice maps onto the same action, so a resend is a no-op even before the rules see it.
    actionId: `report:${taskId}:${value.attemptId}:${value.reportId}`,
    body: { type: "ReceiveReport", taskId, report: { reportId: value.reportId, attemptId: value.attemptId, kind: value.kind as ReportKind, summary: (value.summary as string | undefined) ?? "", question: value.question as string | undefined, artifacts } },
  };
}

export function acceptBody(taskId: string, value: Record<string, unknown>): Built {
  const extra = unknownKeys(value, ["actionId", "attemptId", "checks"]);
  if (extra.length) return bad(`task accept 不認得欄位：${extra.join("、")}`);
  if (typeof value.attemptId !== "string" || !value.attemptId) return bad("attemptId 必須是非空字串");
  const checks: { criterion: string; evidenceArtifactIds: string[] }[] = [];
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks)) return bad("checks 必須是陣列");
    for (const raw of value.checks) {
      const c = raw as Record<string, unknown> | null;
      if (!c || typeof c.criterion !== "string" || !Array.isArray(c.evidenceArtifactIds) || c.evidenceArtifactIds.some((x) => typeof x !== "string")) return bad("每項 check 需要字串 criterion 與字串陣列 evidenceArtifactIds");
      checks.push({ criterion: c.criterion, evidenceArtifactIds: c.evidenceArtifactIds as string[] });
    }
  }
  const problem = optionalString(value.actionId);
  if (problem) return bad(`actionId ${problem}`);
  return { ok: true, actionId: value.actionId as string | undefined, body: { type: "AcceptResult", taskId, attemptId: value.attemptId, checks } };
}

export function reworkBody(taskId: string, value: Record<string, unknown>): Built {
  const extra = unknownKeys(value, ["actionId", "attemptId", "feedback"]);
  if (extra.length) return bad(`task rework 不認得欄位：${extra.join("、")}`);
  if (typeof value.attemptId !== "string" || !value.attemptId) return bad("attemptId 必須是非空字串");
  if (typeof value.feedback !== "string" || !value.feedback.trim()) return bad("feedback 必須是非空字串");
  const problem = optionalString(value.actionId);
  if (problem) return bad(`actionId ${problem}`);
  return { ok: true, actionId: value.actionId as string | undefined, body: { type: "RequestRework", taskId, attemptId: value.attemptId, feedback: value.feedback } };
}

// `project task get`: only the member the task is assigned to may read its inputs.
export function taskGetResult(state: ProjectState, memberId: string, taskId: string): Reply {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return errReply("not_found", "沒有這個任務");
  if (task.memberId !== memberId) return errReply("forbidden", "這個任務不是指派給你的");
  const payload = buildTaskPayload(state, taskId);
  return payload ? okReply({ ...payload, status: task.status, step: stepOf(state, task)?.key }) : errReply("not_found", "找不到任務的計畫內容");
}

// `project task result`: what the coordinator checks before accepting.
export function taskResultResult(state: ProjectState, taskId: string): Reply {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return errReply("not_found", "沒有這個任務");
  const step = stepOf(state, task);
  const reports = state.reports.filter((r) => r.taskId === task.id).map((r) => ({ reportId: r.reportId, attemptId: r.attemptId, kind: r.kind, summary: r.summary, stale: r.stale }));
  return okReply({
    taskId: task.id, status: task.status, attemptId: task.attempt?.id, completion: step?.completion ?? [],
    resultArtifacts: state.artifacts.filter((a) => task.resultArtifactIds.includes(a.id)).map(({ id, name, mediaType, text }) => ({ id, name, mediaType, text })),
    reports,
    openQuestions: state.issues.filter((i) => i.taskId === task.id && i.kind === "question" && !i.resolvedAt).map((i) => ({ id: i.id, text: i.text })),
  });
}

// A coordinator's note of what a screen-mode worker finished; the user still has to confirm it.
export function observedBody(taskId: string, value: Record<string, unknown>): Built {
  const extra = unknownKeys(value, ["attemptId", "summary", "artifacts"]);
  if (extra.length) return bad(`task observed 不認得欄位：${extra.join("、")}`);
  if (typeof value.attemptId !== "string" || !value.attemptId) return bad("attemptId 必須是非空字串");
  if (typeof value.summary !== "string" || !value.summary.trim()) return bad("summary 必須是非空字串");
  const artifacts: { name: string; mediaType: "text/plain"; text: string }[] = [];
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts)) return bad("artifacts 必須是陣列");
    for (const raw of value.artifacts) {
      const a = raw as Record<string, unknown> | null;
      if (!a || typeof a.name !== "string" || typeof a.mediaType !== "string" || typeof a.text !== "string") return bad("每個附件需要字串 name、mediaType、text");
      artifacts.push(a as never);
    }
  }
  return { ok: true, body: { type: "SubmitObservedResult", taskId, attemptId: value.attemptId, summary: value.summary, artifacts } };
}
