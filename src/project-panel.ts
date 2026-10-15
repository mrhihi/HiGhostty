// Project area UI (S1): sidebar list, overview with members, and the coordinator conversation.
// Rules live in projects.ts / project-prompts.ts; the journal in project-store.ts. This module
// only owns DOM. The view covers the whole workspace like the files panel's full mode: the
// terminal NSViews are hidden by sending empty rects (main.ts treats isOpen() like "full").
import { t } from "./i18n";
import { applyI18n, onLocaleChange } from "./i18n-runtime";
import { INSTANCE_GENERATION, instanceKey, PROJECT_AGENT_KINDS, surfaceForInstance } from "./project-control";
import { introPrompt, memberStatus, messagePrompt, queuedBatch, queuedReplies, replyPrompt, taskPrompt, type MemberStatus } from "./project-prompts";
import { renderRun, type Attention, type RunActions } from "./project-run-view";
import { activeRun, blockedMembers, stalledTasks, type Observed } from "./project-tasks";
import type { ActionBody } from "./project-types";
import { coordinatorOf } from "./projects";
import { current, dispatch, indexList, onProjectChanged, openProject, type IndexItem, type Loaded } from "./project-store";
import type { AgentKind, Member, ProjectState } from "./project-types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type SendResult = "sent" | "busy" | "blocked" | "gone";
export type ProjectHost = {
  notify(error: unknown): void;
  // Open terminals in this window; the picker and member status read them.
  surfaces(): { id: string; cwd: string; title: string; tmuxSession?: string }[];
  // The subset that can be added as members (see memberCandidates).
  candidates(): { id: string; cwd: string; title: string; tmuxSession?: string }[];
  pickDirectory(): Promise<string | null>;
  // Opens the agent in a background terminal and resolves once it is ready; returns the surface id.
  startAgent(kind: AgentKind, cwd: string, tmux: boolean): Promise<string>;
  // Types a prompt into the agent when it is idle. `beforeInput` runs after the checks and
  // before any key is sent; if it throws nothing is typed.
  sendPrompt(surface: string, text: string, beforeInput: () => Promise<void>): Promise<SendResult>;
  showTerminal(surface: string): Promise<void>;
  // What the agents in these terminals are doing right now (read from the screen).
  observe(surfaceIds: string[]): Promise<Record<string, Observed>>;
  layoutChanged(): void;
  openSettings(): void;
};

const user = { kind: "user" } as const;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const nameOf = (path: string) => path.split("/").filter(Boolean).pop() || path;

