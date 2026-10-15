// What a member's small card says right now (docs/project-collaboration-v2-plan.md §5.2). DOM-free.
// Derived from the journal only: whether the agent is online is the panel's business, not a task state.
import { stepOf } from "./project-tasks.ts";
import type { ProjectState } from "./project-types.ts";

export type Activity = "needs-input" | "uncertain" | "review" | "waiting-help" | "working" | "idle";
export type MemberActivity = { activity: Activity; title?: string; taskId?: string };

// The most pressing thing first: a question blocks the worker, an unsure delivery risks a duplicate.
const RANK: Record<string, number> = { "needs-input": 0, uncertain: 1, "result-ready": 2, "waiting-help": 3, running: 4, accepted: 4, sent: 4, dispatching: 4 };

export function memberActivity(state: ProjectState, memberId: string): MemberActivity {
  const tasks = state.tasks.filter((t) => t.memberId === memberId && t.status in RANK)
    .sort((a, b) => RANK[a.status] - RANK[b.status]);
  const task = tasks[0];
  if (!task) return { activity: "idle" };
  const title = stepOf(state, task)?.title ?? task.stepKey;
  const activity: Activity = task.status === "needs-input" ? "needs-input" : task.status === "uncertain" ? "uncertain" : task.status === "result-ready" ? "review" : task.status === "waiting-help" ? "waiting-help" : "working";
  return { activity, title, taskId: task.id };
}

// Done and total for the latest run, counting the plan's own tasks.
export function runProgress(state: ProjectState): { done: number; total: number } | undefined {
  const run = state.runs.at(-1);
  if (!run) return undefined;
  const tasks = state.tasks.filter((t) => t.runId === run.id);
  return { done: tasks.filter((t) => t.status === "completed").length, total: tasks.length };
}

// Terminals a project owns: its coordinator and the live work sessions. They are listed under the project
// instead of in the workspace (docs/project-collaboration-v2-plan.md §5.1). Ownership is by member and
// execution ids, never by a flag on the tab, because a worker's own terminal is also a "coordinator" tab in places.
export type OwnedTerminal =
  | { kind: "coordinator"; memberId: string; instanceId?: string; favoriteId?: string; label: string }
  | { kind: "work"; memberId: string; instanceId: string; taskId: string; label: string; title?: string };

export function ownedTerminals(state: ProjectState): OwnedTerminal[] {
  const out: OwnedTerminal[] = [];
  const coordinator = state.members.find((m) => m.role === "coordinator");
  if (coordinator) out.push({ kind: "coordinator", memberId: coordinator.id, instanceId: state.bindings[coordinator.id]?.instanceId, favoriteId: coordinator.favoriteId, label: coordinator.name });
  for (const execution of state.executions) {
    if (execution.status !== "live") continue;
    const member = state.members.find((m) => m.id === execution.memberId);
    const task = state.tasks.find((t) => t.id === execution.taskId);
    out.push({ kind: "work", memberId: execution.memberId, instanceId: execution.instanceId, taskId: execution.taskId, label: member?.name ?? execution.memberId, title: task ? (stepOf(state, task)?.title ?? task.stepKey) : undefined });
  }
  return out;
}
