// Project area UI (S1): sidebar list, overview with members, and the coordinator conversation.
// Rules live in projects.ts / project-prompts.ts; the journal in project-store.ts. This module
// only owns DOM. The view covers the whole workspace like the files panel's full mode: the
// terminal NSViews are hidden by sending empty rects (main.ts treats isOpen() like "full").
import { t } from "./i18n";
import { applyI18n, onLocaleChange } from "./i18n-runtime";
import { INSTANCE_GENERATION, instanceKey, PROJECT_AGENT_KINDS, surfaceForInstance } from "./project-control";
import { introPrompt, memberStatus, type MemberStatus } from "./project-prompts";
import type { createDelivery } from "./project-delivery";
import { renderRun, type Attention, type RunActions } from "./project-run-view";
import { activeRun, blockedMembers, stalledTasks } from "./project-tasks";
import { memberActivity, ownedTerminals } from "./project-cards";
import type { LaunchResult } from "./project-launch";
import type { ActionBody } from "./project-types";
import { coordinatorOf, emptyState } from "./projects";
import { allLoaded, current, dispatch, indexList, onProjectChanged, openProject, type IndexItem, type Loaded } from "./project-store";
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
  // Saved favorites that qualify (coordinator + agent command) but have no open tab; they can be started from the picker.
  favoriteCandidates(): { id: string; name: string; cwd: string }[];
  // A member that belongs to a favorite can be opened from the project even when its terminal is closed.
  canOpenMember(instanceId: string): boolean;
  openMemberTerminal(instanceId: string): Promise<void>;
  openFavoriteInBackground(id: string): Promise<{ id: string; cwd: string; title: string; tmuxSession?: string }>;
  pickDirectory(): Promise<string | null>;
  // The launch spec an open member terminal would give for an independent work session (see project-launch.ts).
  launchFor(instanceId: string): LaunchResult;
  isActiveSurface(surface: string): boolean;
  // Opens the agent in a background terminal and resolves once it is ready; returns the surface id.
  startAgent(kind: AgentKind, cwd: string, tmux: boolean): Promise<string>;
  // Types a prompt into the agent when it is idle. `beforeInput` runs after the checks and
  // before any key is sent; if it throws nothing is typed.
  sendPrompt(surface: string, text: string, beforeInput: () => Promise<void>): Promise<SendResult>;
  showTerminal(surface: string): Promise<void>;
  // The shared hand-over machinery (pump, buttons, messages); the panel only asks it things.
  delivery: ReturnType<typeof createDelivery>;
  layoutChanged(): void;
  openSettings(): void;
  // Only the main window starts coordinators on its own, and only once the saved tabs are back.
  isMain(): boolean;
  ready(): boolean;
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
  let renaming: string | undefined;
  let items: IndexItem[] = [];
  // The member whose detail is open (a small card until clicked).
  let expanded: string | undefined;
  // The discussion is folded by default; opening it marks what is there as read.
  let chatOpen = false;
  let chatSeen = 0;
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
  // The list is redrawn only when what it shows changed: terminals open and close, the active one moves, states change.
  let listShown = "";
  function listSignature() {
    return JSON.stringify([isOpen() && mode === "project" ? root : "", items, items.map((item) => ownedTerminals(current(item.root)?.state ?? emptyState()).map((o) => {
      const surface = o.instanceId ? surfaceForInstance(o.instanceId, host.surfaces()) : undefined;
      const state = current(item.root)?.state;
      return [o.kind, o.label, o.instanceId, !!surface, !!surface && host.isActiveSurface(surface.id), o.kind === "work" ? o.title : "", state && memberActivity(state, o.memberId).activity];
    }))]);
  }
  function renderListIfChanged() {
    if (listSignature() !== listShown) renderList();
  }
  function renderList() {
    listShown = listSignature();
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
      listSection.append(...ownedRows(item.root));
    }
  }
  // The project's own terminals under its row: the coordinator, then work sessions that are running.
  function ownedRows(projectRoot: string): HTMLElement[] {
    const state = current(projectRoot)?.state;
    if (!state?.config) return [];
    return ownedTerminals(state).map((owned) => {
      const surface = owned.instanceId ? surfaceForInstance(owned.instanceId, host.surfaces()) : undefined;
      const row = el("div", "project-row project-owned" + (surface && host.isActiveSurface(surface.id) ? " selected" : ""));
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      const activity = owned.kind === "work" ? memberActivity(state, owned.memberId) : undefined;
      row.append(el("span", "project-row-name", owned.kind === "coordinator" ? t("project.coordinator") : owned.label));
      row.append(el("span", "project-row-state", owned.kind === "work" ? (owned.title ?? "") : surface ? "" : t("project.status.offline")));
      if (activity && (activity.activity === "needs-input" || activity.activity === "uncertain")) row.append(el("span", "project-badge", "!"));
      const go = () => guard(surface ? host.showTerminal(surface.id) : owned.kind === "coordinator" ? launchCoordinator(owned.memberId, projectRoot) : Promise.resolve());
      row.onclick = go;
      row.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); } };
      return row;
    });
  }
  async function forget(item: IndexItem) {
    await invoke("project_index_remove", { root: item.root });
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
    renaming = undefined;
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
  async function launchCoordinator(memberId: string, projectRoot = root) {
    const loadedProject = projectRoot ? current(projectRoot) : undefined;
    const member = loadedProject?.state.members.find((m) => m.id === memberId);
    if (!projectRoot || !member?.launch) return;
    const cwd = member.launch.cwd.kind === "absolute" ? member.launch.cwd.path : projectRoot;
    const surface = await host.startAgent(member.launch.kind, cwd, member.launch.tmux);
    const info = host.surfaces().find((s) => s.id === surface);
    if (!info) return;
    const bound = await dispatch(projectRoot, user, { type: "BindMember", memberId, instanceId: instanceKey(info), generation: INSTANCE_GENERATION });
    if (!bound.ok) throw new Error(bound.error.message);
    // The delivery pump greets every member that has not said hello, so there is nothing to press.
  }
  // The coordinator is always on: a loaded project whose coordinator terminal is not open gets it started,
  // once per run (closing it afterwards is respected until the next launch).
  const autoStarted = new Set<string>();
  let ensuring = false;
  async function ensureCoordinators() {
    if (ensuring || !host.isMain() || !host.ready()) return;
    ensuring = true;
    try {
      for (const project of allLoaded()) {
        const config = project.state.config;
        if (!config || project.readonlyReason || autoStarted.has(project.root)) continue;
        autoStarted.add(project.root);
        const member = project.state.members.find((m) => m.id === config.coordinatorMemberId);
        const binding = member && project.state.bindings[member.id];
        if (!member?.launch || (binding && surfaceForInstance(binding.instanceId, host.surfaces()))) continue;
        await launchCoordinator(member.id, project.root).catch(host.notify);
      }
    } finally { ensuring = false; }
  }
  async function sendIntro(memberId: string) {
    if (!root) return;
    const result = await host.delivery.intro(root, memberId);
    if (result === "sent") introSent.add(memberId);
    else host.notify(t(result === "blocked" ? "project.agentBlocked" : result === "busy" ? "project.agentBusy" : result === "held" ? "project.task.wait.held" : "project.notOnline"));
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
  const attention = (): Attention => {
    const state = stateNow();
    if (!state || !root) return { blocked: [], stalled: [], held: [] };
    return {
      blocked: blockedMembers(state, (id) => host.delivery.observedOf(root!, id)),
      stalled: stalledTasks(state, Date.now()),
      held: host.delivery.heldMembers(root),
    };
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
  async function startRun(auto: boolean) {
    const state = stateNow();
    const plan = state?.plans.at(-1);
    if (!plan) return;
    await must({
      type: "StartRun", runId: crypto.randomUUID(), planId: plan.id, version: plan.version, taskIds: plan.steps.map(() => crypto.randomUUID()), auto,
      consent: { id: crypto.randomUUID(), source: "start-button" },
    });
  }
  // A person's own button: the shared machinery journals first and checks the agent is ready; if it
  // is not, nothing is typed and the reason is shown.
  async function handOver(taskId: string, force: boolean) {
    if (!root) return;
    const outcome = await host.delivery.handOver(root, taskId, { force });
    if (!outcome.ok) host.notify(t(`project.task.wait.${outcome.reason}`));
  }
  const runActions: RunActions = {
    start: (auto) => void act(() => startRun(auto)),
    pause: () => void act(async () => { const run = stateNow() && activeRun(stateNow()!); if (run) await must({ type: "PauseRun", runId: run.id }); }),
    resume: () => void act(async () => { const run = stateNow() && activeRun(stateNow()!); if (run) await must({ type: "ResumeRun", runId: run.id }); }),
    deliver: (taskId) => void act(() => handOver(taskId, false)),
    deliverNow: (taskId) => void act(() => handOver(taskId, true)),
    giveBack: (memberId) => { if (root) host.delivery.giveBack(root, memberId); renderIfChanged(); },
    why: (taskId) => (root ? host.delivery.whyNot(root, taskId) : undefined),
    setAuto: (auto) => void act(async () => { const run = stateNow() && activeRun(stateNow()!); if (run) await must({ type: "SetRunAuto", runId: run.id, auto }); }),
    closeRun: () => void act(async () => { const run = stateNow() && activeRun(stateNow()!); if (run) await must({ type: "CloseRun", runId: run.id }); }),
    confirmObserved: (taskId) => void act(async () => {
      const task = stateNow()?.tasks.find((x) => x.id === taskId);
      if (task?.attempt) await must({ type: "ConfirmObservedResult", taskId, attemptId: task.attempt.id });
    }),
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
    reply: (issueId, text) => void act(async () => { await must({ type: "ReplyIssue", issueId, replyId: crypto.randomUUID(), text }); await host.delivery.replies(root!); }),
    goTerminal: (memberId) => { const surface = surfaceOfMember(memberId); if (surface) guard(host.showTerminal(surface.id)); },
    online: (memberId) => !!surfaceOfMember(memberId),
    pending: () => inFlight > 0,
  };
  // ---- conversation ----
  async function send(text: string) {
    if (!root) return;
    const done = await dispatch(root, user, { type: "SendMessage", messageId: crypto.randomUUID(), conversationId: "main", text });
    if (!done.ok) throw new Error(done.error.message);
    host.delivery.messages(root).catch(host.notify);
  }
  // ---- rendering ----
  const statusText = (status: MemberStatus) => t(`project.status.${status}`);
  // Re-render only when what is on screen would differ, so typing in a picker or the
  // draft is not disturbed by the periodic status check.
  let shown = "";
  function signature() {
    const project = loaded();
    const live = host.surfaces().map((x) => instanceKey(x)).sort();
    return JSON.stringify([mode, picking, expanded, chatOpen, chatOpen ? 0 : chatSeen, project?.state, project?.readonlyReason, mode === "create" ? [] : live, mode === "create" ? [] : host.candidates().map((x) => instanceKey(x)).sort(), introSent.size, mode === "create" ? [] : host.favoriteCandidates().map((x) => `${x.id}|${x.name}|${x.cwd}`), controlMode, inFlight, JSON.stringify(attention())]);
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
    head.append(renderTitle(state.config!.name), el("code", "project-path", project.root));
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
  // The name can be edited in place; Enter or the save button commits, Escape cancels.
  function renderTitle(name: string) {
    const row = el("div", "project-title-row");
    if (renaming === undefined) {
      const edit = el("button", "ghost-btn", t("project.rename"));
      edit.onclick = () => { renaming = name; render(); };
      row.append(el("h2", undefined, name), edit);
      return row;
    }
    const input = el("input");
    input.value = renaming;
    input.setAttribute("aria-label", t("project.renameLabel"));
    input.oninput = () => { renaming = input.value; };
    const save = el("button", "primary-btn", t("project.renameSave"));
    const commit = () => { const next = input.value.trim(); if (next && next !== name) guard(renameProject(next)); else { renaming = undefined; render(); } };
    save.onclick = commit;
    input.onkeydown = (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); commit(); }
      if (event.key === "Escape") { renaming = undefined; render(); }
    };
    const cancel = el("button", "ghost-btn", t("project.renameCancel"));
    cancel.onclick = () => { renaming = undefined; render(); };
    row.append(input, save, cancel);
    queueMicrotask(() => input.focus());
    return row;
  }
  async function renameProject(name: string) {
    if (!root) return;
    await must({ type: "RenameProject", name });
    renaming = undefined;
    const config = stateNow()?.config;
    if (config) await invoke("project_index_touch", { root, name: config.name, projectId: config.id, openedAt: new Date().toISOString() });
    await refreshList();
    render();
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
    const open = expanded === member.id;
    const work = memberActivity(state, member.id);
    const card = el("article", `project-card status-${status} activity-${work.activity}${open ? " open" : ""}`);
    // The small card: name, role, one line of state. Clicking it opens the detail (purpose, model, connection, actions).
    const summary = el("button", "project-card-summary");
    summary.type = "button";
    summary.setAttribute("aria-expanded", String(open));
    const stateText = work.activity === "idle" ? statusText(status) : t(`project.activity.${work.activity}`);
    summary.append(
      el("strong", undefined, member.name),
      el("span", "project-badge", t(member.role === "coordinator" ? "project.role.coordinator" : "project.role.worker")),
      el("span", "project-status", `${work.activity === "needs-input" || work.activity === "uncertain" ? "! " : ""}${stateText}`),
    );
    if (work.title) summary.append(el("span", "project-card-line", work.title));
    summary.onclick = () => { expanded = open ? undefined : member.id; if (open && picking?.memberId === member.id) picking = undefined; render(); };
    card.append(summary);
    if (!open) return card;
    card.append(el("p", "project-purpose", member.purpose || t("project.noPurpose")));
    const handshake = state.handshakes[member.id];
    if (handshake?.reportNeedsApproval) card.append(el("p", "project-warning", t("project.needsApproval")));
    // The model this agent normally uses; the coordinator may pick another per task.
    if (member.role === "worker") {
      const model = el("input", "mono");
      model.value = member.model ?? "";
      model.placeholder = t("project.modelPlaceholder");
      model.setAttribute("aria-label", t("project.model"));
      model.onchange = () => guard(must({ type: "SetMemberModel", memberId: member.id, model: model.value }).then(() => undefined));
      card.append(el("label", "help", t("project.model")), model);
    }
    // Run each task in its own fresh session instead of typing into this member's personal terminal.
    if (member.role === "worker") {
      const toggle = el("input");
      toggle.type = "checkbox";
      toggle.checked = !!member.launch;
      toggle.disabled = inFlight > 0;
      toggle.onchange = () => guard(setWorkSession(member.id, toggle.checked).finally(() => { toggle.checked = !!stateNow()?.members.find((m) => m.id === member.id)?.launch; }));
      const label = el("label", "toggle");
      label.append(toggle, el("span", undefined, t("project.work.label")));
      card.append(label, el("div", "help", member.launch ? t("project.work.on", { cwd: member.launch.cwd.path }) : t("project.work.help")));
    }
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
    else if (!surface && binding && host.canOpenMember(binding.instanceId)) button(t("project.openTerminal"), () => host.openMemberTerminal(binding.instanceId));
    button(t("project.rebind"), () => { picking = picking?.memberId === member.id ? undefined : { memberId: member.id }; render(); });
    if (member.role === "worker") button(t("project.removeMember"), () => removeMember(member.id));
    card.append(actions);
    if (picking?.memberId === member.id) card.append(renderPicker(state, member.id));
    return card;
  }
  async function setWorkSession(memberId: string, on: boolean) {
    if (!on) { await must({ type: "SetMemberLaunch", memberId, launch: null }); return; }
    const binding = stateNow()?.bindings[memberId];
    const result = binding ? host.launchFor(binding.instanceId) : ({ ok: false, reason: "offline" } as const);
    if (!result.ok) { host.notify(t(`project.work.fail.${result.reason}`)); return; }
    await must({ type: "SetMemberLaunch", memberId, launch: result.spec });
    if (result.dropped.length) host.notify(t("project.work.dropped", { flags: result.dropped.join(" ") }));
  }
  function renderPicker(state: ProjectState, memberId?: string) {
    const taken = new Set(Object.values(state.bindings).map((b) => b.instanceId));
    const box = el("div", "project-picker");
    const candidates = host.candidates().filter((s) => !taken.has(instanceKey(s)));
    const favorites = host.favoriteCandidates();
    box.append(el("div", "help", t(candidates.length || favorites.length ? "project.pickHint" : "project.pickNone")), el("div", "help", t("project.pickRule")));
    for (const favorite of favorites) {
      const row = el("div", "project-pick-row");
      row.append(el("span", undefined, `${favorite.name} — ${favorite.cwd} ${t("project.favoriteNotOpen")}`));
      const choose = el("button", "ghost-btn", t("project.startAndChoose"));
      choose.onclick = () => guard(host.openFavoriteInBackground(favorite.id).then((surface) => memberId ? rebind(memberId, surface) : addMember(surface, favorite.name, "")));
      row.append(choose);
      box.append(row);
    }
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
    const aside = el("aside", "project-chat" + (chatOpen ? "" : " folded"));
    // Messages from the coordinator and help traffic that arrived since the discussion was last open.
    const total = state.messages.length + state.helps.length;
    const unread = chatOpen ? 0 : Math.max(0, total - chatSeen);
    const toggle = el("button", "project-chat-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(chatOpen));
    toggle.append(el("h3", undefined, t("project.discussion")));
    if (unread) toggle.append(el("span", "project-badge", t("project.unread", { n: unread })));
    toggle.onclick = () => { chatOpen = !chatOpen; if (chatOpen) chatSeen = total; render(); };
    aside.append(toggle);
    if (!chatOpen) return aside;
    chatSeen = total;
    const log = el("div", "project-log");
    for (const message of state.messages) {
      const row = el("div", `project-msg from-${message.author}`);
      row.append(el("div", "project-msg-meta", `${t(message.author === "user" ? "project.you" : "project.coordinator")}${message.author === "user" ? ` · ${t(`project.delivery.${message.delivery}`)}` : ""}`), el("div", "project-msg-text", message.text));
      log.append(row);
    }
    for (const help of state.helps) {
      const asker = state.members.find((m) => m.id === help.memberId)?.name ?? "";
      const row = el("div", "project-msg from-member");
      row.append(el("div", "project-msg-meta", `${t("project.helpFrom", { name: asker })} · ${t(help.answer ? "project.helpAnswered" : "project.helpWaiting")}`), el("div", "project-msg-text", help.text));
      if (help.answer) row.append(el("div", "project-msg-meta", t("project.helpAnswer")), el("div", "project-msg-text", help.answer.text));
      log.append(row);
    }
    if (!state.messages.length && !state.helps.length) log.append(el("div", "help", t("project.noMessages")));
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
    renderListIfChanged();
    if (changed !== root) return;
    renderIfChanged();
  });
  onLocaleChange(() => { renderList(); if (isOpen()) render(); });
  // Messages wait for an idle coordinator; check now and then.
  setInterval(() => { pollMode().catch(() => {}); renderIfChanged(); renderListIfChanged(); ensureCoordinators().catch(() => {}); }, 3000);
  pollMode().catch(() => {});
  refreshList().catch(host.notify);
  listen("project-index-changed", () => { refreshList().catch(() => {}); }).catch(() => {});

  return {
    isOpen,
    close() { setOpen(false); renderList(); },
    // Re-render the member cards (their terminals may have opened or closed).
    refresh: renderIfChanged,
    // The sidebar rows of each project's own terminals (call when terminals open, close or the active one changes).
    refreshList: renderListIfChanged,
  };
}
