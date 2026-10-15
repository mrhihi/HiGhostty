// Plans, runs and tasks (docs/project-implementation.md §5–§6, S2 subset). Pure: `decideTasks`
// validates a task action against the state and returns events; `reduceTasks` replays them.
// projects.ts routes the S2 action types here. Not covered yet: ReplyIssue, ObservedBlocked,
// SubmitObservedResult, DeliverNow, cross-project reservation (S3).
import type {
  Actor, Artifact, Attempt, Issue, IssueReply, Member, PlanVersion, ProjectError, ProjectErrorCode, ProjectEvent, ProjectState, Report, ReportInput,
  Result, Step, Task, TaskActionBody, TaskStatus,
} from "./project-types.ts";

export const MAX_STEPS = 100;
export const MAX_ARTIFACT_CHARS = 128 * 1024;
export const MAX_REPORT_CHARS = 256 * 1024;

// ---- plan validation ----
export type PlanError = { code: string; stepKey?: string; message: string };
const ARTIFACT_TYPES = ["text/plain", "text/markdown", "application/json"];

// Checks everything in one pass so the coordinator can fix a plan in one round.
export function validatePlan(plan: unknown, members: Member[]): Result<Omit<PlanVersion, "id" | "version">, PlanError[]> {
  const errors: PlanError[] = [];
  const add = (code: string, message: string, stepKey?: string) => errors.push({ code, message, stepKey });
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { ok: false, error: [{ code: "schema", message: "計畫必須是物件" }] };
  const p = plan as Record<string, unknown>;
  const unknown = (obj: Record<string, unknown>, allowed: string[], where: string, key?: string) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) add("unknown_field", `${where} 不認得欄位 ${k}`, key);
  };
  unknown(p, ["title", "objective", "scope", "steps"], "計畫");
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (!text(p.objective)) add("empty_objective", "objective 不可空白");
  if (p.title !== undefined && typeof p.title !== "string") add("schema", "title 必須是字串");
  if (p.scope !== undefined && typeof p.scope !== "string") add("schema", "scope 必須是字串");
  if (!Array.isArray(p.steps) || !p.steps.length) {
    add("no_steps", "steps 必須是非空陣列");
    return { ok: false, error: errors };
  }
  if (p.steps.length > MAX_STEPS) add("too_many_steps", `步驟最多 ${MAX_STEPS} 個`);
  const steps: Step[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of p.steps.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { add("schema", `第 ${index + 1} 步必須是物件`); continue; }
    const s = raw as Record<string, unknown>;
    const key = text(s.key);
    unknown(s, ["key", "memberId", "title", "instruction", "dependsOn", "completion", "inputFrom", "acceptance", "externalWrite"], `步驟 ${key || index + 1}`, key);
    if (s.acceptance !== undefined && !["coordinator", "user", "auto-on-protocol-result"].includes(s.acceptance as string)) add("schema", "acceptance 必須是 coordinator、user 或 auto-on-protocol-result", key);
    if (s.externalWrite !== undefined && typeof s.externalWrite !== "boolean") add("schema", "externalWrite 必須是布林值", key);
    if (!key) add("schema", `第 ${index + 1} 步缺少 key`);
    else if (seen.has(key)) add("duplicate_key", `步驟 key 重複：${key}`, key);
    seen.add(key);
    const list = (v: unknown, name: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) { add("schema", `${name} 必須是字串陣列`, key); return []; }
      return v as string[];
    };
    const completion = list(s.completion, "completion").map((c) => c.trim()).filter(Boolean);
    if (!completion.length) add("empty_completion", "completion 至少要有一項明確的完成條件", key);
    if (!text(s.instruction)) add("schema", "instruction 不可空白", key);
    const inputFromRaw = s.inputFrom === undefined ? [] : s.inputFrom;
    const inputFrom: Step["inputFrom"] = [];
    if (!Array.isArray(inputFromRaw)) add("schema", "inputFrom 必須是陣列", key);
    else for (const item of inputFromRaw) {
      const o = item as Record<string, unknown> | null;
      if (!o || typeof o.stepKey !== "string") { add("schema", "inputFrom 每項需有 stepKey", key); continue; }
      const names = o.artifactNames === undefined ? [] : o.artifactNames;
      if (!Array.isArray(names) || names.some((x) => typeof x !== "string")) { add("schema", "artifactNames 必須是字串陣列", key); continue; }
      inputFrom.push({ stepKey: o.stepKey, artifactNames: names as string[] });
    }
    steps.push({
      key, memberId: text(s.memberId), title: text(s.title) || key, instruction: text(s.instruction),
      dependsOn: list(s.dependsOn, "dependsOn"), completion, inputFrom,
      ...(typeof s.acceptance === "string" && ["coordinator", "user", "auto-on-protocol-result"].includes(s.acceptance) ? { acceptance: s.acceptance as Step["acceptance"] } : {}),
      ...(s.externalWrite === true ? { externalWrite: true } : {}),
    });
  }
  const byKey = new Map(steps.map((s) => [s.key, s]));
  for (const step of steps) {
    const member = members.find((m) => m.id === step.memberId);
    if (!member) add("unknown_member", `未知成員 ${step.memberId || "（空白）"}`, step.key);
    else if (member.role === "coordinator") add("coordinator_as_worker", "coordinator 不能被指派步驟", step.key);
    for (const dep of step.dependsOn) {
      if (dep === step.key) add("self_dependency", "步驟不能依賴自己", step.key);
      else if (!byKey.has(dep)) add("missing_dependency", `依賴的步驟不存在：${dep}`, step.key);
    }
    for (const input of step.inputFrom) {
      if (!step.dependsOn.includes(input.stepKey)) add("input_not_dependency", `inputFrom ${input.stepKey} 必須列在 dependsOn`, step.key);
    }
  }
  // Auto-accepting a step is only safe when nothing downstream writes outside on the strength of it.
  for (const step of steps) {
    if (step.acceptance !== "auto-on-protocol-result") continue;
    const member = members.find((m) => m.id === step.memberId);
    if (member && member.reportMode !== "protocol") add("auto_needs_protocol", "自動驗收只適用會用協定回報的成員", step.key);
    const reaches = new Set<string>();
    const walk = (key: string) => {
      for (const next of steps) if (next.dependsOn.includes(key) && !reaches.has(next.key)) { reaches.add(next.key); walk(next.key); }
    };
    walk(step.key);
    const writer = steps.find((x) => reaches.has(x.key) && x.externalWrite);
    if (writer) add("auto_before_external_write", `步驟「${writer.key}」會寫入外部系統，上游「${step.key}」不能自動驗收`, step.key);
  }
  // Cycles: depth-first with colors.
  const color = new Map<string, 1 | 2>();
  const visit = (key: string, path: string[]): boolean => {
    if (color.get(key) === 2) return false;
    if (color.get(key) === 1) { add("cycle", `相依循環：${[...path.slice(path.indexOf(key)), key].join(" → ")}`, key); return true; }
    color.set(key, 1);
    for (const dep of byKey.get(key)?.dependsOn ?? []) if (byKey.has(dep) && dep !== key && visit(dep, [...path, key])) { color.set(key, 2); return true; }
    color.set(key, 2);
    return false;
  };
  for (const step of steps) if (step.key) visit(step.key, []);
  if (errors.length) return { ok: false, error: errors };
  return { ok: true, value: { title: text(p.title) || text(p.objective).slice(0, 40), objective: text(p.objective), scope: text(p.scope), steps } };
}

