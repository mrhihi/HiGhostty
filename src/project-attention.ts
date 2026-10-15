// One projection of "what needs the user" for a project (docs/project-collaboration-v2-plan.md §8).
// DOM-free: the project page, sidebar, bell and the drop-down all read the same list. Stored facts
// come from the journal; terminal blocks are live and passed in. Reading something never resolves it.
import { activeRun, stepOf } from "./project-tasks.ts";
import type { ProjectState } from "./project-types.ts";

export type ActionKind = "start-plan" | "question" | "review-result" | "uncertain" | "terminal-blocked";

export type ActionItem = {
  // Stable across recomputation so seen/snoozed marks and double-click dedup can key on it.
  id: string;
  kind: ActionKind;
  projectId: string;
  memberId?: string;
  taskId?: string;
  attemptId?: string;
  // The question or plan the item was built from; a button sent against an older version is refused.
  sourceId: string;
  summary: string;
};

// Highest first: an approval or question blocks a worker, an unsure delivery risks a duplicate.
const ORDER: ActionKind[] = ["terminal-blocked", "question", "uncertain", "review-result", "start-plan"];

export type LiveBlock = { memberId: string; taskIds: string[] };

export function actionItems(state: ProjectState, live: { blocked?: LiveBlock[] } = {}): ActionItem[] {
  const projectId = state.config?.id;
  if (!projectId) return [];
  const items: ActionItem[] = [];
  const nameOf = (id: string) => state.members.find((m) => m.id === id)?.name ?? id;

  const plan = state.plans.at(-1);
  const run = activeRun(state);
  if (plan && !run && !state.runs.some((r) => r.planId === plan.id && r.planVersion === plan.version)) {
    items.push({ id: `plan:${plan.id}:${plan.version}`, kind: "start-plan", projectId, sourceId: `${plan.id}:${plan.version}`, summary: plan.title });
  }

  for (const issue of state.issues) {
    if (issue.resolvedAt || issue.kind !== "question") continue;
    const task = state.tasks.find((x) => x.id === issue.taskId);
    // A question whose task already moved on (cancelled, replaced attempt) is no longer the user's to answer.
    if (!task || task.status !== "needs-input") continue;
    items.push({ id: `issue:${issue.id}`, kind: "question", projectId, memberId: issue.memberId, taskId: task.id, attemptId: task.attempt?.id, sourceId: issue.id, summary: issue.text });
  }

  for (const task of state.tasks) {
    if (task.status === "uncertain") {
      items.push({ id: `uncertain:${task.id}:${task.attempt?.id ?? ""}`, kind: "uncertain", projectId, memberId: task.memberId, taskId: task.id, attemptId: task.attempt?.id, sourceId: task.attempt?.id ?? task.id, summary: stepOf(state, task)?.title ?? task.stepKey });
    } else if (task.status === "result-ready" && stepOf(state, task)?.acceptance === "user") {
      // Coordinator-accepted results are not the user's business; only steps that name the user are.
      items.push({ id: `review:${task.id}:${task.attempt?.id ?? ""}`, kind: "review-result", projectId, memberId: task.memberId, taskId: task.id, attemptId: task.attempt?.id, sourceId: task.attempt?.id ?? task.id, summary: stepOf(state, task)?.title ?? task.stepKey });
    }
  }

  const taskQuestioned = new Set(items.filter((i) => i.kind === "question").map((i) => i.taskId));
  for (const block of live.blocked ?? []) {
    // The structured question for the same task already covers a blocked terminal; show it once.
    if (block.taskIds.length && block.taskIds.every((id) => taskQuestioned.has(id))) continue;
    items.push({ id: `blocked:${block.memberId}`, kind: "terminal-blocked", projectId, memberId: block.memberId, sourceId: block.memberId, summary: nameOf(block.memberId) });
  }

  return items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

// Per-viewer marks, kept outside the journal. Seen only quiets a badge; the item stays until its source resolves.
export type Marks = { seen: Set<string>; snoozed: Map<string, number> };
export const emptyMarks = (): Marks => ({ seen: new Set(), snoozed: new Map() });

export function unseen(items: ActionItem[], marks: Marks, now: number): ActionItem[] {
  return items.filter((i) => !marks.seen.has(i.id) && (marks.snoozed.get(i.id) ?? 0) <= now);
}

// Marks live in localStorage so every window agrees; parsing is defensive because the value is not ours to trust.
export const parseSeen = (raw: string | null): string[] => {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  } catch { return []; }
};

// Forget marks for items that no longer exist, so a later, different item with the same id starts unread.
export function pruneMarks(marks: Marks, items: ActionItem[]): void {
  const live = new Set(items.map((i) => i.id));
  for (const id of marks.seen) if (!live.has(id)) marks.seen.delete(id);
  for (const id of marks.snoozed.keys()) if (!live.has(id)) marks.snoozed.delete(id);
}

// The one line shown above the terminals: the most pressing unseen item across projects, and how many others wait.
// Never opens anything by itself (docs/project-collaboration-v2-plan.md §5.3).
export function bannerOf<T extends { item: ActionItem }>(entries: T[], marks: Marks, now: number): { first?: T; more: number } {
  const open = entries.filter((e) => !marks.seen.has(e.item.id) && (marks.snoozed.get(e.item.id) ?? 0) <= now)
    .sort((a, b) => ORDER.indexOf(a.item.kind) - ORDER.indexOf(b.item.kind));
  return { first: open[0], more: Math.max(0, open.length - 1) };
}
