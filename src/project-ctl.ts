// `highostty ctl project …` against the journal. The caller's own window answers (any window
// can read and write a project), so the caller is resolved here to a member by its terminal.
import { errReply, okReply, type Reply } from "./control";
import {
  callerMember, getResult, helloBody, inboxResult, INSTANCE_GENERATION, instanceKey, messageBody, notMemberReply, parseInput, projectErrorReply,
} from "./project-control";
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
      return done.ok ? okReply({ member: member!.id, revision: done.value.revision, handshake: true }) : storeReply(done.error);
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
  }
  return errReply("unknown_op", `未知的專案指令 ${op}`);
}

export { INSTANCE_GENERATION };
