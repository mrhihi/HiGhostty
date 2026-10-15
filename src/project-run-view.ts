// Plan, run and task cards for the project view. DOM only: the rules are in project-tasks.ts and
// every button just calls back into the panel, which dispatches the action. Drafts (rework
// feedback, answers) live in a map owned by the panel so a re-render does not lose them.
import { t } from "./i18n";
import { activeRun, DEFAULT_STALL_MS, queueReasonOf, startBlockers, stepOf } from "./project-tasks";
import type { Artifact, ProjectState, Task } from "./project-types";

export type RunActions = {
  start(): void;
  pause(): void;
  resume(): void;
  deliver(taskId: string): void;
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

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// Things that need a person right now; derived from live observation and time, not stored.
export type Attention = { blocked: { memberId: string; taskIds: string[] }[]; stalled: Task[] };

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

  if (attention.blocked.length || attention.stalled.length) {
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
  const steps = el("ol", "project-steps");
  for (const step of plan.steps) {
    const item = el("li");
    item.append(el("span", undefined, `${step.title} — ${memberName(step.memberId)}`));
    if (step.dependsOn.length) item.append(el("span", "project-status", ` ${t("project.plan.after", { steps: step.dependsOn.join(", ") })}`));
    item.append(el("div", "help", t("project.plan.completion", { items: step.completion.join("；") })));
    steps.append(item);
  }
  summary.append(steps);
  section.append(summary);

  const controls = el("div", "project-card-actions");
  const button = (label: string, run: () => void, primary = false, disabled = false) => {
    const b = el("button", primary ? "primary-btn" : "ghost-btn", label);
    b.disabled = disabled || actions.pending();
    b.onclick = run;
    return b;
  };
  if (!run || run.status === "completed" && run.planVersion !== plan.version) {
    const blockers = startBlockers(state, plan);
    if (blockers.length) {
      const list = el("ul", "project-warning");
      for (const blocker of blockers) list.append(el("li", undefined, blocker.kind === "coordinator-hello" ? t("project.plan.blockHello") : t("project.plan.blockUnbound", { name: blocker.memberName })));
      section.append(list);
    }
    controls.append(button(t("project.plan.start"), actions.start, true, blockers.length > 0));
  } else if (run.status === "running") {
    controls.append(button(t("project.run.pause"), actions.pause));
  } else if (run.status === "paused") {
    controls.append(el("span", "project-badge", t("project.run.paused")), button(t("project.run.resume"), actions.resume, true));
  } else {
    controls.append(el("span", "project-badge", t("project.run.completed")));
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
    details.append(el("summary", undefined, `${artifact.name} (${artifact.mediaType})`));
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
      const reason = queueReasonOf(state, task);
      if (task.reworkFeedback) card.append(el("p", "project-purpose", t("project.task.reworkNote", { feedback: task.reworkFeedback })));
      if (reason) card.append(el("p", "project-purpose", t(`project.task.wait.${reason}`)));
      const online = actions.online(task.memberId);
      if (!reason && !online) card.append(el("p", "project-purpose", t("project.task.wait.offline")));
      button(t("project.task.deliver"), () => actions.deliver(task.id), true, !!reason || !online);
      button(t("project.task.cancel"), () => actions.cancel(task.id));
      break;
    }
    case "dispatching":
    case "sent":
    case "accepted":
    case "running":
      if (lastReport?.summary) card.append(el("p", "project-purpose", lastReport.summary));
      card.append(el("p", "project-purpose", t("project.task.inProgress")));
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