// ---- state helpers ----
const ACTIVE: TaskStatus[] = ["dispatching", "sent", "accepted", "running", "needs-input", "uncertain"];
const TERMINAL: TaskStatus[] = ["completed", "failed", "cancelled"];
export const planOf = (state: ProjectState, run: { planId: string; planVersion: number }) =>
  state.plans.find((p) => p.id === run.planId && p.version === run.planVersion);
const taskOf = (state: ProjectState, id: string) => state.tasks.find((t) => t.id === id);
const runOf = (state: ProjectState, id: string) => state.runs.find((r) => r.id === id);
export const stepOf = (state: ProjectState, task: Task): Step | undefined => {
  const run = runOf(state, task.runId);
  return run && planOf(state, run)?.steps.find((s) => s.key === task.stepKey);
};
export const activeRun = (state: ProjectState) => state.runs.find((r) => r.status === "running" || r.status === "paused");
// The worker is busy while a task of theirs holds an attempt that is not yet a result.
export const memberBusy = (state: ProjectState, memberId: string) =>
  state.tasks.some((t) => t.memberId === memberId && ACTIVE.includes(t.status));

// Why a queued task cannot be delivered right now (undefined when it can).
export type QueueReason = "paused" | "closed" | "dependency" | "busy" | "unbound";
export function queueReasonOf(state: ProjectState, task: Task): QueueReason | undefined {
  const run = runOf(state, task.runId);
  if (!run || run.status === "closed" || run.status === "completed") return "closed";
  if (run.status === "paused") return "paused";
  const step = stepOf(state, task);
  if (!step) return "dependency";
  for (const dep of step.dependsOn) {
    const upstream = state.tasks.find((t) => t.runId === task.runId && t.stepKey === dep);
    if (upstream?.status !== "completed") return "dependency";
  }
  if (!state.bindings[task.memberId]) return "unbound";
  if (memberBusy(state, task.memberId)) return "busy";
  return undefined;
}
export const eligibleTasks = (state: ProjectState): Task[] =>
  state.tasks.filter((t) => t.status === "queued" && queueReasonOf(state, t) === undefined);

// What stops a plan from starting; structured so the screen can translate it.
export type StartBlocker = { kind: "coordinator-hello" } | { kind: "unbound"; memberId: string; memberName: string };
export function startBlockers(state: ProjectState, plan: PlanVersion): StartBlocker[] {
  const out: StartBlocker[] = [];
  const coordinator = state.members.find((m) => m.role === "coordinator");
  if (coordinator && !state.handshakes[coordinator.id]) out.push({ kind: "coordinator-hello" });
  for (const id of new Set(plan.steps.map((s) => s.memberId))) {
    if (!state.bindings[id]) out.push({ kind: "unbound", memberId: id, memberName: state.members.find((m) => m.id === id)?.name ?? id });
  }
  return out;
}

