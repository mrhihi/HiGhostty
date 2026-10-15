// Plan, run and task cards for the project view. DOM only: the rules are in project-tasks.ts and
// every button just calls back into the panel, which dispatches the action. Drafts (rework
// feedback, answers) live in a map owned by the panel so a re-render does not lose them.
import { t } from "./i18n";
import { runProgress } from "./project-cards";
import { activeRun, DEFAULT_STALL_MS, queueReasonOf, startBlockers, stepOf } from "./project-tasks";
import type { SkipReason } from "./project-schedule";
import type { Artifact, ProjectState, Task } from "./project-types";

export type RunActions = {
  start(auto: boolean): void;
  pause(): void;
  resume(): void;
  deliver(taskId: string): void;
  // Hand over even though the agent looks busy or is being held (never into a question or a screen with no agent).
  deliverNow(taskId: string): void;
  giveBack(memberId: string): void;
  why(taskId: string): SkipReason | undefined;
  setAuto(auto: boolean): void;
  closeRun(): void;
  confirmObserved(taskId: string): void;
  accept(taskId: string): void;
  rework(taskId: string, feedback: string): void;
  cancel(taskId: string): void;
  retry(taskId: string): void;
  reconcile(taskId: string, decision: "not-received" | "running" | "failed"): void;
  reply(issueId: string, text: string): void;
  goTerminal(memberId: string): void;
  online(memberId: string): boolean;
  // True while an action is in flight; buttons are disabled so it is not sent twice.
  pending(): boolean;
};

// Which plans the user opened; the view is rebuilt on every change and must not fold them back.
const expandedPlans = new Set<string>();
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// Things that need a person right now; derived from live observation and time, not stored.
export type Attention = { blocked: { memberId: string; taskIds: string[] }[]; stalled: Task[]; held: { memberId: string; waiting: number }[] };

