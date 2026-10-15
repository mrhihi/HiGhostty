// Which queued task may be handed to its worker right now, and why not (docs §9). Pure: the pump
// supplies what it saw (control mode, screens, holds) and acts on the answer.
import { queueReasonOf } from "./project-tasks.ts";
import type { Observed } from "./project-tasks.ts";
import type { ProjectState, Task } from "./project-types.ts";

// A screen reading older than this is not trusted to decide that the agent is idle.
export const OBSERVATION_MAX_AGE_MS = 5_000;

export type SkipReason =
  | "paused" | "closed" | "dependency" | "busy" | "unbound"   // from the task rules
  | "control-mode" | "offline" | "stale-observation" | "agent-busy" | "agent-blocked" | "agent-unknown" | "held" | "other-project";

export type ScheduleContext = {
  controlMode: string;
  online(memberId: string): boolean;
  observed(memberId: string): { state: Observed; at: number } | undefined;
  held(memberId: string): boolean;
  // The same agent holds a task of another project.
  busyElsewhere(memberId: string): boolean;
  now: number;
  // The user pressed "hand over now": skip the busy/stale/hold checks (never past blocked or a screen with no agent).
  force?: boolean;
};

// A worker with a launch spec gets a work session per task; the personal terminal is never typed into.
export const isolated = (state: ProjectState, memberId: string): boolean => {
  const member = state.members.find((m) => m.id === memberId);
  return member?.role === "worker" && !!member.launch;
};
// The work session of a task's current attempt, if one is running.
export const executionOfTask = (state: ProjectState, task: { id: string; attempt?: { id: string } }) =>
  state.executions.find((x) => x.status === "live" && x.taskId === task.id && x.attemptId === task.attempt?.id);

export function verdict(state: ProjectState, task: Task, ctx: ScheduleContext): { ok: true } | { ok: false; reason: SkipReason } {
  if (task.status !== "queued") return { ok: false, reason: "busy" };
  const rule = queueReasonOf(state, task);
  if (rule) return { ok: false, reason: rule };
  if (ctx.controlMode !== "full") return { ok: false, reason: "control-mode" };
  // A work session starts fresh: nothing to observe, no terminal to hold, no other project sharing it.
  if (isolated(state, task.memberId)) return { ok: true };
  if (!ctx.online(task.memberId)) return { ok: false, reason: "offline" };
  if (ctx.busyElsewhere(task.memberId)) return { ok: false, reason: "other-project" };
  const seen = ctx.observed(task.memberId);
  // Typing into an open question would answer it; no override exists for that.
  if (seen?.state === "blocked") return { ok: false, reason: "agent-blocked" };
  // No agent on that screen (a plain shell, say): typing a prompt there would run it as commands.
  if (seen?.state === "unknown") return { ok: false, reason: "agent-unknown" };
  if (ctx.force) return { ok: true };
  if (ctx.held(task.memberId)) return { ok: false, reason: "held" };
  if (!seen || ctx.now - seen.at > OBSERVATION_MAX_AGE_MS) return { ok: false, reason: "stale-observation" };
  if (seen.state === "working") return { ok: false, reason: "agent-busy" };
  if (seen.state !== "idle") return { ok: false, reason: "agent-unknown" };
  return { ok: true };
}

// Tasks to hand over this round: run order then step order, at most one per member.
export function nextDeliverable(state: ProjectState, ctx: ScheduleContext): Task[] {
  const runs = state.runs.filter((r) => r.status === "running" && r.auto);
  const picked: Task[] = [];
  const used = new Set<string>();
  for (const run of runs) {
    for (const id of run.taskIds) {
      const task = state.tasks.find((t) => t.id === id);
      if (!task || used.has(task.memberId) || !verdict(state, task, ctx).ok) continue;
      used.add(task.memberId);
      picked.push(task);
    }
  }
  return picked;
}

// For the task card: the specific thing in the way, or undefined.
export const blockedBy = (state: ProjectState, task: Task, ctx: ScheduleContext): SkipReason | undefined => {
  const v = verdict(state, task, ctx);
  return v.ok ? undefined : v.reason;
};

// Instances that hold a task in progress in some project other than `exceptRoot`.
export function busyElsewhere(projects: { root: string; state: ProjectState }[], exceptRoot: string, instanceId: string): boolean {
  const active = ["dispatching", "sent", "accepted", "running", "needs-input", "uncertain"];
  return projects.some(({ root, state }) =>
    root !== exceptRoot && state.tasks.some((t) => active.includes(t.status) && state.bindings[t.memberId]?.instanceId === instanceId));
}