// ---- things that need a person (derived, not journaled) ----
export const DEFAULT_STALL_MS = 10 * 60_000;
// Tasks that were handed over but have not been heard from for a while. Silence never changes a
// task's state; it only asks the user to look.
export function stalledTasks(state: ProjectState, nowMs: number, timeoutMs = DEFAULT_STALL_MS): Task[] {
  return state.tasks.filter((t) => ["sent", "accepted", "running"].includes(t.status) && !!t.activityAt && nowMs - Date.parse(t.activityAt) > timeoutMs);
}
export type Observed = "working" | "idle" | "blocked" | "unknown";
// Members whose terminal is waiting on a person while they hold a task in progress.
export function blockedMembers(state: ProjectState, observed: (memberId: string) => Observed | undefined): { memberId: string; taskIds: string[] }[] {
  const out: { memberId: string; taskIds: string[] }[] = [];
  for (const member of state.members) {
    if (observed(member.id) !== "blocked") continue;
    const taskIds = state.tasks.filter((t) => t.memberId === member.id && ACTIVE.includes(t.status)).map((t) => t.id);
    if (taskIds.length) out.push({ memberId: member.id, taskIds });
  }
  return out;
}

// ---- decide ----
const err = (code: ProjectErrorCode, message: string, details?: unknown): Result<never, ProjectError> => ({ ok: false, error: { code, message, details } });
type Ev = (type: ProjectEvent["type"], data: Record<string, unknown>) => ProjectEvent;
const ok = (events: ProjectEvent[]): Result<{ events: ProjectEvent[] }, ProjectError> => ({ ok: true, value: { events } });

const fingerprint = (r: ReportInput) => JSON.stringify([r.kind, r.summary, r.question ?? null, (r.artifacts ?? []).map((a) => [a.name, a.mediaType, a.text])]);

