// Types for the project area (docs/project-implementation.md §3). S1 subset: members,
// bindings, hello and the coordinator conversation; plans, runs and tasks come in S2.
export type AgentKind = "claude" | "codex" | "gemini" | "opencode" | "copilot" | "aider";

export type ProjectConfig = {
  schemaVersion: 1;
  id: string;
  name: string;
  coordinatorMemberId: string;
  createdAt: string;
};

export type LaunchSpec = {
  kind: AgentKind;
  cwd: { kind: "project-relative" | "absolute"; path: string };
  args: string[];
  tmux: boolean;
};

export type ReportMode = "protocol" | "screen";

export type Member = {
  id: string;
  role: "coordinator" | "worker";
  name: string;
  // The user's note or the agent's own description; carries no authority.
  purpose: string;
  purposeSource: "user" | "agent";
  reportMode: ReportMode;
  launch?: LaunchSpec;
  favoriteId?: string;
};

export type Binding = {
  projectId: string;
  memberId: string;
  instanceId: string;
  instanceGeneration: number;
  bindingRevision: number;
};

export type MessageDelivery = "queued" | "sending" | "sent" | "replied" | "uncertain";
export type Message = {
  id: string;
  conversationId: string;
  author: "user" | "coordinator";
  text: string;
  delivery: MessageDelivery;
  inReplyTo?: string;
  seq: number;
};

// What a member said about itself in the `project hello` handshake.
export type Handshake = { protocolVersion: 1; reportMode: ReportMode; reportNeedsApproval: boolean; at: string };

export type ProjectState = {
  config: ProjectConfig | null;
  members: Member[];
  bindings: Record<string, Binding>;
  handshakes: Record<string, Handshake>;
  messages: Message[];
  messageSeq: number;
};

export type Actor = { kind: "user" } | { kind: "member"; memberId: string };

export type ProjectEvent = {
  eventId: string;
  type:
    | "ProjectCreated" | "ProjectRenamed" | "MemberAdded" | "MemberRemoved" | "BindingChanged"
    | "MemberPurposeUpdated" | "HandshakeRecorded" | "MessageQueued" | "MessageAdded" | "MessageDeliveryChanged";
  at: string;
  actor: Actor;
  data: Record<string, unknown>;
};

export type ActionBody =
  | { type: "CreateProject"; config: ProjectConfig; coordinator: Member }
  | { type: "RenameProject"; name: string }
  | { type: "AddMember"; member: Member; binding?: { instanceId: string; generation: number } }
  | { type: "RemoveMember"; memberId: string }
  | { type: "BindMember"; memberId: string; instanceId: string; generation: number }
  | { type: "UpdatePurpose"; memberId: string; purpose: string; source: "user" | "agent" }
  | { type: "Hello"; purpose: string; reportMode: ReportMode; reportNeedsApproval?: boolean; protocolVersion: number }
  | { type: "SendMessage"; messageId: string; conversationId: string; text: string }
  | { type: "CoordinatorMessage"; messageId: string; inReplyTo?: string; text: string }
  | { type: "SetMessageDelivery"; messageId: string; delivery: MessageDelivery };

export type ProjectAction = { actionId: string; actor: Actor; body: ActionBody };

export type ProjectErrorCode =
  | "bad_args" | "not_found" | "forbidden" | "already_exists" | "instance_in_use" | "needs_user_decision";
export type ProjectError = { code: ProjectErrorCode; message: string };
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export type Decision = { events: ProjectEvent[] };