export function initProjectPanel(host: ProjectHost) {
  const workspace = document.getElementById("workspace")!;
  const listSection = el("section", "project-list-block");
  listSection.id = "project-list";
  document.getElementById("tabs")!.before(listSection);
  const view = el("section");
  view.id = "project-view";
  view.hidden = true;
  document.getElementById("files")!.after(view);

  let root: string | undefined;
  let mode: "project" | "create" = "project";
  let items: IndexItem[] = [];
  let picking: { memberId?: string } | undefined;
  let busy = false;
  const introSent = new Set<string>();
  // hello/message need the global "full" control mode; the view says so instead of letting agents hit `forbidden`.
  let controlMode = "";
  async function pollMode() {
    const mode = await invoke<string>("control_mode").catch(() => controlMode);
    if (mode !== controlMode) { controlMode = mode; renderIfChanged(); }
  }

  const isOpen = () => !view.hidden;
  function setOpen(open: boolean) {
    if (view.hidden === !open) return;
    view.hidden = !open;
    workspace.classList.toggle("project-open", open);
    host.layoutChanged();
  }
  const loaded = (): Loaded | undefined => (root ? current(root) : undefined);
  const guard = (task: Promise<unknown>) => task.catch(host.notify);

  function online(instance: string) {
    return !!surfaceForInstance(instance, host.surfaces());
  }

  // ---- sidebar list ----
  async function refreshList() {
    items = await indexList().catch(() => []);
    renderList();
  }
  function renderList() {
    listSection.replaceChildren();
    const heading = el("div", "caption");
    heading.append(el("span", undefined, t("project.title")));
    const add = el("button", "icon-btn", "+");
    add.title = t("project.new");
    add.setAttribute("aria-label", t("project.new"));
    add.onclick = () => showCreate();
    const open = el("button", "icon-btn", "…");
    open.title = t("project.openExisting");
    open.setAttribute("aria-label", t("project.openExisting"));
    open.onclick = () => guard(openExisting());
    heading.append(open, add);
    listSection.append(heading);
    if (!items.length) listSection.append(el("div", "help", t("project.none")));
    for (const item of items) {
      const row = el("div", "project-row" + (isOpen() && mode === "project" && item.root === root ? " selected" : ""));
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.title = item.root;
      row.append(el("span", "project-row-name", item.name || nameOf(item.root)));
      if (!item.exists) row.append(el("span", "project-row-missing", t("project.missing")));
      const remove = el("button", "icon-btn project-row-remove", "×");
      remove.title = t("project.forget");
      remove.setAttribute("aria-label", t("project.forget"));
      remove.onclick = (event) => { event.stopPropagation(); guard(forget(item)); };
      row.append(remove);
      const go = () => guard(showProject(item.root));
      row.onclick = go;
      row.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); } };
      listSection.append(row);
    }
  }
  async function forget(item: IndexItem) {
    await invoke("project_index_remove", { root: item.root });
    await invoke("project_close", { root: item.root }).catch(() => {});
    if (root === item.root) { root = undefined; setOpen(false); }
    await refreshList();
  }

  // ---- open / create ----
  async function openExisting() {
    const path = await host.pickDirectory();
    if (path) await showProject(path);
  }
  async function showProject(path: string) {
    const project = await openProject(path);
    root = project.root;
    mode = "project";
    picking = undefined;
    const config = project.state.config;
    if (config) {
      await invoke("project_index_touch", { root, name: config.name, projectId: config.id, openedAt: new Date().toISOString() });
    }
    await refreshList();
    setOpen(true);
    render();
  }
  function showCreate() {
    mode = "create";
    setOpen(true);
    render();
    renderList();
  }
  async function create(form: { name: string; path: string; kind: AgentKind; tmux: boolean; gitExclude: boolean }) {
    const projectId = crypto.randomUUID();
    const coordinator: Member = {
      id: crypto.randomUUID(), role: "coordinator", name: t("project.coordinator"), purpose: "", purposeSource: "user", reportMode: "protocol",
      launch: { kind: form.kind, cwd: { kind: "project-relative", path: "." }, args: [], tmux: form.tmux },
    };
    const project = await openProject(form.path, true, form.gitExclude);
    if (project.state.config) throw new Error(t("project.alreadyProject"));
    const made = await dispatch(project.root, user, {
      type: "CreateProject",
      config: { schemaVersion: 1, id: projectId, name: form.name, coordinatorMemberId: coordinator.id, createdAt: new Date().toISOString() },
      coordinator,
    });
    if (!made.ok) throw new Error(made.error.message);
    await showProject(project.root);
    await launchCoordinator(coordinator.id);
  }

  // ---- members ----
  async function launchCoordinator(memberId: string) {
    const loadedProject = loaded();
    const member = loadedProject?.state.members.find((m) => m.id === memberId);
    if (!root || !member?.launch) return;
    const cwd = member.launch.cwd.kind === "absolute" ? member.launch.cwd.path : root;
    const surface = await host.startAgent(member.launch.kind, cwd, member.launch.tmux);
    const info = host.surfaces().find((s) => s.id === surface);
    if (!info) return;
    const bound = await dispatch(root, user, { type: "BindMember", memberId, instanceId: instanceKey(info), generation: INSTANCE_GENERATION });
    if (!bound.ok) throw new Error(bound.error.message);
    await sendIntro(memberId);
  }
  async function sendIntro(memberId: string) {
    const project = loaded();
    const member = project?.state.members.find((m) => m.id === memberId);
    const binding = project?.state.bindings[memberId];
    if (!root || !project?.state.config || !member || !binding) return;
    const surface = surfaceForInstance(binding.instanceId, host.surfaces());
    if (!surface) return host.notify(t("project.notOnline"));
    const result = await host.sendPrompt(surface.id, introPrompt(project.state.config.id, project.state.config.name, member), async () => {});
    if (result === "sent") introSent.add(memberId);
    else host.notify(t(result === "blocked" ? "project.agentBlocked" : result === "busy" ? "project.agentBusy" : "project.notOnline"));
  }
  async function addMember(candidate: { id: string; tmuxSession?: string; title: string; cwd: string }, name: string, purpose: string) {
    if (!root) return;
    const member: Member = { id: crypto.randomUUID(), role: "worker", name: name.trim() || candidate.title || nameOf(candidate.cwd), purpose: purpose.trim(), purposeSource: "user", reportMode: "screen" };
    const done = await dispatch(root, user, { type: "AddMember", member, binding: { instanceId: instanceKey(candidate), generation: INSTANCE_GENERATION } });
    if (!done.ok) throw new Error(done.error.message);
    picking = undefined;
    render();
  }
  async function rebind(memberId: string, candidate: { id: string; tmuxSession?: string }) {
    if (!root) return;
    const done = await dispatch(root, user, { type: "BindMember", memberId, instanceId: instanceKey(candidate), generation: INSTANCE_GENERATION });
    if (!done.ok) throw new Error(done.error.message);
    picking = undefined;
    render();
  }
  async function removeMember(memberId: string) {
    if (!root) return;
    const done = await dispatch(root, user, { type: "RemoveMember", memberId });
    if (!done.ok) throw new Error(done.error.message);
  }

  // ---- plan, run and tasks (S2: every delivery is a button press) ----
  const drafts = new Map<string, string>();
  let inFlight = 0;
  const observed = new Map<string, Observed>();
  // Screens are read only while the view is open and some worker holds a task in progress.
  async function pollObserved() {
    const state = stateNow();
    if (!isOpen() || mode !== "project" || !state) return;
    const wanted = state.members.filter((m) => state.tasks.some((x) => x.memberId === m.id && ["dispatching", "sent", "accepted", "running", "needs-input", "uncertain"].includes(x.status)));
    const surfaces = new Map<string, string>();
    for (const member of wanted) { const surface = surfaceOfMember(member.id); if (surface) surfaces.set(member.id, surface.id); }
    const seen = surfaces.size ? await host.observe([...surfaces.values()]) : {};
    observed.clear();
    for (const [memberId, surfaceId] of surfaces) if (seen[surfaceId]) observed.set(memberId, seen[surfaceId]);
    renderIfChanged();
  }
  const attention = (): Attention => {
    const state = stateNow();
    return state ? { blocked: blockedMembers(state, (id) => observed.get(id)), stalled: stalledTasks(state, Date.now()) } : { blocked: [], stalled: [] };
  };
  async function act(task: () => Promise<unknown>) {
    inFlight++;
    renderIfChanged();
    try { await task(); } catch (error) { host.notify(error); } finally { inFlight--; renderIfChanged(); }
  }
  async function must(body: ActionBody, actionId?: string) {
    if (!root) throw new Error(t("project.notOpen"));
    const done = await dispatch(root, user, body, actionId);
    if (!done.ok) throw new Error(done.error.message);
    return done.value;
  }
  const stateNow = () => loaded()?.state;
  const surfaceOfMember = (memberId: string) => {
    const binding = stateNow()?.bindings[memberId];
    return binding && surfaceForInstance(binding.instanceId, host.surfaces());
  };
  async function startRun() {
    const state = stateNow();
    const plan = state?.plans.at(-1);
    if (!plan) return;
    await must({
      type: "StartRun", runId: crypto.randomUUID(), planId: plan.id, version: plan.version, taskIds: plan.steps.map(() => crypto.randomUUID()),
      consent: { id: crypto.randomUUID(), source: "start-button" },
    });
  }
  // Typing into the worker comes after PrepareDispatch and InputWillStart are in the journal; if the
  // checks fail nothing is typed and the task goes back to the queue.
  async function deliverTask(taskId: string) {
    const first = stateNow();
    const before = first?.tasks.find((x) => x.id === taskId);
    const surface = before && surfaceOfMember(before.memberId);
    if (!first?.config || !before || !surface) return host.notify(t("project.notOnline"));
    const attemptId = crypto.randomUUID(), effectId = crypto.randomUUID();
    await must({ type: "PrepareDispatch", taskId, attemptId, effectId });
    const state = stateNow()!;
    const task = state.tasks.find((x) => x.id === taskId)!;
    const prompt = taskPrompt(first.config.id, task, state);
    let started = false;
    try {
      if (!prompt) throw new Error(t("project.task.noPrompt"));
      const result = await host.sendPrompt(surface.id, prompt, async () => {
        await must({ type: "RecordInputStart", taskId, attemptId, effectId });
        started = true;
      });
      if (result === "sent") await must({ type: "RecordInputResult", taskId, attemptId, effectId, outcome: "sent" });
      else {
        await must({ type: "RecordInputResult", taskId, attemptId, effectId, outcome: "not-sent" });
        host.notify(t(result === "blocked" ? "project.agentBlocked" : result === "busy" ? "project.agentBusy" : "project.notOnline"));
      }
    } catch (error) {
      await dispatch(root!, user, { type: "RecordInputResult", taskId, attemptId, effectId, outcome: started ? "unknown" : "not-sent" }).catch(() => {});
      throw error;
    }
  }
  const runActions: RunActions = {
    start: () => void act(startRun),
    pause: () => void act(async () => { const run = stateNow() && activeRun(stateNow()!); if (run) await must({ type: "PauseRun", runId: run.id }); }),
    resume: () => void act(async () => { const run = stateNow() && activeRun(stateNow()!); if (run) await must({ type: "ResumeRun", runId: run.id }); }),
    deliver: (taskId) => void act(() => deliverTask(taskId)),
    accept: (taskId) => void act(async () => {
      const task = stateNow()?.tasks.find((x) => x.id === taskId);
      if (task?.attempt) await must({ type: "AcceptResult", taskId, attemptId: task.attempt.id });
    }),
    rework: (taskId, feedback) => void act(async () => {
      const task = stateNow()?.tasks.find((x) => x.id === taskId);
      if (task?.attempt) await must({ type: "RequestRework", taskId, attemptId: task.attempt.id, feedback });
    }),
    cancel: (taskId) => void act(() => must({ type: "RequestCancel", taskId })),
    retry: (taskId) => void act(() => must({ type: "RetryTask", taskId })),
    reconcile: (taskId, decision) => void act(async () => {
      const task = stateNow()?.tasks.find((x) => x.id === taskId);
      if (task?.attempt) await must({ type: "ReconcileTask", taskId, attemptId: task.attempt.id, decision });
    }),
    reply: (issueId, text) => void act(async () => { await must({ type: "ReplyIssue", issueId, replyId: crypto.randomUUID(), text }); await deliverReplies(); }),
    goTerminal: (memberId) => { const surface = surfaceOfMember(memberId); if (surface) guard(host.showTerminal(surface.id)); },
    online: (memberId) => !!surfaceOfMember(memberId),
    pending: () => inFlight > 0,
  };
  // Answers to a worker's question are typed into its terminal like a task: journal first, idle only.
  async function deliverReplies() {
    const project = loaded();
    if (!root || delivering || !project?.state.config || project.readonlyReason) return;
    delivering = true;
    const at = root;
    try {
      for (const { task, replies } of queuedReplies(project.state)) {
        const surface = surfaceOfMember(task.memberId);
        if (!surface) continue;
        try {
          const result = await host.sendPrompt(surface.id, replyPrompt(project.state.config.id, task, replies), async () => {
            for (const reply of replies) await must({ type: "SetReplyDelivery", replyId: reply.id, delivery: "sending" });
          });
          if (result === "sent") for (const reply of replies) await dispatch(at, user, { type: "SetReplyDelivery", replyId: reply.id, delivery: "sent" });
        } catch (error) {
          for (const reply of replies) await dispatch(at, user, { type: "SetReplyDelivery", replyId: reply.id, delivery: "uncertain" }).catch(() => {});
          host.notify(error);
        }
      }
    } finally {
      delivering = false;
    }
  }

  // ---- conversation ----
  async function send(text: string) {
    if (!root) return;
    const done = await dispatch(root, user, { type: "SendMessage", messageId: crypto.randomUUID(), conversationId: "main", text });
    if (!done.ok) throw new Error(done.error.message);
    await deliver();
  }
  // Sends waiting user messages to the coordinator, only from the window that has its terminal.
  // The journal records `sending` before any key is typed; after that a retry is never automatic.
  let delivering = false;
  async function deliver() {
    const project = loaded();
    if (!root || delivering || !project?.state.config || project.readonlyReason) return;
    const coordinator = coordinatorOf(project.state);
    const binding = coordinator && project.state.bindings[coordinator.id];
    const surface = binding && surfaceForInstance(binding.instanceId, host.surfaces());
    const batch = queuedBatch(project.state);
    if (!surface || !batch.length) return;
    delivering = true;
    const at = root;
    try {
      const prompt = messagePrompt(project.state.config.id, batch);
      const result = await host.sendPrompt(surface.id, prompt, async () => {
        for (const message of batch) {
          const marked = await dispatch(at, user, { type: "SetMessageDelivery", messageId: message.id, delivery: "sending" });
          if (!marked.ok) throw new Error(marked.error.message);
        }
      });
      if (result === "sent") {
        for (const message of batch) await dispatch(at, user, { type: "SetMessageDelivery", messageId: message.id, delivery: "sent" });
      }
    } catch (error) {
      // Typing may or may not have happened after "sending"; never resend on our own.
      for (const message of batch) await dispatch(at, user, { type: "SetMessageDelivery", messageId: message.id, delivery: "uncertain" }).catch(() => {});
      host.notify(error);
    } finally {
      delivering = false;
    }
  }

  // ---- rendering ----
  const statusText = (status: MemberStatus) => t(`project.status.${status}`);
  // Re-render only when what is on screen would differ, so typing in a picker or the
  // draft is not disturbed by the periodic status check.
  let shown = "";
  function signature() {
    const project = loaded();
    const live = host.surfaces().map((x) => instanceKey(x)).sort();
    return JSON.stringify([mode, picking, project?.state, project?.readonlyReason, mode === "create" ? [] : live, introSent.size, controlMode, inFlight, JSON.stringify(attention())]);
  }
  function renderIfChanged() {
    if (isOpen() && signature() !== shown) render();
  }
  function render() {
    shown = signature();
    const hadFocus = document.activeElement === draft;
    view.replaceChildren();
    try { paint(); } finally { if (hadFocus) draft.focus(); }
  }
  function paint() {
    if (mode === "create") return renderCreate();
    const project = loaded();
    if (!project?.state.config) return;
    const state = project.state;
    const main = el("div", "project-main");
    const head = el("div", "project-head");
    head.append(el("h2", undefined, state.config!.name), el("code", "project-path", project.root));
    main.append(head);
    if (project.readonlyReason) main.append(el("div", "project-warning", t("project.readonly", { reason: project.readonlyReason })));
    if (controlMode && controlMode !== "full") {
      const notice = el("div", "project-warning");
      notice.append(el("span", undefined, t(controlMode === "off" ? "project.needFullOff" : "project.needFull")));
      const open = el("button", "ghost-btn", t("project.openSettings"));
      open.onclick = () => host.openSettings();
      notice.append(" ", open);
      main.append(notice);
    }
    main.append(renderMembers(state), renderRun(state, runActions, drafts, attention()));
    view.append(main, renderConversation(state));
    applyI18n(view);
  }
  function renderMembers(state: ProjectState) {
    const section = el("section", "project-members");
    const heading = el("div", "project-section-head");
    heading.append(el("h3", undefined, t("project.members")));
    const add = el("button", "ghost-btn", t("project.addMember"));
    add.onclick = () => { picking = picking && !picking.memberId ? undefined : {}; render(); };
    heading.append(add);
    section.append(heading);
    if (picking && !picking.memberId) section.append(renderPicker(state));
    for (const member of state.members) section.append(renderCard(state, member));
    return section;
  }
  function renderCard(state: ProjectState, member: Member) {
    const status = memberStatus(state, member.id, online);
    const card = el("article", `project-card status-${status}`);
    const title = el("div", "project-card-title");
    title.append(el("strong", undefined, member.name), el("span", "project-badge", t(member.role === "coordinator" ? "project.role.coordinator" : "project.role.worker")), el("span", "project-status", statusText(status)));
    card.append(title);
    card.append(el("p", "project-purpose", member.purpose || t("project.noPurpose")));
    const handshake = state.handshakes[member.id];
    if (handshake?.reportNeedsApproval) card.append(el("p", "project-warning", t("project.needsApproval")));
    const actions = el("div", "project-card-actions");
    const binding = state.bindings[member.id];
    const surface = binding && surfaceForInstance(binding.instanceId, host.surfaces());
    const button = (label: string, run: () => Promise<unknown> | unknown) => {
      const b = el("button", "ghost-btn", label);
      b.onclick = () => guard(Promise.resolve().then(run));
      actions.append(b);
    };
    if (surface) button(t("project.goTerminal"), () => host.showTerminal(surface.id));
    if (surface && status === "waiting-hello") button(t(introSent.has(member.id) ? "project.introAgain" : "project.intro"), () => sendIntro(member.id));
    if (!surface && member.launch) button(t("project.relaunch"), () => launchCoordinator(member.id));
    button(t("project.rebind"), () => { picking = picking?.memberId === member.id ? undefined : { memberId: member.id }; render(); });
    if (member.role === "worker") button(t("project.removeMember"), () => removeMember(member.id));
    card.append(actions);
    if (picking?.memberId === member.id) card.append(renderPicker(state, member.id));
    return card;
  }
  function renderPicker(state: ProjectState, memberId?: string) {
    const taken = new Set(Object.values(state.bindings).map((b) => b.instanceId));
    const box = el("div", "project-picker");
    const candidates = host.candidates().filter((s) => !taken.has(instanceKey(s)));
    box.append(el("div", "help", t(candidates.length ? "project.pickHint" : "project.pickNone")), el("div", "help", t("project.pickRule")));
    for (const surface of candidates) {
      const row = el("div", "project-pick-row");
      row.append(el("span", undefined, `${surface.title || nameOf(surface.cwd)} — ${surface.cwd}${surface.tmuxSession ? " (tmux)" : ""}`));
      if (memberId) {
        const choose = el("button", "ghost-btn", t("project.choose"));
        choose.onclick = () => guard(rebind(memberId, surface));
        row.append(choose);
      } else {
        const name = el("input");
        name.placeholder = t("project.memberName");
        name.value = surface.title || nameOf(surface.cwd);
        const purpose = el("input");
        purpose.placeholder = t("project.purposePlaceholder");
        const choose = el("button", "ghost-btn", t("project.addThis"));
        choose.onclick = () => guard(addMember(surface, name.value, purpose.value));
        row.append(name, purpose, choose);
      }
      box.append(row);
    }
    return box;
  }
  // The conversation keeps its textarea across re-renders so a half-typed message survives.
  const draft = el("textarea", "project-draft");
  draft.rows = 3;
  const sendButton = el("button", "primary-btn", t("project.send"));
  sendButton.onclick = () => {
    const text = draft.value.trim();
    if (!text || busy) return;
    busy = true;
    sendButton.disabled = true;
    guard(send(text).then(() => { draft.value = ""; })).finally(() => { busy = false; sendButton.disabled = false; });
  };
  draft.onkeydown = (event) => {
    // Enter while composing (IME) picks a candidate; it must not send.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); sendButton.click(); }
  };
  function renderConversation(state: ProjectState) {
    const aside = el("aside", "project-chat");
    aside.append(el("h3", undefined, t("project.discussion")));
    const log = el("div", "project-log");
    for (const message of state.messages) {
      const row = el("div", `project-msg from-${message.author}`);
      row.append(el("div", "project-msg-meta", `${t(message.author === "user" ? "project.you" : "project.coordinator")}${message.author === "user" ? ` · ${t(`project.delivery.${message.delivery}`)}` : ""}`), el("div", "project-msg-text", message.text));
      log.append(row);
    }
    if (!state.messages.length) log.append(el("div", "help", t("project.noMessages")));
    aside.append(log, draft, el("div", "help", t("project.sendHint")), sendButton);
    queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
    return aside;
  }
  function renderCreate() {
    const form = el("form", "project-create");
    form.append(el("h2", undefined, t("project.new")));
    const field = (label: string, control: HTMLElement) => {
      const row = el("label", "project-field");
      row.append(el("span", undefined, label), control);
      form.append(row);
    };
    const name = el("input");
    name.required = true;
    field(t("project.name"), name);
    let path = "";
    const pathText = el("code", "project-path", t("project.noFolder"));
    const choose = el("button", "ghost-btn", t("project.chooseFolder"));
    choose.type = "button";
    choose.onclick = () => guard(host.pickDirectory().then((picked) => {
      if (!picked) return;
      path = picked;
      pathText.textContent = picked;
      if (!name.value.trim()) name.value = nameOf(picked);
    }));
    const pathRow = el("div", "project-field");
    pathRow.append(el("span", undefined, t("project.folder")), pathText, choose);
    form.append(pathRow);
    const kind = el("select");
    for (const k of PROJECT_AGENT_KINDS) kind.append(Object.assign(el("option", undefined, k), { value: k }));
    field(t("project.coordinatorKind"), kind);
    form.append(el("div", "help", t("project.coordinatorTmux")));
    const git = el("input");
    git.type = "checkbox";
    git.checked = true;
    const gitRow = el("label", "toggle");
    gitRow.append(git, el("span", undefined, t("project.gitExclude")));
    form.append(gitRow);
    const actions = el("div", "project-card-actions");
    const submit = el("button", "primary-btn", t("project.create"));
    submit.type = "submit";
    const cancel = el("button", "ghost-btn", t("app.cancel"));
    cancel.type = "button";
    cancel.onclick = () => { mode = "project"; if (loaded()) render(); else setOpen(false); renderList(); };
    actions.append(submit, cancel);
    form.append(actions);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (!path || !name.value.trim() || busy) return host.notify(t("project.needFolder"));
      busy = true;
      submit.disabled = true;
      guard(create({ name: name.value.trim(), path, kind: kind.value as AgentKind, tmux: true, gitExclude: git.checked }))
        .finally(() => { busy = false; submit.disabled = false; });
    };
    view.append(form);
    applyI18n(view);
  }

  onProjectChanged((changed) => {
    if (changed !== root) return;
    renderIfChanged();
    guard(deliver().then(deliverReplies));
  });
  onLocaleChange(() => { renderList(); if (isOpen()) render(); });
  // Messages wait for an idle coordinator; check now and then.
  setInterval(() => { if (isOpen() && mode === "project") guard(deliver().then(deliverReplies)); }, 2000);
  setInterval(() => { pollMode().catch(() => {}); pollObserved().catch(() => {}); renderIfChanged(); }, 3000);
  pollMode().catch(() => {});
  refreshList().catch(host.notify);
  listen("project-index-changed", () => { refreshList().catch(() => {}); }).catch(() => {});

  return {
    isOpen,
    close() { setOpen(false); renderList(); },
    // Re-render the member cards (their terminals may have opened or closed).
    refresh: renderIfChanged,
  };
}