export function decideTasks(state: ProjectState, actor: Actor, body: TaskActionBody, ev: Ev): Result<{ events: ProjectEvent[] }, ProjectError> {
  const isUser = actor.kind === "user";
  const coordinator = state.members.find((m) => m.role === "coordinator");
  const isCoordinator = actor.kind === "member" && actor.memberId === coordinator?.id;
  const userOrCoordinator = isUser || isCoordinator;
  const status = (task: Task, to: TaskStatus, extra: Record<string, unknown> = {}) => ev("TaskStatusChanged", { taskId: task.id, status: to, ...extra });

  switch (body.type) {
    case "SubmitPlan": {
      if (!userOrCoordinator) return err("forbidden", "只有使用者或 coordinator 能提交計畫");
      const latest = state.plans.at(-1);
      if (body.basePlanVersion !== undefined && body.basePlanVersion !== (latest?.version ?? 0)) {
        return err("revision_conflict", `計畫已更新到版本 ${latest?.version ?? 0}，你的基底是 ${body.basePlanVersion}；請重讀後再送`);
      }
      const checked = validatePlan(body.plan, state.members);
      if (!checked.ok) return err("invalid_plan", `計畫有 ${checked.error.length} 個問題：${checked.error.map((e) => e.message).join("；")}`, checked.error);
      const plan: PlanVersion = { id: latest?.id ?? body.planId, version: (latest?.version ?? 0) + 1, ...checked.value };
      return ok([ev("PlanVersionCreated", { plan })]);
    }
    case "StartRun": {
      if (!userOrCoordinator) return err("forbidden", "只有使用者或 coordinator 能開始計畫");
      const plan = state.plans.find((p) => p.id === body.planId && p.version === body.version);
      if (!plan) return err("not_found", "沒有這個計畫版本");
      if (runOf(state, body.runId)) return err("already_exists", "runId 重複");
      if (activeRun(state)) return err("invalid_state", "專案已有進行中的計畫；一次只能執行一份");
      if (body.taskIds.length !== plan.steps.length || new Set(body.taskIds).size !== body.taskIds.length) return err("bad_args", "taskIds 必須與步驟一一對應且不重複");
      const blocked = startBlockers(state, plan);
      if (blocked.length) {
        const blockers = blocked.map((b) => (b.kind === "coordinator-hello" ? "coordinator 尚未完成 hello" : `成員「${b.memberName}」沒有綁定終端機`));
        return err("invalid_state", `無法開始：${blockers.join("；")}`, blockers);
      }
      const consent = body.consent;
      if (consent.source === "start-button" ? !isUser : !isCoordinator) return err("forbidden", "同意來源與操作者不符");
      if (consent.source === "user-message") {
        const src = state.messages.find((m) => m.id === consent.sourceMessageId);
        if (!src || src.author !== "user") return err("needs_user_decision", "找不到對應的使用者訊息，請使用者按「開始」確認");
      }
      const scopeSummary = plan.objective.slice(0, 200);
      return ok([
        ev("ExecutionConsentRecorded", { consent: { id: consent.id, planId: plan.id, version: plan.version, source: consent.source, sourceMessageId: consent.sourceMessageId, scopeSummary } }),
        ev("RunStarted", { runId: body.runId, planId: plan.id, planVersion: plan.version, taskIds: body.taskIds, consentId: consent.id, auto: body.auto === true }),
        ...plan.steps.map((step, i) => ev("TaskQueued", { taskId: body.taskIds[i], runId: body.runId, stepKey: step.key, planVersion: plan.version, memberId: step.memberId })),
      ]);
    }
    case "PauseRun":
    case "ResumeRun": {
      if (!userOrCoordinator) return err("forbidden", "只有使用者或 coordinator 能暫停或繼續計畫");
      const run = runOf(state, body.runId);
      if (!run) return err("not_found", "沒有這個 run");
      const want = body.type === "PauseRun" ? "running" : "paused";
      if (run.status !== want) return err("invalid_state", `run 目前是 ${run.status}`);
      return ok([ev(body.type === "PauseRun" ? "RunPaused" : "RunResumed", { runId: run.id })]);
    }
    case "PrepareDispatch": {
      if (!isUser) return err("forbidden", "S2 的派送由使用者按「交付」");
      const task = taskOf(state, body.taskId);
      if (!task) return err("not_found", "沒有這個任務");
      if (task.status !== "queued") return err("invalid_state", `任務目前是 ${task.status}，只有 queued 能交付`);
      if (task.attemptIds.includes(body.attemptId)) return err("already_exists", "attemptId 重複");
      const reason = queueReasonOf(state, task);
      if (reason) return err("invalid_state", { paused: "計畫已暫停", closed: "這個 run 已結束", dependency: "相依的步驟尚未完成", busy: "這位成員還有進行中的任務", unbound: "成員沒有綁定終端機" }[reason], reason);
      const binding = state.bindings[task.memberId];
      return ok([ev("TaskDispatchPrepared", {
        taskId: task.id,
        attempt: { id: body.attemptId, instanceId: binding.instanceId, instanceGeneration: binding.instanceGeneration, bindingRevision: binding.bindingRevision, effectId: body.effectId, inputStarted: false },
      })]);
    }
    case "RecordInputStart": {
      const task = taskOf(state, body.taskId);
      if (!task?.attempt) return err("not_found", "沒有這個任務或嘗試");
      if (task.attempt.id !== body.attemptId || task.attempt.effectId !== body.effectId) return err("stale_attempt", "attempt 或 effect 不符");
      if (task.status !== "dispatching") return err("invalid_state", `任務目前是 ${task.status}`);
      // A pause or close between the hand-over being prepared and the typing must win: nothing has been typed yet.
      if (runOf(state, task.runId)?.status !== "running") return err("invalid_state", "計畫已暫停或結束，不再輸入");
      return ok([ev("InputWillStart", { taskId: task.id, attemptId: body.attemptId })]);
    }
    case "RecordInputResult": {
      const task = taskOf(state, body.taskId);
      if (!task?.attempt) return err("not_found", "沒有這個任務或嘗試");
      if (task.attempt.id !== body.attemptId || task.attempt.effectId !== body.effectId) return err("stale_attempt", "attempt 或 effect 不符");
      // A report may have beaten the host's reply; the later "sent" only fills in the record.
      if (task.status !== "dispatching" && task.status !== "sent") return ok([]);
      if (body.outcome === "sent") return task.status === "dispatching" ? ok([status(task, "sent")]) : ok([]);
      if (body.outcome === "not-sent") {
        if (task.status !== "dispatching") return err("invalid_state", "已經送出，不能標為未送出");
        return ok([status(task, "queued", { releaseAttempt: true })]);
      }
      return ok([status(task, "uncertain")]);
    }
    case "ReceiveReport": {
      const task = taskOf(state, body.taskId);
      if (!task) return err("not_found", "沒有這個任務");
      if (actor.kind !== "member" || actor.memberId !== task.memberId) return err("forbidden", "只有被指派的成員能回報這個任務");
      return receiveReport(state, task, actor, body.report, ev);
    }
    case "ReplyIssue": {
      if (!isUser) return err("forbidden", "只有使用者能回覆提問");
      const issue = state.issues.find((i) => i.id === body.issueId);
      if (!issue || issue.kind !== "question" || !issue.taskId) return err("not_found", "沒有這個提問");
      if (issue.resolvedAt) return err("invalid_state", "這個提問已經結束");
      const task = taskOf(state, issue.taskId);
      if (!task?.attempt || task.status !== "needs-input") return err("invalid_state", "任務已不在等待回答");
      const text = body.text.trim();
      if (!text) return err("bad_args", "回覆不可空白");
      if (text.length > MAX_ARTIFACT_CHARS) return err("bad_args", "回覆過長");
      if (state.replies.some((r) => r.id === body.replyId)) return err("already_exists", "replyId 重複");
      return ok([ev("IssueReplyQueued", { reply: { id: body.replyId, issueId: issue.id, taskId: task.id, attemptId: task.attempt.id, text, delivery: "queued" } })]);
    }
    case "SetReplyDelivery": {
      if (!isUser) return err("forbidden", "只有使用者能更新投遞狀態");
      if (!state.replies.some((r) => r.id === body.replyId)) return err("not_found", "沒有這則回覆");
      return ok([ev("ReplyDeliveryChanged", { replyId: body.replyId, delivery: body.delivery })]);
    }
    case "SetRunAuto": {
      if (!isUser) return err("forbidden", "只有使用者能切換自動交付");
      const run = runOf(state, body.runId);
      if (!run) return err("not_found", "沒有這個 run");
      if (run.auto === body.auto) return ok([]);
      return ok([ev("RunAutoChanged", { runId: run.id, auto: body.auto })]);
    }
    case "CloseRun": {
      if (!isUser) return err("forbidden", "結案必須由使用者決定");
      const run = runOf(state, body.runId);
      if (!run || (run.status !== "running" && run.status !== "paused")) return err("invalid_state", "這個 run 已經結束");
      const open = state.tasks.filter((t) => t.runId === run.id && t.status !== "completed");
      const busy = open.filter((t) => !["queued", "declined", "failed", "cancelled"].includes(t.status));
      if (busy.length) return err("invalid_state", "還有進行中或待驗收的任務；請先處理它們", busy.map((t) => t.id));
      return ok([ev("RunClosed", { runId: run.id, unfinished: open.map((t) => t.id) })]);
    }
    case "RecoverTasks": {
      // After a restart: a hand-over that never started typing goes back to the queue; one that may have typed is unclear.
      if (!isUser) return err("forbidden", "只有使用者端的控制器能恢復任務");
      const events: ProjectEvent[] = [];
      for (const task of state.tasks) {
        if (task.status !== "dispatching" || !task.attempt) continue;
        events.push(task.attempt.inputStarted ? status(task, "uncertain") : status(task, "queued", { releaseAttempt: true }));
      }
      return ok(events);
    }
    case "SubmitObservedResult": {
      if (!isCoordinator) return err("forbidden", "只有 coordinator 能整理畫面上的成果");
      const task = taskOf(state, body.taskId);
      if (!task?.attempt) return err("not_found", "沒有這個任務或嘗試");
      if (task.attempt.id !== body.attemptId) return err("stale_attempt", "attempt 不符");
      if (!["sent", "accepted", "running", "uncertain"].includes(task.status)) return err("invalid_state", `任務目前是 ${task.status}`);
      if (state.members.find((m) => m.id === task.memberId)?.reportMode === "protocol") return err("invalid_state", "這位成員會用協定回報，請等它回報");
      if (!body.summary.trim()) return err("bad_args", "summary 不可空白");
      const made = [] as Artifact[];
      for (const [i, a] of (body.artifacts ?? []).entries()) {
        if (!a.name?.trim() || !ARTIFACT_TYPES.includes(a.mediaType) || typeof a.text !== "string" || a.text.length > MAX_ARTIFACT_CHARS) return err("bad_args", "附件需要 name、合法的 mediaType 與不超過 128 KiB 的 text");
        made.push({ id: `${task.id}:${body.attemptId}:observed:${i}`, taskId: task.id, attemptId: body.attemptId, name: a.name.trim(), mediaType: a.mediaType, text: a.text, bytes: new TextEncoder().encode(a.text).length, source: "screen" });
      }
      return ok([ev("ObservedResultSubmitted", { taskId: task.id, summary: body.summary.trim(), artifacts: made })]);
    }
    case "ConfirmObservedResult": {
      if (!isUser) return err("forbidden", "畫面整理的成果必須由使用者確認");
      const task = taskOf(state, body.taskId);
      if (!task?.attempt || task.attempt.id !== body.attemptId) return err("stale_attempt", "attempt 不符");
      if (!task.observed) return err("invalid_state", "沒有待確認的畫面成果");
      if (!["sent", "accepted", "running", "uncertain"].includes(task.status)) return err("invalid_state", `任務目前是 ${task.status}`);
      return ok([status(task, "result-ready", { resultArtifactIds: task.observed.artifactIds })]);
    }
    case "AcceptResult": {
      if (!userOrCoordinator) return err("forbidden", "只有使用者或 coordinator 能驗收");
      const task = taskOf(state, body.taskId);
      if (!task) return err("not_found", "沒有這個任務");
      if (task.status !== "result-ready" || task.attempt?.id !== body.attemptId) return err(task.attempt?.id === body.attemptId ? "invalid_state" : "stale_attempt", `任務目前是 ${task.status}`);
      if (isCoordinator) {
        const step = stepOf(state, task);
        const checks = body.checks ?? [];
        const missing = (step?.completion ?? []).filter((c) => !checks.some((k) => k.criterion === c && k.evidenceArtifactIds.length > 0));
        if (missing.length) return err("bad_args", `完成條件沒有逐項核對：${missing.join("；")}`, missing);
        const bad = checks.flatMap((k) => k.evidenceArtifactIds).find((id) => !task.resultArtifactIds.includes(id));
        if (bad) return err("bad_args", `證據 ${bad} 不是這個任務的成果`);
      }
      const events = [status(task, "completed", { acceptedBy: actor.kind === "user" ? "user" : "coordinator", checks: body.checks ?? [] })];
      const run = runOf(state, task.runId);
      if (run && state.tasks.filter((t) => t.runId === run.id && t.id !== task.id).every((t) => t.status === "completed")) events.push(ev("RunCompleted", { runId: run.id }));
      return ok(events);
    }
    case "RequestRework": {
      if (!userOrCoordinator) return err("forbidden", "只有使用者或 coordinator 能退回重做");
      const task = taskOf(state, body.taskId);
      if (!task) return err("not_found", "沒有這個任務");
      if (task.status !== "result-ready" || task.attempt?.id !== body.attemptId) return err(task.attempt?.id === body.attemptId ? "invalid_state" : "stale_attempt", `任務目前是 ${task.status}`);
      if (!body.feedback.trim()) return err("bad_args", "feedback 不可空白");
      return ok([ev("TaskReworkRequested", { taskId: task.id, feedback: body.feedback.trim() })]);
    }
    case "RequestCancel": {
      if (!userOrCoordinator) return err("forbidden", "只有使用者或 coordinator 能取消");
      const task = taskOf(state, body.taskId);
      if (!task) return err("not_found", "沒有這個任務");
      if (task.status === "queued") return ok([status(task, "cancelled")]);
      if (ACTIVE.includes(task.status)) return task.cancelRequested ? ok([]) : ok([ev("TaskCancelRequested", { taskId: task.id })]);
      return err("invalid_state", `任務目前是 ${task.status}，不能取消`);
    }
    case "RetryTask": {
      if (!isUser) return err("forbidden", "重試必須由使用者明確決定");
      const task = taskOf(state, body.taskId);
      if (!task) return err("not_found", "沒有這個任務");
      if (!["declined", "failed", "cancelled"].includes(task.status)) return err("invalid_state", `任務目前是 ${task.status}；uncertain 要先核對`);
      const run = runOf(state, task.runId);
      if (!run || (run.status !== "running" && run.status !== "paused")) return err("invalid_state", "這個 run 已結束");
      const member = body.memberId ? state.members.find((m) => m.id === body.memberId) : undefined;
      if (body.memberId && (!member || member.role !== "worker")) return err("bad_args", "新成員必須是現有的 worker");
      return ok([ev("TaskRetryRequested", { taskId: task.id, memberId: body.memberId ?? task.memberId })]);
    }
    case "ReconcileTask": {
      if (!userOrCoordinator) return err("forbidden", "只有使用者或 coordinator 能核對");
      const task = taskOf(state, body.taskId);
      if (!task) return err("not_found", "沒有這個任務");
      // Besides uncertain, the user may settle a task that has been silent (sent/accepted/running) by saying what they saw.
      if (!["uncertain", "sent", "accepted", "running"].includes(task.status) || task.attempt?.id !== body.attemptId) return err("invalid_state", "只有進行中或 uncertain 的目前嘗試能核對");
      if (body.decision === "not-received") return ok([status(task, "queued", { releaseAttempt: true })]);
      return ok([status(task, body.decision === "running" ? "running" : "failed")]);
    }
  }
}

