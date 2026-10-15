// Hands work to agents: the pump that delivers queued tasks automatically, the user's own
// "hand over" buttons, coordinator messages and answers to questions. All of it goes through one
// queue so two deliveries never type into the same terminal at once (docs §9). Typing only ever
// follows a journaled InputWillStart; after that, nothing is resent on its own.
import { invoke } from "@tauri-apps/api/core";
import { holdInstance, isHeld, giveBack as releaseHold, leaveInstance, tickHold, type Holds } from "./project-hold";
import { instanceKey, surfaceForInstance } from "./project-control";
import { introPrompt, messagePrompt, queuedBatch, queuedReplies, replyPrompt, taskPrompt } from "./project-prompts";
import { blockedBy, busyElsewhere, nextDeliverable, verdict, type ScheduleContext, type SkipReason } from "./project-schedule";
import { coordinatorOf } from "./projects";
import { allLoaded, current, dispatch } from "./project-store";
import type { Observed } from "./project-tasks";
import type { ActionBody, ProjectState } from "./project-types";

export type SendResult = "sent" | "busy" | "blocked" | "gone";
type Surf = { id: string; tmuxSession?: string };
export type DeliveryHost = {
  notify(error: unknown): void;
  surfaces(): Surf[];
  observe(ids: string[]): Promise<Record<string, Observed>>;
  // Types the prompt when the agent is ready. `beforeInput` runs after the checks and before any
  // key is sent (if it throws nothing is typed). `force` skips the idle checks but never types into
  // a question or a screen with no agent.
  sendPrompt(surface: string, text: string, beforeInput: () => Promise<void>, options?: { force?: boolean }): Promise<SendResult>;
};
export type DeliverOutcome = { ok: true } | { ok: false; reason: SkipReason };

const user = { kind: "user" } as const;
const TICK_MS = 1000;