export function renderRun(state: ProjectState, actions: RunActions, drafts: Map<string, string>, attention: Attention): HTMLElement {
  const section = el("section", "project-run");
  const head = el("div", "project-section-head");
  head.append(el("h3", undefined, t("project.plan.title")));
  section.append(head);
  const plan = state.plans.at(-1);
  if (!plan) {
    section.append(el("div", "help", t("project.plan.none")));
    return section;
  }
  const run = activeRun(state) ?? state.runs.at(-1);
  const memberName = (id: string) => state.members.find((m) => m.id === id)?.name ?? id;
  const stepTitle = (task: Task) => stepOf(state, task)?.title ?? task.stepKey;

  if (attention.blocked.length || attention.stalled.length || attention.held.length) {
    const box = el("div", "project-warning project-attention");
    box.append(el("strong", undefined, t("project.attention.title")));
    for (const item of attention.blocked) {
      const row = el("div", "project-attention-row");
      row.append(el("span", undefined, t("project.attention.blocked", { name: memberName(item.memberId) })));
      const go = el("button", "ghost-btn", t("project.goTerminal"));
      go.onclick = () => actions.goTerminal(item.memberId);
      row.append(go);
      box.append(row);
    }
    for (const item of attention.held) {
      const row = el("div", "project-attention-row");
      row.append(el("span", undefined, t("project.attention.held", { name: memberName(item.memberId), n: item.waiting })));
      const back = el("button", "ghost-btn", t("project.attention.giveBack"));
      back.onclick = () => actions.giveBack(item.memberId);
      row.append(back);
      box.append(row);
    }
    for (const task of attention.stalled) {
      const row = el("div", "project-attention-row");
      row.append(el("span", undefined, t("project.attention.stalled", { name: memberName(task.memberId), task: stepTitle(task), minutes: Math.round(DEFAULT_STALL_MS / 60_000) })));
      const go = el("button", "ghost-btn", t("project.goTerminal"));
      go.onclick = () => actions.goTerminal(task.memberId);
      const lost = el("button", "ghost-btn", t("project.task.notReceived"));
      lost.disabled = actions.pending();
      lost.onclick = () => actions.reconcile(task.id, "not-received");
      const failed = el("button", "ghost-btn", t("project.task.markFailed"));
      failed.disabled = actions.pending();
      failed.onclick = () => actions.reconcile(task.id, "failed");
      row.append(go, lost, failed);
      box.append(row);
    }
    section.append(box);
  }

  const summary = el("div", "project-plan");
  summary.append(el("strong", undefined, `${plan.title} · v${plan.version}`), el("p", "project-purpose", plan.objective));
  // Progress of the latest run at a glance; the steps and their conditions open on demand.
  const progress = runProgress(state);
  if (progress && progress.total) summary.append(el("p", "project-status", t("project.plan.progress", { done: progress.done, total: progress.total })));
  const steps = el("ol", "project-steps");
  for (const step of plan.steps) {
    const item = el("li");
    item.append(el("span", undefined, `${step.title} — ${memberName(step.memberId)}`));
    if (step.dependsOn.length) item.append(el("span", "project-status", ` ${t("project.plan.after", { steps: step.dependsOn.join(", ") })}`));
    item.append(el("div", "help", t("project.plan.completion", { items: step.completion.join("；") })));
    steps.append(item);
  }
  const detail = el("details", "project-plan-steps");
  detail.open = expandedPlans.has(plan.id);
  detail.addEventListener("toggle", () => { if (detail.open) expandedPlans.add(plan.id); else expandedPlans.delete(plan.id); });
  detail.append(el("summary", undefined, t("project.plan.steps", { n: plan.steps.length })), steps);
  summary.append(detail);
  section.append(summary);

  const controls = el("div", "project-card-actions");
  const button = (label: string, run: () => void, primary = false, disabled = false) => {
    const b = el("button", primary ? "primary-btn" : "ghost-btn", label);
    b.disabled = disabled || actions.pending();
    b.onclick = run;
    return b;
  };
  if (!run || ((run.status === "completed" || run.status === "closed") && run.planVersion !== plan.version)) {
    const blockers = startBlockers(state, plan);
    if (blockers.length) {
      const list = el("ul", "project-warning");
      for (const blocker of blockers) list.append(el("li", undefined, blocker.kind === "coordinator-hello" ? t("project.plan.blockHello") : t("project.plan.blockUnbound", { name: blocker.memberName })));
      section.append(list);
    }
    const auto = el("input");
    auto.type = "checkbox";
    auto.checked = true;
    const autoLabel = el("label", "toggle");
    autoLabel.append(auto, el("span", undefined, t("project.run.auto")));
    controls.append(autoLabel, button(t("project.plan.start"), () => actions.start(auto.checked), true, blockers.length > 0));
    section.append(el("div", "help", t("project.run.autoHelp")));
  } else if (run.status === "running" || run.status === "paused") {
    const auto = el("input");
    auto.type = "checkbox";
    auto.checked = run.auto;
    auto.disabled = actions.pending();
    auto.onchange = () => actions.setAuto(auto.checked);
    const autoLabel = el("label", "toggle");
    autoLabel.append(auto, el("span", undefined, t("project.run.auto")));
    controls.append(autoLabel);
    if (run.status === "running") controls.append(button(t("project.run.pause"), actions.pause));
    else controls.append(el("span", "project-badge", t("project.run.paused")), button(t("project.run.resume"), actions.resume, true));
    controls.append(button(t("project.run.close"), actions.closeRun));
  } else {
    controls.append(el("span", "project-badge", t(run.status === "closed" ? "project.run.closed" : "project.run.completed")));
  }
  section.append(controls);

  if (run) {
    const tasks = el("div", "project-tasks");
    for (const task of state.tasks.filter((x) => x.runId === run.id)) tasks.append(renderTask(state, task, actions, drafts, memberName));
    section.append(tasks);
  }
  return section;
}

function artifactDetails(artifacts: Artifact[]): HTMLElement {
  const box = el("div", "project-artifacts");
  for (const artifact of artifacts) {
    const details = el("details");
    details.append(el("summary", undefined, `${artifact.name} (${artifact.mediaType})${artifact.source === "screen" ? ` · ${t("project.task.fromScreen")}` : ""}`));
    // textContent only: a worker's output is data, never markup.
    const pre = el("pre", "project-artifact");
    pre.textContent = artifact.text;
    details.append(pre);
    box.append(details);
  }
  return box;
}