// Reports can arrive late, twice, or from an old attempt; none of that may move a newer attempt.
function receiveReport(state: ProjectState, task: Task, actor: Actor, input: ReportInput, ev: Ev): Result<{ events: ProjectEvent[] }, ProjectError> {
  const kinds = ["accepted", "progress", "needs-input", "declined", "result", "failed", "cancelled"];
  if (!input.reportId || typeof input.reportId !== "string") return err("bad_args", "reportId 必須是非空字串");
  if (!kinds.includes(input.kind)) return err("bad_args", `kind 必須是 ${kinds.join("、")}`);
  if (typeof input.summary !== "string") return err("bad_args", "summary 必須是字串");
  if (input.kind === "needs-input" && !(input.question ?? "").trim()) return err("bad_args", "needs-input 需要 question");
  const artifacts = input.artifacts ?? [];
  let total = input.summary.length + (input.question ?? "").length;
  for (const a of artifacts) {
    if (!a.name?.trim() || !ARTIFACT_TYPES.includes(a.mediaType) || typeof a.text !== "string") return err("bad_args", "附件需要 name、合法的 mediaType 與 text");
    if (a.text.length > MAX_ARTIFACT_CHARS) return err("bad_args", `附件「${a.name}」超過 ${MAX_ARTIFACT_CHARS / 1024} KiB`);
    if (a.mediaType === "application/json") { try { JSON.parse(a.text); } catch { return err("bad_args", `附件「${a.name}」不是合法 JSON`); } }
    total += a.text.length;
  }
  if (total > MAX_REPORT_CHARS) return err("bad_args", "回報總大小超過上限");
  if (input.kind === "result" && !artifacts.length && !input.summary.trim()) return err("bad_args", "result 需要 summary 或附件");

  const print = fingerprint(input);
  const previous = state.reports.find((r) => r.taskId === task.id && r.attemptId === input.attemptId && r.reportId === input.reportId);
  if (previous) return previous.fingerprint === print ? ok([]) : err("report_conflict", "相同 reportId 但內容不同");
  if (!task.attemptIds.includes(input.attemptId)) return err("stale_attempt", "這個任務沒有這個 attemptId");

  const report = (stale?: Report["stale"]) => ev("ReportReceived", {
    report: { reportId: input.reportId, taskId: task.id, attemptId: input.attemptId, kind: input.kind, summary: input.summary, fingerprint: print, ...(stale ? { stale } : {}) },
    artifacts: artifacts.map((a, i): Artifact => ({
      id: `${task.id}:${input.attemptId}:${input.reportId}:${i}`, taskId: task.id, attemptId: input.attemptId,
      name: a.name.trim(), mediaType: a.mediaType, text: a.text, bytes: new TextEncoder().encode(a.text).length,
    })),
  });
  const current = task.attempt?.id === input.attemptId;
  if (!current) return ok([report("old-attempt")]);
  if (TERMINAL.includes(task.status) || task.status === "declined" || task.status === "result-ready") return ok([report("terminal")]);
  // No InputWillStart yet: keep the report, but do not let it move the task.
  if (task.status === "queued" || (task.status === "dispatching" && !task.attempt?.inputStarted)) return ok([report("unmatched")]);

  const from = task.status;
  const events = [report()];
  const openQuestions = state.issues.filter((i) => i.taskId === task.id && i.kind === "question" && !i.resolvedAt);
  const closeQuestions = () => openQuestions.map((i) => ev("IssueResolved", { issueId: i.id }));
  const allowed: Record<ReportInput["kind"], TaskStatus[]> = {
    accepted: ["sent", "uncertain", "dispatching"],
    progress: ["sent", "accepted", "running", "uncertain", "dispatching", "needs-input"],
    "needs-input": ["sent", "accepted", "running", "uncertain", "dispatching", "needs-input"],
    declined: ["sent", "accepted", "needs-input", "uncertain", "dispatching"],
    result: ["sent", "accepted", "running", "needs-input", "uncertain", "dispatching"],
    failed: ACTIVE,
    cancelled: ACTIVE,
  };
  if (!allowed[input.kind].includes(from)) return ok([report("terminal")]);
  const to: Record<ReportInput["kind"], TaskStatus> = {
    accepted: "accepted", progress: "running", "needs-input": "needs-input", declined: "declined", result: "result-ready", failed: "failed", cancelled: "cancelled",
  };
  events.push(ev("TaskStatusChanged", { taskId: task.id, status: to[input.kind], ...(input.kind === "result" ? { resultArtifactIds: artifacts.map((_, i) => `${task.id}:${input.attemptId}:${input.reportId}:${i}`), cancelledBeforeResult: task.cancelRequested || undefined } : {}) }));
  if (input.kind === "needs-input") {
    // A new question replaces any earlier open one (the worker asked again after an answer).
    events.push(...closeQuestions());
    events.push(ev("IssueOpened", { issue: { id: `issue:${task.id}:${input.attemptId}:${input.reportId}`, taskId: task.id, memberId: task.memberId, kind: "question", text: input.question!.trim() } }));
  } else if (input.kind !== "accepted") {
    events.push(...closeQuestions());
  }
  void actor;
  if (input.kind === "result") {
    const step = stepOf(state, task);
    const member = state.members.find((m) => m.id === task.memberId);
    // Only an intermediate step that opted in, from a worker that reports by protocol, is accepted without a person.
    if (step?.acceptance === "auto-on-protocol-result" && member?.reportMode === "protocol" && !task.cancelRequested) {
      events.push(ev("TaskStatusChanged", { taskId: task.id, status: "completed", acceptedBy: "auto", checks: [] }));
      const run = runOf(state, task.runId);
      if (run && state.tasks.filter((t) => t.runId === run.id && t.id !== task.id).every((t) => t.status === "completed")) events.push(ev("RunCompleted", { runId: run.id }));
    }
  }
  return ok(events);
}

