// Pure rules for a project: decide(state, action) validates and produces events,
// reduce(state, event) replays them. No IDs are made, no files read, no DOM here.
import { decideTasks, helpResultReady, memberBusy, reduceTasks } from "./project-tasks.ts";
import type {
  Actor, ActionBody, Binding, Decision, Help, Member, Message, ProjectAction, ProjectError, ProjectErrorCode,
  ProjectEvent, ProjectState, Result,
} from "./project-types.ts";
import { validModel } from "./project-types.ts";

export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_PURPOSE_CHARS = 500;
export const MAX_NAME_CHARS = 80;

export const emptyState = (): ProjectState => ({
  config: null, members: [], bindings: {}, handshakes: {}, messages: [], messageSeq: 0,
  plans: [], consents: [], runs: [], tasks: [], artifacts: [], reports: [], issues: [], replies: [], helps: [], notices: [], executions: [],
});

const err = (code: ProjectErrorCode, message: string): Result<never, ProjectError> => ({ ok: false, error: { code, message } });
const ok = (events: ProjectEvent[]): Result<Decision, ProjectError> => ({ ok: true, value: { events } });

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

export function coordinatorOf(state: ProjectState): Member | undefined {
  return state.members.find((m) => m.role === "coordinator");
}

// Which member a binding-holding instance belongs to, if any.
export function memberForInstance(state: ProjectState, instanceId: string): Member | undefined {
  const b = Object.values(state.bindings).find((x) => x.instanceId === instanceId);
  const memberId = b?.memberId ?? executionForInstance(state, instanceId)?.memberId;
  return memberId ? state.members.find((m) => m.id === memberId) : undefined;
}
// The live work session running in this instance, if any.
export const executionForInstance = (state: ProjectState, instanceId: string) =>
  state.executions.find((x) => x.status === "live" && x.instanceId === instanceId);

