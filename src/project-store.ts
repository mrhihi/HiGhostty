// Connects the pure project rules (projects.ts) to the Rust journal. Every window may load
// and write a project; the journal's revision check serializes them, and a conflicting
// commit re-decides on the fresh state. Does not touch the DOM.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { decide, emptyState, memberForInstance, reduce } from "./projects";
import type { ActionBody, Actor, Member, ProjectError, ProjectEvent, ProjectState, Result } from "./project-types";

type Transaction = { revision: number; actionId: string; events: ProjectEvent[] };
type Snapshot = { root: string; revision: number; transactions: Transaction[]; readonlyReason: string | null };
export type IndexItem = { root: string; name: string; projectId: string; lastOpenedAt: string; exists: boolean };
export type Loaded = { root: string; revision: number; state: ProjectState; readonlyReason: string | null };

const loaded = new Map<string, Loaded>();
const listeners = new Set<(root: string) => void>();
const MAX_RETRIES = 3;

export const onProjectChanged = (fn: (root: string) => void) => (listeners.add(fn), () => listeners.delete(fn));
const notify = (root: string) => listeners.forEach((fn) => fn(root));

function apply(root: string, snapshot: Snapshot, from?: Loaded): Loaded {
  let state = from?.state ?? emptyState();
  for (const tx of snapshot.transactions) for (const event of tx.events) state = reduce(state, event);
  const next = { root, revision: snapshot.revision, state, readonlyReason: snapshot.readonlyReason };
  loaded.set(root, next);
  return next;
}

export async function openProject(root: string, create = false, gitExclude = false): Promise<Loaded> {
  const snapshot = await invoke<Snapshot>("project_open", { root, create, gitExcludeOnCreate: gitExclude });
  // A window that already holds the project keeps its state and only catches up.
  const known = loaded.get(snapshot.root);
  return known ? refresh(snapshot.root) : apply(snapshot.root, snapshot);
}

export async function refresh(root: string): Promise<Loaded> {
  const known = loaded.get(root);
  const snapshot = await invoke<Snapshot>("project_snapshot", { root, afterRevision: known?.revision ?? 0 });
  return apply(root, snapshot, known);
}

// The project member an agent instance belongs to, across every project this window has loaded.
export function memberOfInstance(instance: string): { root: string; projectName: string; member: Member } | undefined {
  for (const project of loaded.values()) {
    const member = memberForInstance(project.state, instance);
    if (member) return { root: project.root, projectName: project.state.config?.name ?? "", member };
  }
  return undefined;
}
// Load every remembered project so member terminals are recognized before any project view is opened.
export async function loadKnownProjects(): Promise<void> {
  for (const item of await indexList().catch(() => [])) {
    if (item.exists) await openProject(item.root).catch(() => {});
  }
}

export const current = (root: string) => loaded.get(root);

export async function indexList(): Promise<IndexItem[]> {
  return invoke<IndexItem[]>("project_index_list");
}
// The folder a projectId lives in, from the local index; a root path is accepted as-is.
export async function rootFor(projectId: string): Promise<string | undefined> {
  return (await indexList()).find((item) => item.projectId === projectId || item.root === projectId)?.root;
}

export type Committed = { revision: number; state: ProjectState; events: ProjectEvent[] };
export type StoreError = ProjectError | { code: "revision_conflict" | "storage_readonly" | "failed"; message: string };

const storeError = (error: unknown): StoreError => {
  const text = String(error);
  const code = text.startsWith("revision_conflict") ? "revision_conflict" : text.startsWith("storage_readonly") ? "storage_readonly" : "failed";
  return { code, message: text.replace(/^(revision_conflict|storage_readonly): /, "") };
};

// Decide against the latest state, then append. On a revision conflict another window got in
// first: catch up and decide again (the same actionId keeps a retry from applying twice).
export async function dispatch(root: string, actor: Actor, body: ActionBody, actionId: string = crypto.randomUUID()): Promise<Result<Committed, StoreError>> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const base = loaded.get(root) ?? (await refresh(root));
    const decision = decide(base.state, { actionId, actor, body }, new Date().toISOString());
    if (!decision.ok) return decision;
    const { events } = decision.value;
    try {
      await invoke("project_commit", { root, expectedRevision: base.revision, actionId, events });
    } catch (error) {
      const failure = storeError(error);
      if (failure.code === "revision_conflict" && attempt < MAX_RETRIES - 1) {
        await refresh(root);
        continue;
      }
      return { ok: false, error: failure };
    }
    // The journal may be ahead of us if other windows committed in between; catching up
    // also picks up our own events, so there is no separate local reduce.
    const next = await refresh(root);
    notify(root);
    return { ok: true, value: { revision: next.revision, state: next.state, events } };
  }
  return { ok: false, error: { code: "revision_conflict", message: "專案同時被其他視窗更新，請再試一次" } };
}

export async function startProjectEvents(): Promise<void> {
  await listen<{ root: string }>("project-changed", ({ payload }) => {
    if (!loaded.has(payload.root)) return;
    refresh(payload.root).then(() => notify(payload.root)).catch(() => {});
  });
}