function renderTask(state: ProjectState, task: Task, actions: RunActions, drafts: Map<string, string>, memberName: (id: string) => string): HTMLElement {
  const step = stepOf(state, task);
  const card = el("article", `project-card task-${task.status}`);
  const title = el("div", "project-card-title");
  title.append(el("strong", undefined, step?.title ?? task.stepKey), el("span", "project-badge", memberName(task.memberId)), el("span", "project-status", t(`project.task.status.${task.status}`)));
  card.append(title);
  if (task.cancelRequested) card.append(el("p", "project-warning", t("project.task.cancelRequested")));
  const actionsRow = el("div", "project-card-actions");
  const button = (label: string, run: () => void, primary = false, disabled = false) => {
    const b = el("button", primary ? "primary-btn" : "ghost-btn", label);
    b.disabled = disabled || actions.pending();
    b.onclick = run;
    actionsRow.append(b);
  };
  const draftField = (key: string, placeholder: string) => {
    const input = el("textarea");
    input.rows = 2;
    input.placeholder = placeholder;
    input.value = drafts.get(key) ?? "";
    input.oninput = () => drafts.set(key, input.value);
    return input;
  };
  const results = state.artifacts.filter((a) => task.resultArtifactIds.includes(a.id));
  const lastReport = [...state.reports].reverse().find((r) => r.taskId === task.id && !r.stale);

  switch (task.status) {
    case "queued": {
      if (task.reworkFeedback) card.append(el("p", "project-purpose", t("project.task.reworkNote", { feedback: task.reworkFeedback })));
      const reason = actions.why(task.id);
      if (reason) card.append(el("p", "project-purpose", t(`project.task.wait.${reason}`)));
      // A person's click is not held back by the agents-only control mode, but it does wait for an idle agent.
      const soft: SkipReason[] = ["control-mode", "stale-observation"];
      const forceable: SkipReason[] = ["agent-busy", "held", "stale-observation"];
      button(t("project.task.deliver"), () => actions.deliver(task.id), true, !(reason === undefined || soft.includes(reason)));
      if (reason && forceable.includes(reason)) button(t("project.task.deliverNow"), () => actions.deliverNow(task.id));
      button(t("project.task.cancel"), () => actions.cancel(task.id));
      break;
    }
    case "dispatching":
    case "sent":
    case "accepted":
    case "running":
    case "waiting-help":
      if (lastReport?.summary) card.append(el("p", "project-purpose", lastReport.summary));
      card.append(el("p", "project-purpose", t("project.task.inProgress")));
      if (task.observed) {
        card.append(el("p", "project-warning", t("project.task.observed", { summary: task.observed.summary })));
        card.append(artifactDetails(state.artifacts.filter((a) => task.observed!.artifactIds.includes(a.id))));
        button(t("project.task.confirmObserved"), () => actions.confirmObserved(task.id), true);
      }
      if (!task.cancelRequested) button(t("project.task.cancel"), () => actions.cancel(task.id));
      break;
    case "needs-input": {
      const issue = state.issues.find((i) => i.taskId === task.id && i.kind === "question" && !i.resolvedAt);
      if (issue) {
        card.append(el("p", "project-warning", t("project.task.question", { text: issue.text })));
        const pending = state.replies.filter((r) => r.issueId === issue.id);
        for (const reply of pending) card.append(el("p", "project-purpose", t("project.task.replySent", { text: reply.text, state: t(`project.delivery.${reply.delivery}`) })));
        const field = draftField(`reply:${issue.id}`, t("project.task.replyPlaceholder"));
        card.append(field);
        button(t("project.task.reply"), () => { actions.reply(issue.id, field.value); drafts.delete(`reply:${issue.id}`); }, true);
      }
      if (!task.cancelRequested) button(t("project.task.cancel"), () => actions.cancel(task.id));
      break;
    }
    case "uncertain":
      card.append(el("p", "project-warning", t("project.task.uncertain")));
      button(t("project.task.notReceived"), () => actions.reconcile(task.id, "not-received"));
      button(t("project.task.stillRunning"), () => actions.reconcile(task.id, "running"));
      button(t("project.task.markFailed"), () => actions.reconcile(task.id, "failed"));
      break;
    case "result-ready": {
      if (lastReport?.summary) card.append(el("p", "project-purpose", lastReport.summary));
      if (task.cancelRequested) card.append(el("p", "project-warning", t("project.task.resultBeforeCancel")));
      card.append(artifactDetails(results));
      const field = draftField(`rework:${task.id}`, t("project.task.reworkPlaceholder"));
      card.append(field);
      button(t("project.task.accept"), () => actions.accept(task.id), true);
      button(t("project.task.rework"), () => { actions.rework(task.id, field.value); drafts.delete(`rework:${task.id}`); });
      break;
    }
    case "completed":
      if (lastReport?.summary) card.append(el("p", "project-purpose", lastReport.summary));
      card.append(artifactDetails(results));
      break;
    case "declined":
    case "failed":
    case "cancelled":
      if (lastReport?.summary) card.append(el("p", "project-purpose", lastReport.summary));
      button(t("project.task.retry"), () => actions.retry(task.id));
      break;
  }
  if (task.attempt && actions.online(task.memberId)) button(t("project.goTerminal"), () => actions.goTerminal(task.memberId));
  card.append(actionsRow);
  const stale = state.reports.filter((r) => r.taskId === task.id && r.stale);
  if (stale.length) card.append(el("p", "help", t("project.task.staleReports", { n: stale.length })));
  return card;
}
