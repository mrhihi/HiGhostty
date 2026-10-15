// Project items inside the attention drop (docs/project-collaboration-v2-plan.md §5.3). DOM only: the
// rules are in project-attention.ts and project-tasks.ts; every button calls back into the host, which
// dispatches the action. Cards reuse the terminal alert-card look so keyboard navigation works on both
// (Enter clicks [data-act=go], Backspace clicks [data-act=dismiss]).
import { t } from "./i18n";
import type { ActionItem } from "./project-attention";
import type { ProjectState } from "./project-types";

export type ProjectItem = { root: string; projectName: string; state: ProjectState; item: ActionItem };

export type ProjectCardActions = {
  startPlan(root: string, item: ActionItem): void;
  reply(root: string, issueId: string, text: string): void;
  accept(root: string, item: ActionItem): void;
  rework(root: string, item: ActionItem, feedback: string): void;
  reconcile(root: string, item: ActionItem, decision: "not-received" | "running" | "failed"): void;
  goTerminal(item: ActionItem): void;
  // Quiet the badge only; the item stays until its source resolves.
  markSeen(item: ActionItem): void;
  // Hide it for a while (badge and banner); the card stays in the list.
  snooze(item: ActionItem): void;
  online(item: ActionItem): boolean;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// What the card shows, so the host can skip a rebuild (and keep the user's typing) when nothing changed.
export const cardSignature = (p: ProjectItem) => JSON.stringify([p.root, p.item.id, p.item.sourceId, p.item.summary, p.projectName]);

export function renderProjectCard(p: ProjectItem, actions: ProjectCardActions, drafts: Map<string, string>): HTMLElement {
  const { item, state, root } = p;
  const memberName = state.members.find((m) => m.id === item.memberId)?.name ?? item.memberId ?? "";
  const card = el("div", "alert-card");
  card.dataset.source = "project";
  card.dataset.key = item.id;
  const head = el("div", "alert-head");
  head.append(el("strong", undefined, p.projectName), el("span", "alert-meta", t(`project.drop.kind.${item.kind}`)));
  card.append(head);

  const actionsRow = el("div", "alert-actions");
  const button = (label: string, run: () => void, attr?: string, primary = false) => {
    const b = el("button", primary ? "primary-btn" : "ghost-btn", label);
    if (attr) b.dataset.act = attr;
    b.onclick = run;
    actionsRow.append(b);
  };
  const draft = (key: string, placeholder: string) => {
    const input = el("textarea");
    input.rows = 2;
    input.placeholder = placeholder;
    input.value = drafts.get(key) ?? "";
    input.oninput = () => drafts.set(key, input.value);
    // Typing must not trigger the drop's Enter/Backspace shortcuts.
    input.addEventListener("keydown", (event) => event.stopPropagation());
    return input;
  };
  const task = state.tasks.find((x) => x.id === item.taskId);

  switch (item.kind) {
    case "start-plan": {
      const plan = state.plans.at(-1);
      card.append(el("pre", "alert-ask", `${item.summary}${plan ? `\n${plan.objective}` : ""}`));
      button(t("project.plan.start"), () => actions.startPlan(root, item), "go", true);
      break;
    }
    case "question": {
      card.append(el("pre", "alert-ask", t("project.drop.askedBy", { name: memberName, text: item.summary })));
      const field = draft(`reply:${item.sourceId}`, t("project.task.replyPlaceholder"));
      card.append(field);
      button(t("project.task.reply"), () => { const text = field.value.trim(); if (!text) return; actions.reply(root, item.sourceId, text); drafts.delete(`reply:${item.sourceId}`); }, "go", true);
      break;
    }
    case "review-result": {
      card.append(el("pre", "alert-ask", `${item.summary} — ${memberName}`));
      for (const artifact of state.artifacts.filter((a) => task?.resultArtifactIds.includes(a.id))) {
        const details = el("details", "alert-fold");
        details.append(el("summary", undefined, artifact.name));
        // textContent only: a worker's output is data, never markup.
        details.append(el("pre", "alert-body", artifact.text));
        card.append(details);
      }
      const field = draft(`rework:${item.id}`, t("project.task.reworkPlaceholder"));
      card.append(field);
      button(t("project.task.accept"), () => actions.accept(root, item), "go", true);
      button(t("project.task.rework"), () => { actions.rework(root, item, field.value); drafts.delete(`rework:${item.id}`); });
      break;
    }
    case "uncertain":
      card.append(el("pre", "alert-ask", t("project.drop.uncertain", { name: memberName, title: item.summary })));
      button(t("project.task.notReceived"), () => actions.reconcile(root, item, "not-received"));
      button(t("project.task.stillRunning"), () => actions.reconcile(root, item, "running"));
      button(t("project.task.markFailed"), () => actions.reconcile(root, item, "failed"));
      break;
    case "terminal-blocked":
      card.append(el("pre", "alert-ask", t("project.attention.blocked", { name: memberName })));
      break;
  }
  if (item.memberId && actions.online(item)) button(t("project.goTerminal"), () => actions.goTerminal(item), item.kind === "terminal-blocked" ? "go" : undefined);
  button(t("project.snooze"), () => actions.snooze(item));
  button(t("app.dismiss"), () => actions.markSeen(item), "dismiss");
  card.append(actionsRow);
  return card;
}