export function createDelivery(host: DeliveryHost) {
  const holds: Holds = new Map();
  const seen = new Map<string, { state: Observed; at: number }>();
  let controlMode = "";
  let ticking = false;
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  // The same error every second would bury the user; show each distinct one once in a while.
  const lastShown = new Map<string, number>();
  const report = (error: unknown) => {
    const key = String(error);
    if (Date.now() - (lastShown.get(key) ?? 0) < 30_000) return;
    lastShown.set(key, Date.now());
    host.notify(error);
  };

  const surfaceOf = (state: ProjectState, memberId: string) => {
    const binding = state.bindings[memberId];
    return binding ? surfaceForInstance(binding.instanceId, host.surfaces()) : undefined;
  };
  const observedOf = (state: ProjectState, memberId: string) => {
    const surface = surfaceOf(state, memberId);
    return surface ? seen.get(surface.id) : undefined;
  };
  const contextFor = (root: string, state: ProjectState, extra: Partial<ScheduleContext> = {}): ScheduleContext => ({
    controlMode,
    online: (memberId) => !!surfaceOf(state, memberId),
    observed: (memberId) => observedOf(state, memberId),
    held: (memberId) => isHeld(holds, state.bindings[memberId]?.instanceId ?? ""),
    busyElsewhere: (memberId) => busyElsewhere(allLoaded(), root, state.bindings[memberId]?.instanceId ?? ""),
    now: Date.now(),
    ...extra,
  });

  async function refreshObserved(ids: string[]) {
    if (!ids.length) return;
    const got = await host.observe(ids);
    const at = Date.now();
    for (const id of ids) if (got[id]) seen.set(id, { state: got[id], at });
  }

  // ---- one task ----
  // `auto` is the pump; a person's own click does not need the global control mode (that gate is
  // for agents using ctl), and refreshes the screen reading first.
  function handOver(root: string, taskId: string, how: { auto?: boolean; force?: boolean }): Promise<DeliverOutcome> {
    return exclusive(async () => {
      const base = current(root);
      const task = base?.state.tasks.find((t) => t.id === taskId);
      const surface = base && task && surfaceOf(base.state, task.memberId);
      if (!base?.state.config || !task || !surface) return { ok: false, reason: "offline" };
      if (!how.auto) await refreshObserved([surface.id]);
      const before = verdict(base.state, task, contextFor(root, base.state, { force: how.force, ...(how.auto ? {} : { controlMode: "full" }) }));
      if (!before.ok) return before;

      const attemptId = crypto.randomUUID(), effectId = crypto.randomUUID();
      let prepared;
      try {
        prepared = await dispatch(root, user, { type: "PrepareDispatch", taskId, attemptId, effectId });
      } catch (error) {
        // The commit may have landed even though catching up afterwards failed; release it so the task is not stuck.
        await dispatch(root, user, { type: "RecordInputResult", taskId, attemptId, effectId, outcome: "not-sent" }).catch(() => {});
        throw error;
      }
      // Someone else moved the task first (another window, a click): not an error, just not ours.
      if (!prepared.ok) return prepared.error.code === "invalid_state" ? { ok: false, reason: "busy" } : Promise.reject(new Error(prepared.error.message));
      const state = prepared.value.state;
      const prompt = taskPrompt(state.config!.id, state.tasks.find((t) => t.id === taskId)!, state);
      let started = false;
      try {
        if (!prompt) throw new Error("task prompt could not be built");
        const result = await host.sendPrompt(surface.id, prompt, async () => {
          const mark = await dispatch(root, user, { type: "RecordInputStart", taskId, attemptId, effectId });
          if (!mark.ok) throw new Error(mark.error.message);
          started = true;
        }, { force: how.force });
        if (result === "sent") {
          const done = await dispatch(root, user, { type: "RecordInputResult", taskId, attemptId, effectId, outcome: "sent" });
          if (!done.ok) throw new Error(done.error.message);
          return { ok: true };
        }
        await dispatch(root, user, { type: "RecordInputResult", taskId, attemptId, effectId, outcome: "not-sent" });
        return { ok: false, reason: result === "blocked" ? "agent-blocked" : result === "busy" ? "agent-busy" : "offline" };
      } catch (error) {
        // After InputWillStart we cannot know what reached the agent: uncertain, never resent.
        await dispatch(root, user, { type: "RecordInputResult", taskId, attemptId, effectId, outcome: started ? "unknown" : "not-sent" }).catch(() => {});
        throw error;
      }
    });
  }

  // ---- coordinator messages and answers ----
  // The user is at that terminal, or agents may not use ctl yet: wait instead of typing into their draft
  // or into an agent that could not answer anyway.
  const mayType = (state: ProjectState, memberId: string) =>
    controlMode === "full" && !isHeld(holds, state.bindings[memberId]?.instanceId ?? "");

  // Marks each item `sending` in the journal, types once, then marks `sent`. If it fails before
  // anything was typed the items go back to the queue; after that they are `uncertain`, never resent.
  async function typeBatch(root: string, surface: Surf, prompt: string, ids: string[], mark: (id: string, delivery: "queued" | "sending" | "sent" | "uncertain") => ActionBody) {
    let started = false;
    const marked: string[] = [];
    try {
      const result = await host.sendPrompt(surface.id, prompt, async () => {
        for (const id of ids) {
          const done = await dispatch(root, user, mark(id, "sending"));
          if (!done.ok) throw new Error(done.error.message);
          marked.push(id);
        }
        started = true;
      });
      if (result === "sent") for (const id of ids) await dispatch(root, user, mark(id, "sent"));
    } catch (error) {
      for (const id of started ? ids : marked) await dispatch(root, user, mark(id, started ? "uncertain" : "queued")).catch(() => {});
      throw error;
    }
  }
  async function messages(root: string) {
    const project = current(root);
    if (!project?.state.config || project.readonlyReason) return;
    const coordinator = coordinatorOf(project.state);
    const surface = coordinator && surfaceOf(project.state, coordinator.id);
    const batch = queuedBatch(project.state);
    if (!coordinator || !surface || !batch.length || !mayType(project.state, coordinator.id)) return;
    await typeBatch(root, surface, messagePrompt(project.state.config.id, batch), batch.map((m) => m.id),
      (messageId, delivery) => ({ type: "SetMessageDelivery", messageId, delivery }));
  }
  async function replies(root: string) {
    const project = current(root);
    if (!project?.state.config || project.readonlyReason) return;
    for (const { task, replies: group } of queuedReplies(project.state)) {
      const surface = surfaceOf(project.state, task.memberId);
      if (!surface || !mayType(project.state, task.memberId)) continue;
      await typeBatch(root, surface, replyPrompt(project.state.config.id, task, group), group.map((r) => r.id),
        (replyId, delivery) => ({ type: "SetReplyDelivery", replyId, delivery }));
    }
  }
  // Asking a member to say hello. Not journaled (it changes nothing), but it queues behind other
  // typing and respects the hold, so it cannot interleave with a task prompt or land in a draft.
  function intro(root: string, memberId: string): Promise<SendResult | "held" | "offline"> {
    return exclusive(async () => {
      const project = current(root);
      const member = project?.state.members.find((m) => m.id === memberId);
      const surface = project && surfaceOf(project.state, memberId);
      if (!project?.state.config || !member || !surface) return "offline";
      if (isHeld(holds, project.state.bindings[memberId]?.instanceId ?? "")) return "held";
      return host.sendPrompt(surface.id, introPrompt(project.state.config.id, project.state.config.name, member), async () => {});
    });
  }

  // ---- the pump ----
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      controlMode = await invoke<string>("control_mode").catch(() => controlMode);
      const projects = allLoaded().filter((p) => p.state.config && !p.readonlyReason);
      // Screens to read: workers that matter right now, coordinators with something waiting, held terminals.
      const wanted = new Set<string>();
      for (const { state } of projects) {
        const interesting = new Set<string>();
        for (const run of state.runs.filter((r) => r.status === "running" || r.status === "paused")) {
          for (const task of state.tasks.filter((t) => t.runId === run.id && t.status !== "completed")) interesting.add(task.memberId);
        }
        const coordinator = coordinatorOf(state);
        if (coordinator && (queuedBatch(state).length || state.replies.length)) interesting.add(coordinator.id);
        for (const id of interesting) { const surface = surfaceOf(state, id); if (surface) wanted.add(surface.id); }
      }
      for (const instance of holds.keys()) { const surface = surfaceForInstance(instance, host.surfaces()); if (surface) wanted.add(surface.id); else holds.delete(instance); }
      await refreshObserved([...wanted]);
      const now = Date.now();
      for (const instance of [...holds.keys()]) {
        const surface = surfaceForInstance(instance, host.surfaces());
        tickHold(holds, instance, surface && seen.get(surface.id)?.state, now);
      }
      for (const { root } of projects) {
        await exclusive(async () => { await messages(root); await replies(root); });
        // Re-read after every hand-over: it changes who is busy.
        for (let guard = 0; guard < 20; guard++) {
          const now2 = current(root);
          if (!now2) break;
          const next = nextDeliverable(now2.state, contextFor(root, now2.state))[0];
          if (!next) break;
          const outcome = await handOver(root, next.id, { auto: true });
          if (!outcome.ok) break;
        }
      }
    } catch (error) {
      report(error);
    } finally {
      ticking = false;
    }
  }

  // ---- the user at a terminal ----
  const memberInstance = (surface: Surf) => {
    const key = instanceKey(surface);
    return allLoaded().some(({ state }) => Object.values(state.bindings).some((b) => b.instanceId === key)) ? key : undefined;
  };
  let viewing = new Set<string>();

  return {
    start() {
      setInterval(() => { tick().catch(report); }, TICK_MS);
    },
    handOver,
    // After an app restart: tasks left mid-hand-over are settled once, by the main window.
    async recoverAll() {
      for (const { root, state } of allLoaded()) {
        if (state.tasks.some((t) => t.status === "dispatching")) await dispatch(root, user, { type: "RecoverTasks" });
        // Typing may have been cut off mid-way; never resend, just say it is unclear.
        for (const message of state.messages.filter((m) => m.author === "user" && m.delivery === "sending")) {
          await dispatch(root, user, { type: "SetMessageDelivery", messageId: message.id, delivery: "uncertain" });
        }
        for (const reply of state.replies.filter((r) => r.delivery === "sending")) {
          await dispatch(root, user, { type: "SetReplyDelivery", replyId: reply.id, delivery: "uncertain" });
        }
      }
    },
    intro,
    messages: (root: string) => exclusive(() => messages(root)),
    replies: (root: string) => exclusive(() => replies(root)),
    observedOf: (root: string, memberId: string): Observed | undefined => {
      const project = current(root);
      return project ? observedOf(project.state, memberId)?.state : undefined;
    },
    // Why this queued task is not moving (undefined when it could go now).
    whyNot: (root: string, taskId: string): SkipReason | undefined => {
      const project = current(root);
      const task = project?.state.tasks.find((t) => t.id === taskId);
      if (!project || !task || task.status !== "queued") return undefined;
      const run = project.state.runs.find((r) => r.id === task.runId);
      return blockedBy(project.state, task, contextFor(root, project.state, run?.auto ? {} : { controlMode: "full", force: true }));
    },
    // Members of this project whose terminal the user is holding, with how many tasks wait on it.
    heldMembers: (root: string) => {
      const project = current(root);
      if (!project) return [];
      return project.state.members.flatMap((member) => {
        const instance = project.state.bindings[member.id]?.instanceId;
        if (!instance || !isHeld(holds, instance)) return [];
        return [{ memberId: member.id, waiting: project.state.tasks.filter((t) => t.memberId === member.id && t.status === "queued").length }];
      });
    },
    giveBack(root: string, memberId: string) {
      const instance = current(root)?.state.bindings[memberId]?.instanceId;
      if (instance) releaseHold(holds, instance);
    },
    // main.ts reports which terminals the user is looking at; looking at an agent's terminal holds it,
    // looking away starts the countdown back to the project.
    setViewing(surfaces: Surf[]) {
      const next = new Set<string>();
      for (const surface of surfaces) {
        const instance = memberInstance(surface);
        if (instance) { next.add(instance); if (!viewing.has(instance)) holdInstance(holds, instance); }
      }
      for (const instance of viewing) if (!next.has(instance)) leaveInstance(holds, instance, Date.now());
      viewing = next;
    },
  };
}