// ---- reduce ----
const str = (v: unknown) => (typeof v === "string" ? v : "");
const patchTask = (state: ProjectState, id: string, fn: (t: Task) => Task): ProjectState => ({ ...state, tasks: state.tasks.map((t) => (t.id === id ? fn(t) : t)) });

export function reduceTasks(state: ProjectState, event: ProjectEvent): ProjectState {
  const d = event.data;
  switch (event.type) {
    case "PlanVersionCreated":
      return { ...state, plans: [...state.plans, d.plan as PlanVersion] };
    case "ExecutionConsentRecorded":
      return { ...state, consents: [...state.consents, d.consent as ProjectState["consents"][number]] };
    case "RunStarted":
      return { ...state, runs: [...state.runs, { id: str(d.runId), planId: str(d.planId), planVersion: Number(d.planVersion), status: "running", taskIds: d.taskIds as string[], consentId: str(d.consentId), auto: d.auto === true }] };
    case "RunPaused":
    case "RunResumed":
    case "RunCompleted": {
      const next = event.type === "RunPaused" ? "paused" : event.type === "RunResumed" ? "running" : "completed";
      return { ...state, runs: state.runs.map((r) => (r.id === d.runId ? { ...r, status: next } : r)) };
    }
    case "RunAutoChanged":
      return { ...state, runs: state.runs.map((r) => (r.id === d.runId ? { ...r, auto: d.auto === true } : r)) };
    case "RunClosed":
      return { ...state, runs: state.runs.map((r) => (r.id === d.runId ? { ...r, status: "closed", unfinished: d.unfinished as string[] } : r)) };
    case "ObservedResultSubmitted": {
      const artifacts = (d.artifacts as Artifact[]) ?? [];
      const next = patchTask(state, str(d.taskId), (t) => ({ ...t, observed: { summary: str(d.summary), artifactIds: artifacts.map((a) => a.id), at: event.at } }));
      return { ...next, artifacts: [...next.artifacts, ...artifacts] };
    }
    case "TaskQueued":
      return { ...state, tasks: [...state.tasks, { activityAt: event.at, id: str(d.taskId), runId: str(d.runId), stepKey: str(d.stepKey), planVersion: Number(d.planVersion), memberId: str(d.memberId), status: "queued", attemptIds: [], cancelRequested: false, resultArtifactIds: [] }] };
    case "TaskDispatchPrepared": {
      const attempt = d.attempt as Attempt;
      return patchTask(state, str(d.taskId), (t) => ({ ...t, status: "dispatching", attempt, attemptIds: [...t.attemptIds, attempt.id], reworkFeedback: t.reworkFeedback, activityAt: event.at }));
    }
    case "InputWillStart":
      return patchTask(state, str(d.taskId), (t) => {
        const attempt = t.attempt;
        return attempt && attempt.id === d.attemptId ? { ...t, attempt: { ...attempt, inputStarted: true } } : t;
      });
    case "TaskStatusChanged":
      return patchTask(state, str(d.taskId), (t) => {
        const next: Task = { ...t, status: d.status as TaskStatus, activityAt: event.at };
        if (d.releaseAttempt) delete next.attempt;
        if (d.status === "result-ready" || d.status === "failed" || d.status === "cancelled" || d.status === "queued") delete next.observed;
        if (Array.isArray(d.resultArtifactIds)) next.resultArtifactIds = d.resultArtifactIds as string[];
        return next;
      });
    case "ReportReceived": {
      const report = d.report as Report;
      const artifacts = (d.artifacts as Artifact[]) ?? [];
      // Hearing from the worker about its current attempt counts as activity; a stale report does not.
      if (!report.stale) state = patchTask(state, report.taskId, (t) => ({ ...t, activityAt: event.at }));
      return { ...state, reports: [...state.reports, report], artifacts: report.stale ? state.artifacts : [...state.artifacts, ...artifacts] };
    }
    case "IssueOpened":
      return { ...state, issues: [...state.issues, d.issue as Issue] };
    case "IssueReplyQueued":
      return { ...state, replies: [...state.replies, d.reply as IssueReply] };
    case "ReplyDeliveryChanged":
      return { ...state, replies: state.replies.map((r) => (r.id === d.replyId ? { ...r, delivery: d.delivery as IssueReply["delivery"] } : r)) };
    case "IssueResolved":
      return { ...state, issues: state.issues.map((i) => (i.id === d.issueId ? { ...i, resolvedAt: event.at } : i)) };
    case "TaskCancelRequested":
      return patchTask(state, str(d.taskId), (t) => ({ ...t, cancelRequested: true }));
    case "TaskReworkRequested":
      return patchTask(state, str(d.taskId), (t) => {
        const next: Task = { ...t, status: "queued", reworkFeedback: str(d.feedback), cancelRequested: false };
        delete next.attempt;
        delete next.observed;
        return next;
      });
    case "TaskRetryRequested":
      return patchTask(state, str(d.taskId), (t) => {
        const next: Task = { ...t, status: "queued", memberId: str(d.memberId) || t.memberId, cancelRequested: false, reworkFeedback: undefined, resultArtifactIds: [] };
        delete next.attempt;
        delete next.observed;
        return next;
      });
    default:
      return state;
  }
}

