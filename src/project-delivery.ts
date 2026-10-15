// Hands work to agents: the pump that delivers queued tasks automatically, the user's own
// "hand over" buttons, coordinator messages and answers to questions. All of it goes through one
// queue so two deliveries never type into the same terminal at once (docs §9). Typing only ever
// follows a journaled InputWillStart; after that, nothing is resent on its own.
import { invoke } from "@tauri-apps/api/core";
import { holdInstance, isHeld, giveBack as releaseHold, leaveInstance, tickHold, type Holds } from "./project-hold";
import { instanceKey, surfaceForInstance } from "./project-control";
import { helpAnswerPrompt, helpPrompt, helpResultPrompt, introPrompt, messagePrompt, modelFor, queuedBatch, queuedHelpAnswers, queuedHelpResults, queuedHelps, queuedNotices, noticePrompt, queuedReplies, replyPrompt, taskPrompt } from "./project-prompts";
import { blockedBy, busyElsewhere, executionOfTask, isolated, nextDeliverable, verdict, type ScheduleContext, type SkipReason } from "./project-schedule";
import { coordinatorOf } from "./projects";
import { allLoaded, current, dispatch } from "./project-store";
import type { Observed } from "./project-tasks";
import type { ActionBody, Help, LaunchSpec, ProjectState, Task } from "./project-types";

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
  // Which agent runs in the terminal (claude, codex…), from its start command; undefined when unknown.
  agentKind(surface: string): string | undefined;
  // Starts a fresh agent for a work session and resolves once it is ready for a prompt. Throws when it cannot.
  startWorkSession(spec: LaunchSpec, model?: string): Promise<Surf>;
  closeSurface(surface: string): Promise<void>;
  // True once the saved terminals are back after a start; before that a missing terminal proves nothing.
  ready(): boolean;
};
export type DeliverOutcome = { ok: true } | { ok: false; reason: SkipReason };

const user = { kind: "user" } as const;
const TICK_MS = 1000;