export function decide(state: ProjectState, action: ProjectAction, now: string): Result<Decision, ProjectError> {
  const { actor, body } = action;
  let n = 0;
  const ev = (type: ProjectEvent["type"], data: Record<string, unknown>): ProjectEvent => ({
    eventId: `${action.actionId}:${n++}`, type, at: now, actor, data,
  });
  const member = (id: string) => state.members.find((m) => m.id === id);
  const isUser = actor.kind === "user";
  const callerIs = (id: string) => actor.kind === "member" && actor.memberId === id;

  if (body.type !== "CreateProject" && !state.config) return err("not_found", "專案尚未建立");

  switch (body.type) {
    case "CreateProject": {
      if (state.config) return err("already_exists", "專案已存在");
      if (!isUser) return err("forbidden", "只有使用者能建立專案");
      const name = clean(body.config.name);
      if (!name || name.length > MAX_NAME_CHARS) return err("bad_args", "專案名稱不可空白且最多 80 字");
      const c = body.coordinator;
      if (c.role !== "coordinator" || c.id !== body.config.coordinatorMemberId) return err("bad_args", "coordinator 與設定不符");
      return ok([ev("ProjectCreated", { config: { ...body.config, name } }), ev("MemberAdded", { member: c })]);
    }
    case "RenameProject": {
      if (!isUser) return err("forbidden", "只有使用者能改名");
      const name = clean(body.name);
      if (!name || name.length > MAX_NAME_CHARS) return err("bad_args", "專案名稱不可空白且最多 80 字");
      return ok([ev("ProjectRenamed", { name })]);
    }
    case "AddMember": {
      if (!isUser) return err("forbidden", "只有使用者能加入成員");
      const m = body.member;
      if (m.role !== "worker") return err("bad_args", "只能加入 worker");
      if (!clean(m.name)) return err("bad_args", "成員名稱不可空白");
      if (member(m.id)) return err("already_exists", "成員 ID 重複");
      if (m.purpose.length > MAX_PURPOSE_CHARS) return err("bad_args", "用途過長");
      if (body.binding) {
        const taken = memberForInstance(state, body.binding.instanceId);
        if (taken) return err("instance_in_use", `這個 agent 已是成員「${taken.name}」`);
      }
      const events = [ev("MemberAdded", { member: m })];
      if (body.binding) {
        events.push(ev("BindingChanged", { memberId: m.id, instanceId: body.binding.instanceId, generation: body.binding.generation }));
      }
      return ok(events);
    }
    case "RemoveMember": {
      if (!isUser) return err("forbidden", "只有使用者能移除成員");
      const m = member(body.memberId);
      if (!m) return err("not_found", "沒有這個成員");
      if (m.role === "coordinator") return err("bad_args", "不能移除 coordinator");
      if (state.tasks.some((t) => t.memberId === m.id && !["completed", "failed", "cancelled", "declined"].includes(t.status))) {
        return err("invalid_state", "這位成員還有未結束的任務；請先取消或完成它們");
      }
      return ok([ev("MemberRemoved", { memberId: m.id })]);
    }
    case "BindMember": {
      if (!isUser) return err("forbidden", "只有使用者能綁定成員");
      if (!member(body.memberId)) return err("not_found", "沒有這個成員");
      const taken = memberForInstance(state, body.instanceId);
      if (taken && taken.id !== body.memberId) return err("instance_in_use", `這個 agent 已是成員「${taken.name}」`);
      return ok([ev("BindingChanged", { memberId: body.memberId, instanceId: body.instanceId, generation: body.generation })]);
    }
    case "UpdatePurpose": {
      const m = member(body.memberId);
      if (!m) return err("not_found", "沒有這個成員");
      if (body.source === "user" ? !isUser : !callerIs(m.id)) return err("forbidden", "不能代他人修改用途");
      const purpose = clean(body.purpose);
      if (purpose.length > MAX_PURPOSE_CHARS) return err("bad_args", "用途過長");
      return ok([ev("MemberPurposeUpdated", { memberId: m.id, purpose, source: body.source })]);
    }
    case "SetMemberModel": {
      if (!isUser) return err("forbidden", "只有使用者能指定成員的預設模型");
      if (!member(body.memberId)) return err("not_found", "沒有這個成員");
      const model = body.model.trim();
      if (model && !validModel(model)) return err("bad_args", "模型名稱只能用英數與 . _ : - [ ] /，最多 60 字");
      return ok([ev("MemberModelUpdated", { memberId: body.memberId, model })]);
    }
    case "SetMemberLaunch": {
      if (!isUser) return err("forbidden", "只有使用者能設定成員的工作 session");
      const m = member(body.memberId);
      if (!m) return err("not_found", "沒有這個成員");
      if (m.role !== "worker") return err("bad_args", "只有 worker 能設定獨立工作 session");
      // Switching mid-task would leave its replies with no terminal to go to.
      if (memberBusy(state, m.id) || state.executions.some((x) => x.status === "live" && x.memberId === m.id)) return err("invalid_state", "這位成員還有進行中的任務或工作 session，請先處理完再切換");
      const l = body.launch;
      if (l !== null) {
        if (!l || typeof l !== "object" || !["claude", "codex", "copilot", "gemini"].includes(l.kind)) return err("bad_args", "不支援的 agent 種類");
        if (l.cwd?.kind !== "absolute" || typeof l.cwd.path !== "string" || !l.cwd.path.startsWith("/")) return err("bad_args", "工作目錄必須是絕對路徑");
        if (!Array.isArray(l.args) || l.args.some((a) => typeof a !== "string" || a.includes("\0"))) return err("bad_args", "args 必須是字串陣列");
      }
      return ok([ev("MemberLaunchChanged", { memberId: m.id, launch: l })]);
    }
    case "Hello": {
      if (actor.kind !== "member") return err("forbidden", "hello 只能由成員 agent 呼叫");
      const m = member(actor.memberId);
      if (!m) return err("not_found", "呼叫者不是這個專案的成員");
      if (body.protocolVersion !== 1) return err("bad_args", "不支援的 protocolVersion");
      if (body.reportMode !== "protocol" && body.reportMode !== "screen") return err("bad_args", "reportMode 必須是 protocol 或 screen");
      const purpose = clean(body.purpose);
      if (purpose.length > MAX_PURPOSE_CHARS) return err("bad_args", "用途過長");
      const events = [ev("HandshakeRecorded", {
        memberId: m.id, reportMode: body.reportMode, reportNeedsApproval: body.reportNeedsApproval === true,
      })];
      // The user's own note wins; hello only fills in or refreshes an agent-written purpose.
      if (purpose && !(m.purposeSource === "user" && m.purpose)) {
        events.push(ev("MemberPurposeUpdated", { memberId: m.id, purpose, source: "agent" }));
      }
      return ok(events);
    }
    case "SendMessage": {
      if (!isUser) return err("forbidden", "只有使用者能送出討論訊息");
      const text = body.text.trim();
      if (!text) return err("bad_args", "訊息不可空白");
      if (text.length > MAX_MESSAGE_CHARS) return err("bad_args", "訊息過長");
      if (state.messages.some((x) => x.id === body.messageId)) return err("already_exists", "messageId 重複");
      return ok([ev("MessageQueued", { messageId: body.messageId, conversationId: body.conversationId, text })]);
    }
    case "CoordinatorMessage": {
      const coord = coordinatorOf(state);
      if (!coord || !callerIs(coord.id)) return err("forbidden", "只有 coordinator 能回覆討論");
      const text = body.text.trim();
      if (!text) return err("bad_args", "訊息不可空白");
      if (text.length > MAX_MESSAGE_CHARS) return err("bad_args", "訊息過長");
      if (state.messages.some((x) => x.id === body.messageId)) return err("already_exists", "messageId 重複");
      let conversationId = "main";
      if (body.inReplyTo) {
        const src = state.messages.find((x) => x.id === body.inReplyTo);
        if (!src || src.author !== "user") return err("not_found", "inReplyTo 不是使用者的訊息");
        conversationId = src.conversationId;
      }
      return ok([ev("MessageAdded", { messageId: body.messageId, conversationId, text, inReplyTo: body.inReplyTo })]);
    }
    case "SetMessageDelivery": {
      const msg = state.messages.find((x) => x.id === body.messageId);
      if (!msg || msg.author !== "user") return err("not_found", "沒有這則使用者訊息");
      return ok([ev("MessageDeliveryChanged", { messageId: msg.id, delivery: body.delivery })]);
    }
    case "AskHelp": {
      const asker = actor.kind === "member" ? member(actor.memberId) : undefined;
      if (!asker || asker.role !== "worker") return err("forbidden", "只有 worker 能向 coordinator 求助");
      const text = body.text.trim();
      if (!text) return err("bad_args", "求助內容不可空白");
      if (text.length > MAX_MESSAGE_CHARS) return err("bad_args", "求助內容過長");
      if (state.helps.some((x) => x.id === body.helpId)) return err("already_exists", "helpId 重複");
      if (body.executionId && !state.executions.some((x) => x.id === body.executionId && x.memberId === asker.id && x.status === "live")) return err("invalid_state", "提問的工作 session 已不存在");
      return ok([ev("HelpAsked", { helpId: body.helpId, memberId: asker.id, text, ...(body.executionId ? { executionId: body.executionId } : {}) })]);
    }
    case "AnswerHelp": {
      const coord = coordinatorOf(state);
      if (!coord || !callerIs(coord.id)) return err("forbidden", "只有 coordinator 能回覆求助");
      const help = state.helps.find((x) => x.id === body.helpId);
      if (!help) return err("not_found", "沒有這個求助");
      if (help.answer) return err("invalid_state", "這個求助已回覆過");
      const text = body.text.trim();
      if (!text) return err("bad_args", "回覆不可空白");
      if (text.length > MAX_MESSAGE_CHARS) return err("bad_args", "回覆過長");
      return ok([ev("HelpAnswered", { helpId: help.id, text })]);
    }
    case "SetHelpDelivery": {
      const help = state.helps.find((x) => x.id === body.helpId);
      if (!help || (body.part === "answer" && !help.answer) || (body.part === "result" && !helpResultReady(state, help.id))) return err("not_found", "沒有這個求助");
      return ok([ev("HelpDeliveryChanged", { helpId: help.id, part: body.part, delivery: body.delivery })]);
    }
    default:
      return decideTasks(state, actor, body, ev);
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function reduce(state: ProjectState, event: ProjectEvent): ProjectState {
  const d = event.data;
  switch (event.type) {
    case "ProjectCreated":
      return { ...state, config: d.config as ProjectState["config"] };
    case "ProjectRenamed":
      return state.config ? { ...state, config: { ...state.config, name: str(d.name) } } : state;
    case "MemberAdded":
      return { ...state, members: [...state.members, d.member as Member] };
    case "MemberRemoved": {
      const id = str(d.memberId);
      const { [id]: _b, ...bindings } = state.bindings;
      const { [id]: _h, ...handshakes } = state.handshakes;
      return { ...state, members: state.members.filter((m) => m.id !== id), bindings, handshakes };
    }
    case "BindingChanged": {
      const id = str(d.memberId);
      const prev = state.bindings[id];
      const binding: Binding = {
        projectId: state.config?.id ?? "",
        memberId: id,
        instanceId: str(d.instanceId),
        instanceGeneration: Number(d.generation) || 0,
        bindingRevision: (prev?.bindingRevision ?? 0) + 1,
      };
      // A new binding means the agent behind it may differ, so the old handshake no longer counts.
      const { [id]: _h, ...handshakes } = state.handshakes;
      // ...and so does what it told us about how it reports (when an existing member moves to another agent):
      // until it says hello again, assume the screen.
      const members = state.members.map((m) => (prev && m.id === id && m.role === "worker" ? { ...m, reportMode: "screen" as const } : m));
      return { ...state, members, bindings: { ...state.bindings, [id]: binding }, handshakes };
    }
    case "MemberPurposeUpdated":
      return {
        ...state,
        members: state.members.map((m) =>
          m.id === d.memberId ? { ...m, purpose: str(d.purpose), purposeSource: d.source === "agent" ? "agent" : "user" } : m),
      };
    case "MemberModelUpdated":
      return { ...state, members: state.members.map((m) => (m.id === d.memberId ? { ...m, model: str(d.model) || undefined } : m)) };
    case "MemberLaunchChanged":
      return { ...state, members: state.members.map((m) => {
        if (m.id !== d.memberId) return m;
        const { launch: _old, ...rest } = m;
        return d.launch ? { ...rest, launch: d.launch as Member["launch"] } : rest;
      }) };
    case "HandshakeRecorded": {
      const id = str(d.memberId);
      const mode = d.reportMode === "screen" ? "screen" : "protocol";
      return {
        ...state,
        handshakes: { ...state.handshakes, [id]: { protocolVersion: 1, reportMode: mode, reportNeedsApproval: d.reportNeedsApproval === true, at: event.at } },
        members: state.members.map((m) => (m.id === id ? { ...m, reportMode: mode } : m)),
      };
    }
    case "MessageQueued":
    case "MessageAdded": {
      const author: Message["author"] = event.type === "MessageQueued" ? "user" : "coordinator";
      const seq = state.messageSeq + 1;
      const msg: Message = {
        id: str(d.messageId), conversationId: str(d.conversationId) || "main", author, text: str(d.text),
        delivery: author === "user" ? "queued" : "sent", seq,
        ...(typeof d.inReplyTo === "string" ? { inReplyTo: d.inReplyTo } : {}),
      };
      // A coordinator reply settles the user message it answers.
      const messages = state.messages.map((m) => (m.id === msg.inReplyTo ? { ...m, delivery: "replied" as const } : m));
      return { ...state, messages: [...messages, msg], messageSeq: seq };
    }
    case "MessageDeliveryChanged":
      return {
        ...state,
        // `replied` is final; a late host reply must not step it back to `sent`.
        messages: state.messages.map((m) =>
          m.id === d.messageId && m.delivery !== "replied" ? { ...m, delivery: d.delivery as Message["delivery"] } : m),
      };
    case "HelpAsked":
      return { ...state, helps: [...state.helps, { id: str(d.helpId), memberId: str(d.memberId), ...(typeof d.executionId === "string" ? { executionId: d.executionId } : {}), text: str(d.text), delivery: "queued" }] };
    case "HelpAnswered":
      // Answering settles the request itself; the answer then waits to reach the asker.
      return { ...state, helps: state.helps.map((h) => (h.id === d.helpId ? { ...h, delivery: "replied", answer: { text: str(d.text), delivery: "queued" } } : h)) };
    case "HelpDeliveryChanged":
      return {
        ...state,
        helps: state.helps.map((h) => {
          if (h.id !== d.helpId) return h;
          const delivery = d.delivery as Help["delivery"];
          if (d.part === "result") return { ...h, resultDelivery: delivery };
          if (d.part === "answer") return h.answer ? { ...h, answer: { ...h.answer, delivery } } : h;
          return h.delivery === "replied" ? h : { ...h, delivery };
        }),
      };
    default:
      return reduceTasks(state, event);
  }
}

export function replay(events: ProjectEvent[], from: ProjectState = emptyState()): ProjectState {
  return events.reduce(reduce, from);
}

// Messages a member should see in `project inbox`: for the coordinator, user messages after `after`.
export function inboxFor(state: ProjectState, memberId: string, after = 0): Message[] {
  const coord = coordinatorOf(state);
  if (!coord || coord.id !== memberId) return [];
  return state.messages.filter((m) => m.author === "user" && m.seq > after);
}

export type { Actor, ActionBody };