// ---- what a worker reads with `project task get` ----
export type TaskPayload = {
  taskId: string;
  attemptId?: string;
  stepKey: string;
  title: string;
  objective: string;
  scope: string;
  instruction: string;
  completion: string[];
  inputs: { fromStep: string; artifacts: { id: string; name: string; mediaType: string; text: string }[]; missing: string[] }[];
  replies: { id: string; question: string; answer: string }[];
  rework?: { feedback: string; previousArtifacts: { id: string; name: string; mediaType: string; text: string }[] };
};
// Inputs are the accepted results of upstream tasks in the same run, frozen by artifact id: a later
// retry of an upstream step never changes what an already-started task is told to read.
export function buildTaskPayload(state: ProjectState, taskId: string): TaskPayload | undefined {
  const task = taskOf(state, taskId);
  const step = task && stepOf(state, task);
  const run = task && runOf(state, task.runId);
  const plan = run && planOf(state, run);
  if (!task || !step || !plan) return undefined;
  const pick = (ids: string[]) => ids.map((id) => state.artifacts.find((a) => a.id === id)).filter((a): a is Artifact => !!a).map(({ id, name, mediaType, text }) => ({ id, name, mediaType, text }));
  const inputs = step.inputFrom.map((from) => {
    const upstream = state.tasks.find((t) => t.runId === task.runId && t.stepKey === from.stepKey && t.status === "completed");
    const found = pick(upstream?.resultArtifactIds ?? []);
    const wanted = from.artifactNames;
    const artifacts = wanted.length ? found.filter((a) => wanted.includes(a.name)) : found;
    return { fromStep: from.stepKey, artifacts, missing: wanted.filter((n) => !found.some((a) => a.name === n)) };
  });
  const rework = task.reworkFeedback ? { feedback: task.reworkFeedback, previousArtifacts: pick(state.artifacts.filter((a) => a.taskId === task.id).map((a) => a.id)) } : undefined;
  return {
    taskId: task.id, attemptId: task.attempt?.id, stepKey: step.key, title: step.title, objective: plan.objective, scope: plan.scope,
    instruction: step.instruction, completion: step.completion, inputs, ...(rework ? { rework } : {}),
    replies: state.replies.filter((r) => r.taskId === task.id && r.attemptId === task.attempt?.id).map((r) => ({ id: r.id, question: state.issues.find((i) => i.id === r.issueId)?.text ?? "", answer: r.text })),
  };
}