export function createDelivery(host: DeliveryHost) {
  const holds: Holds = new Map();
  const seen = new Map<string, { state: Observed; at: number }>();
  let controlMode = "";
  let ticking = false;
  // The model last set in each agent by us (instance -> model), so a task only switches when it must.
  const models = new Map<string, string>();
  // Members already greeted this run (so an agent that stays silent is not nagged) and when we last tried.
  const introduced = new Set<string>();
  const introTried = new Map<string, number>();
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
  // Where a protocol prompt for this member goes. A member that works in its own sessions is never typed into at its
  // personal terminal: it is reached only through a live work session (its most recent one).
  const promptSurfaceOf = (state: ProjectState, memberId: string) => {
    if (!isolated(state, memberId)) return surfaceOf(state, memberId);
    const live = state.executions.filter((x) => x.status === "live" && x.memberId === memberId).at(-1);
    return live && surfaceForInstance(live.instanceId, host.surfaces());
  };
  // Where each help's answer goes: back to the work session that asked (and only there; if it is gone the answer waits),
  // or, for a request from the member's own terminal, the usual place.
  const helpTargets = (state: ProjectState, memberId: string, helps: Help[]) => {
    const out = new Map<Surf, Help[]>();
    const add = (surface: Surf | undefined, help: Help) => { if (surface) out.set(surface, [...(out.get(surface) ?? []), help]); };
    for (const help of helps) {
      const execution = help.executionId ? state.executions.find((x) => x.id === help.executionId && x.status === "live") : undefined;
      if (help.executionId) add(execution && surfaceForInstance(execution.instanceId, host.surfaces()), help);
      else add(promptSurfaceOf(state, memberId), help);
    }
    return out;
  };
  const taskSurface = (state: ProjectState, task: Task) => {
    if (!isolated(state, task.memberId)) return surfaceOf(state, task.memberId);
    const execution = executionOfTask(state, task);
    return execution && surfaceForInstance(execution.instanceId, host.surfaces());
  };
  const observedOf = (state: ProjectState, memberId: string) => {
    const surface = promptSurfaceOf(state, memberId);
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
      const iso = !!base && !!task && isolated(base.state, task.memberId);
      const surface = base && task && surfaceOf(base.state, task.memberId);
      if (!base?.state.config || !task || (!surface && !iso)) return { ok: false, reason: "offline" };
      if (iso) return handOverIsolated(root, task.id, how);
      if (!surface) return { ok: false, reason: "offline" };
      if (!how.auto) await refreshObserved([surface.id]);
      const model = modelFor(base.state, task);
      const instance = base.state.bindings[task.memberId]?.instanceId ?? "";
      // Claude takes `/model <name>` as a command; other agents only get the suggestion in the prompt.
      // Nothing is journaled yet, so a busy agent just means "try again later".
      if (model && instance && host.agentKind(surface.id) === "claude" && models.get(instance) !== model && !isHeld(holds, instance)) {
        const switched = await host.sendPrompt(surface.id, `/model ${model}`, async () => {}, { force: how.force });
        if (switched !== "sent") return { ok: false, reason: switched === "blocked" ? "agent-blocked" : switched === "busy" ? "agent-busy" : "offline" };
        models.set(instance, model);
      }
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

  // One task in its own work session: a fresh agent started from the member's launch spec, registered as the
  // attempt's execution before anything is typed, so its ctl calls resolve to this task and nothing else.
  // Before InputWillStart a failure just releases the task; after it the outcome is unknown and the session is kept.
  async function handOverIsolated(root: string, taskId: string, how: { auto?: boolean; force?: boolean }): Promise<DeliverOutcome> {
    const base = current(root);
    const task = base?.state.tasks.find((t) => t.id === taskId);
    const spec = task && base?.state.members.find((m) => m.id === task.memberId)?.launch;
    if (!base?.state.config || !task || !spec) return { ok: false, reason: "offline" };
    const before = verdict(base.state, task, contextFor(root, base.state, { force: how.force, ...(how.auto ? {} : { controlMode: "full" }) }));
    if (!before.ok) return before;
    const attemptId = crypto.randomUUID(), effectId = crypto.randomUUID(), executionId = crypto.randomUUID();
    let prepared;
    try {
      prepared = await dispatch(root, user, { type: "PrepareDispatch", taskId, attemptId, effectId });
    } catch (error) {
      await dispatch(root, user, { type: "RecordInputResult", taskId, attemptId, effectId, outcome: "not-sent" }).catch(() => {});
      throw error;
    }
    if (!prepared.ok) return prepared.error.code === "invalid_state" ? { ok: false, reason: "busy" } : Promise.reject(new Error(prepared.error.message));
    const state = prepared.value.state;
    const prompt = taskPrompt(state.config!.id, state.tasks.find((t) => t.id === taskId)!, state);
    let session: Surf | undefined;
    let registered = false;
    let started = false;
    const release = async () => {
      // Once input started the session may be working and must keep its identity to report; only a clean failure lets go of it.
      if (started) return;
      if (registered) await dispatch(root, user, { type: "EndExecution", executionId }).catch(() => {});
      if (session) await host.closeSurface(session.id).catch(() => {});
    };
    try {
      if (!prompt) throw new Error("task prompt could not be built");
      session = await host.startWorkSession(spec, modelFor(state, state.tasks.find((t) => t.id === taskId)!));
      const reg = await dispatch(root, user, { type: "RegisterExecution", executionId, memberId: task.memberId, taskId, attemptId, instanceId: instanceKey(session), generation: 1 });
      if (!reg.ok) throw new Error(reg.error.message);
      registered = true;
      const result = await host.sendPrompt(session.id, prompt, async () => {
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
      await release();
      return { ok: false, reason: result === "blocked" ? "agent-blocked" : result === "busy" ? "agent-busy" : "offline" };
    } catch (error) {
      await dispatch(root, user, { type: "RecordInputResult", taskId, attemptId, effectId, outcome: started ? "unknown" : "not-sent" }).catch(() => {});
      await release();
      throw error;
    }
  }
  // Work sessions whose task is over are closed; one that may still matter (a result to check, an open question,
  // an unsure delivery, a failure to read) stays until the person or the task settles it.
  // A live session whose terminal is gone (its tmux session did not survive, or someone killed it) for this long is
  // given up: its identity ends, so a later terminal with the same name cannot speak for the task. The task itself is
  // left alone: the silence warning and the person's check decide whether it failed or can be handed over again.
  const LOST_GRACE_MS = 120_000;
  const missingSince = new Map<string, number>();
  async function endFinished(root: string) {
    const project = current(root);
    if (!project) return;
    for (const execution of project.state.executions.filter((x) => x.status === "live")) {
      const task = project.state.tasks.find((t) => t.id === execution.taskId);
      if (!surfaceForInstance(execution.instanceId, host.surfaces())) {
        if (host.ready()) {
          const since = missingSince.get(execution.id) ?? Date.now();
          missingSince.set(execution.id, since);
          if (Date.now() - since > LOST_GRACE_MS) { missingSince.delete(execution.id); await dispatch(root, user, { type: "EndExecution", executionId: execution.id }); continue; }
        }
      } else missingSince.delete(execution.id);
      // A failed or declined task keeps its session (to read what happened) until it is retried or settled.
      const over = !task || task.attempt?.id !== execution.attemptId || ["completed", "cancelled", "queued"].includes(task.status);
      if (!over) continue;
      // Close first: if that fails the execution stays live and the next round tries again, instead of leaking a terminal nobody owns.
      const surface = surfaceForInstance(execution.instanceId, host.surfaces());
      if (surface) await host.closeSurface(surface.id);
      await dispatch(root, user, { type: "EndExecution", executionId: execution.id });
    }
  }

  // ---- coordinator messages and answers ----
  // The user is at that terminal, or agents may not use ctl yet: wait instead of typing into their draft
  // or into an agent that could not answer anyway.
  const mayType = (state: ProjectState, memberId: string) =>
    controlMode === "full" && (isolated(state, memberId) || !isHeld(holds, state.bindings[memberId]?.instanceId ?? ""));

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
  // Results and failures wake the coordinator, which then checks and accepts them; the user is not the relay.
  async function notices(root: string) {
    const project = current(root);
    if (!project?.state.config || project.readonlyReason) return;
    const coordinator = coordinatorOf(project.state);
    const surface = coordinator && surfaceOf(project.state, coordinator.id);
    const batch = queuedNotices(project.state);
    if (!coordinator || !surface || !batch.length || !mayType(project.state, coordinator.id)) return;
    await typeBatch(root, surface, noticePrompt(project.state.config.id, batch), batch.map((n) => n.id),
      (noticeId, delivery) => ({ type: "SetNoticeDelivery", noticeId, delivery }));
  }
  async function replies(root: string) {
    const project = current(root);
    if (!project?.state.config || project.readonlyReason) return;
    for (const { task, replies: group } of queuedReplies(project.state)) {
      const surface = taskSurface(project.state, task);
      if (!surface || !mayType(project.state, task.memberId)) continue;
      await typeBatch(root, surface, replyPrompt(project.state.config.id, task, group), group.map((r) => r.id),
        (replyId, delivery) => ({ type: "SetReplyDelivery", replyId, delivery }));
    }
  }
  // A worker's request for help reaches the coordinator; the coordinator's answer reaches the asker.
  async function helps(root: string) {
    const project = current(root);
    if (!project?.state.config || project.readonlyReason) return;
    const coordinator = coordinatorOf(project.state);
    const surface = coordinator && surfaceOf(project.state, coordinator.id);
    const batch = queuedHelps(project.state);
    if (coordinator && surface && batch.length && mayType(project.state, coordinator.id)) {
      await typeBatch(root, surface, helpPrompt(project.state.config.id, batch), batch.map((h) => h.id),
        (helpId, delivery) => ({ type: "SetHelpDelivery", helpId, part: "ask", delivery }));
    }
    for (const { memberId, helps: all } of queuedHelpAnswers(project.state)) {
      for (const [asker, group] of helpTargets(project.state, memberId, all)) {
        if (!mayType(project.state, memberId)) continue;
        await typeBatch(root, asker, helpAnswerPrompt(project.state.config.id, group), group.map((h) => h.id),
          (helpId, delivery) => ({ type: "SetHelpDelivery", helpId, part: "answer", delivery }));
      }
    }
    // The finished work goes back to whoever asked, not only to the coordinator and the user.
    for (const { memberId, helps: all } of queuedHelpResults(project.state)) {
      for (const [asker, group] of helpTargets(project.state, memberId, all)) {
        if (!mayType(project.state, memberId)) continue;
        await typeBatch(root, asker, helpResultPrompt(project.state.config.id, group), group.map((h) => h.id),
          (helpId, delivery) => ({ type: "SetHelpDelivery", helpId, part: "result", delivery }));
      }
    }
  }
  // Asking a member to say hello. Not journaled (it changes nothing), but it queues behind other
  // typing and respects the hold, so it cannot interleave with a task prompt or land in a draft.
  async function introNow(root: string, memberId: string): Promise<SendResult | "held" | "offline"> {
    const project = current(root);
    const member = project?.state.members.find((m) => m.id === memberId);
    const surface = project && surfaceOf(project.state, memberId);
    if (!project?.state.config || !member || !surface) return "offline";
    if (isHeld(holds, project.state.bindings[memberId]?.instanceId ?? "")) return "held";
    return host.sendPrompt(surface.id, introPrompt(project.state.config.id, project.state.config.name, member), async () => {});
  }
  const intro = (root: string, memberId: string) => exclusive(() => introNow(root, memberId));
  // Every online member that has not said hello gets the invitation once, as soon as its agent is idle;
  // the user does not have to press anything. Hello needs the full control mode, so wait for that too.
  async function greetAll(root: string) {
    const project = current(root);
    if (!project?.state.config || controlMode !== "full") return;
    for (const member of project.state.members) {
      const instance = project.state.bindings[member.id]?.instanceId;
      // A member that works in its own sessions is not asked to introduce itself in its personal terminal.
      if (!instance || isolated(project.state, member.id) || project.state.handshakes[member.id] || !surfaceOf(project.state, member.id)) continue;
      const key = `${root}|${member.id}|${instance}`;
      if (introduced.has(key) || Date.now() - (introTried.get(key) ?? 0) < 5000) continue;
      introTried.set(key, Date.now());
      if (await introNow(root, member.id) === "sent") introduced.add(key);
    }
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
        if (coordinator && (queuedBatch(state).length || queuedHelps(state).length || queuedNotices(state).length || state.replies.length)) interesting.add(coordinator.id);
        for (const help of state.helps) if (help.answer?.delivery === "queued") interesting.add(help.memberId);
        for (const id of interesting) { const surface = promptSurfaceOf(state, id); if (surface) wanted.add(surface.id); }
      }
      for (const instance of holds.keys()) { const surface = surfaceForInstance(instance, host.surfaces()); if (surface) wanted.add(surface.id); else holds.delete(instance); }
      await refreshObserved([...wanted]);
      const now = Date.now();
      for (const instance of [...holds.keys()]) {
        const surface = surfaceForInstance(instance, host.surfaces());
        tickHold(holds, instance, surface && seen.get(surface.id)?.state, now);
      }
      for (const { root } of projects) {
        await exclusive(async () => { await messages(root); await replies(root); await helps(root); await notices(root); await greetAll(root); await endFinished(root); });
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
        for (const help of state.helps) {
          if (help.delivery === "sending") await dispatch(root, user, { type: "SetHelpDelivery", helpId: help.id, part: "ask", delivery: "uncertain" });
          if (help.answer?.delivery === "sending") await dispatch(root, user, { type: "SetHelpDelivery", helpId: help.id, part: "answer", delivery: "uncertain" });
          if (help.resultDelivery === "sending") await dispatch(root, user, { type: "SetHelpDelivery", helpId: help.id, part: "result", delivery: "uncertain" });
        }
        for (const notice of state.notices.filter((n) => n.delivery === "sending")) {
          await dispatch(root, user, { type: "SetNoticeDelivery", noticeId: notice.id, delivery: "uncertain" });
        }
        for (const reply of state.replies.filter((r) => r.delivery === "sending")) {
          await dispatch(root, user, { type: "SetReplyDelivery", replyId: reply.id, delivery: "uncertain" });
        }
      }
    },
    intro,
    messages: (root: string) => exclusive(() => messages(root)),
    replies: (root: string) => exclusive(() => replies(root)),
    helps: (root: string) => exclusive(() => helps(root)),
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
