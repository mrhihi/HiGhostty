// `highostty ctl project …` against the journal. The caller's own window answers (any window
// can read and write a project), so the caller is resolved here to a member by its terminal.
import { pledgeInstruction } from "./project-prompts";
import { errReply, okReply, type Reply } from "./control";
import {
  acceptBody, callerMember, executionGuard, helpAnswerBody, helpAskBody, helpGetResult, observedBody, getResult, helloBody, inboxResult, INSTANCE_GENERATION, instanceKey, messageBody, notMemberReply, parseInput,
  planSubmitBody, projectErrorReply, reworkBody, runStartBody, taskGetResult, taskReportBody, taskResultResult,
} from "./project-control";
import { activeRun } from "./project-tasks";
import { dispatch, openProject, rootFor, type StoreError } from "./project-store";
import type { Actor } from "./project-types";

type Call = { op: string; args: Record<string, string>; flags: Record<string, unknown>; input: unknown; surface?: { id: string; tmuxSession?: string } };

function storeReply(error: StoreError): Reply {
  switch (error.code) {
    case "revision_conflict":
    case "storage_readonly": return errReply(error.code, error.message);
    case "failed": return errReply("failed", error.message);
    default: return projectErrorReply(error);
  }
}

export async function runProjectControl({ op, args, flags, input, surface }: Call): Promise<Reply> {
  const root = await rootFor(args.projectId);
  if (!root) return errReply("project_unavailable", `找不到專案 ${args.projectId}；請先在 HiGhostty 的專案區建立或開啟它`);
  const project = await openProject(root).catch((error) => String(error));
  if (typeof project === "string") return errReply("project_unavailable", project);
  const member = callerMember(project.state, surface && instanceKey(surface));
  const actor: Actor | undefined = member ? { kind: "member", memberId: member.id } : undefined;

  switch (op) {
    case "project get":
      return okReply(getResult(project.state, project.revision));
    case "project inbox":
      if (!member) return notMemberReply();
      return okReply(inboxResult(project.state, member.id, flags.after));
    case "project hello": {
      if (!actor) return notMemberReply();
      const body = parseInput(input, flags);
      if (!body.ok) return body.reply;
      const hello = helloBody(body.value);
      if (!hello.ok) return hello.reply;
      const done = await dispatch(root, actor, hello.body);
      // A worker is reminded right after hello, when it is most likely to take the rule in.
      return done.ok ? okReply({ member: member!.id, revision: done.value.revision, handshake: true, ...(member!.role === "worker" ? { say: pledgeInstruction } : {}) }) : storeReply(done.error);
    }
    case "project message": {
      if (!actor) return notMemberReply();
      const body = parseInput(input, flags);
      if (!body.ok) return body.reply;
      const message = messageBody(body.value, () => crypto.randomUUID());
      if (!message.ok || message.body.type !== "CoordinatorMessage") return message.ok ? errReply("failed", "內部錯誤") : message.reply;
      // The messageId doubles as the actionId, so an agent resending the same message is a no-op.
      const done = await dispatch(root, actor, message.body, `message:${message.body.messageId}`);
      return done.ok ? okReply({ messageId: message.body.messageId, revision: done.value.revision }) : storeReply(done.error);
    }
    case "project help ask":
    case "project help answer": {
      if (!actor) return notMemberReply();
      const asking = op === "project help ask";
      if (asking !== (member!.role === "worker")) return errReply("forbidden", asking ? "只有 worker 能求助；coordinator 請直接指派任務" : "只有 coordinator 能回覆求助");
      const input2 = parseInput(input, flags);
      if (!input2.ok) return input2.reply;
      const built = asking ? helpAskBody(input2.value, () => crypto.randomUUID()) : helpAnswerBody(input2.value);
      if (!built.ok) return built.reply;
      const done = await dispatch(root, actor, built.body, built.actionId);
      return done.ok ? okReply({ helpId: (built.body as { helpId: string }).helpId, revision: done.value.revision }) : storeReply(done.error);
    }
    case "project help get":
      if (!member) return notMemberReply();
      return helpGetResult(project.state, member, args.helpId);
    case "project plan submit":
    case "project run start":
    case "project run pause":
    case "project task result":
    case "project task accept":
    case "project task rework":
    case "project task observed": {
      if (!actor) return notMemberReply();
      if (member!.role !== "coordinator") return errReply("forbidden", "只有 coordinator 能使用這個指令");
      if (op === "project task result") return taskResultResult(project.state, args.taskId);
      if (op === "project run pause") {
        const run = activeRun(project.state);
        if (!run) return errReply("not_found", "目前沒有進行中的 run");
        if (run.status === "paused") return okReply({ runId: run.id, status: "paused" });
        const paused = await dispatch(root, actor, { type: "PauseRun", runId: run.id });
        return paused.ok ? okReply({ runId: run.id, status: "paused", revision: paused.value.revision }) : storeReply(paused.error);
      }
      const input2 = parseInput(input, flags);
      if (!input2.ok) return input2.reply;
      const built = op === "project plan submit" ? planSubmitBody(input2.value, () => crypto.randomUUID())
        : op === "project run start" ? runStartBody(project.state, input2.value, () => crypto.randomUUID())
        : op === "project task accept" ? acceptBody(args.taskId, input2.value)
        : op === "project task observed" ? observedBody(args.taskId, input2.value) : reworkBody(args.taskId, input2.value);
      if (!built.ok) return built.reply;
      const done = await dispatch(root, actor, built.body, built.actionId);
      if (!done.ok) return storeReply(done.error);
      const state = done.value.state;
      if (built.body.type === "SubmitPlan") return okReply({ planId: state.plans.at(-1)?.id, version: state.plans.at(-1)?.version, revision: done.value.revision });
      if (built.body.type === "StartRun") return okReply({ runId: built.body.runId, tasks: built.body.taskIds, revision: done.value.revision });
      return okReply({ taskId: args.taskId, status: state.tasks.find((t) => t.id === args.taskId)?.status, revision: done.value.revision });
    }
    case "project task get": {
      if (!member) return notMemberReply();
      const blocked = executionGuard(project.state, surface && instanceKey(surface), args.taskId);
      if (blocked) return blocked;
      return taskGetResult(project.state, member.id, args.taskId);
    }
    case "project task report": {
      if (!actor) return notMemberReply();
      const input2 = parseInput(input, flags);
      if (!input2.ok) return input2.reply;
      const built = taskReportBody(args.taskId, input2.value);
      if (!built.ok) return built.reply;
      const blocked = executionGuard(project.state, surface && instanceKey(surface), args.taskId, built.body.type === "ReceiveReport" ? built.body.report.attemptId : undefined);
      if (blocked) return blocked;
      const done = await dispatch(root, actor, built.body, built.actionId);
      if (!done.ok) return storeReply(done.error);
      const saved = done.value.events.find((e) => e.type === "ReportReceived")?.data.report as { stale?: string } | undefined;
      const task = done.value.state.tasks.find((t) => t.id === args.taskId);
      // `stale` means the report was kept but did not move the task; the agent should not assume it counted.
      return okReply({ taskId: args.taskId, status: task?.status, duplicate: !saved || undefined, stale: saved?.stale, revision: done.value.revision });
    }
  }
  return errReply("unknown_op", `未知的專案指令 ${op}`);
}

export { INSTANCE_GENERATION };
