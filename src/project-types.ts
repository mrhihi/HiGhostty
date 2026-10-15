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

export type Step = {
  key: string; // unique within the plan, e.g. collect-mail
  memberId: string;
  title: string;
  instruction: string;
  dependsOn: string[];
  completion: string[]; // explicit result conditions
  inputFrom: { stepKey: string; artifactNames: string[] }[];
};
export type PlanVersion = { id: string; version: number; title: string; objective: string; scope: string; steps: Step[] };

export type TaskStatus = "queued" | "dispatching" | "sent" | "accepted" | "running" | "needs-input"
  | "declined" | "result-ready" | "completed" | "failed" | "cancelled" | "uncertain";
export type Attempt = {
  id: string;
  instanceId: string;
  instanceGeneration: number;
  bindingRevision: number;
  effectId: string;
  inputStarted: boolean;
};
export type Task = {
  id: string;
  runId: string;
  stepKey: string;
  planVersion: number;
  memberId: string;
  status: TaskStatus;
  attempt?: Attempt;
  attemptIds: string[]; // every attempt ever made, oldest first
  cancelRequested: boolean;
  resultArtifactIds: string[];
  reworkFeedback?: string;
};
export type Run = { id: string; planId: string; planVersion: number; status: "running" | "paused" | "completed"; taskIds: string[]; consentId: string };
export type ExecutionConsent = { id: string; planId: string; version: number; source: "start-button" | "user-message"; sourceMessageId?: string };
// S2 keeps artifact text inside the journal (reports are capped well below its 1 MiB line limit).
export type Artifact = { id: string; taskId: string; attemptId: string; name: string; mediaType: "text/plain" | "text/markdown" | "application/json"; text: string; bytes: number };
export type ReportKind = "accepted" | "progress" | "needs-input" | "declined" | "result" | "failed" | "cancelled";
export type Report = { reportId: string; taskId: string; attemptId: string; kind: ReportKind; summary: string; fingerprint: string; stale?: "old-attempt" | "unmatched" | "terminal" };
export type Issue = { id: string; taskId?: string; memberId: string; kind: "question" | "terminal-blocked" | "delivery-unknown" | "offline"; text: string; resolvedAt?: string };

// A user's answer to a worker's question; delivered into the worker's terminal like a task.
export type IssueReply = { id: string; issueId: string; taskId: string; attemptId: string; text: string; delivery: MessageDelivery };

export type ProjectState = {
  config: ProjectConfig | null;
  members: Member[];
  bindings: Record<string, Binding>;
  handshakes: Record<string, Handshake>;
  messages: Message[];
  messageSeq: number;
  plans: PlanVersion[];
  consents: ExecutionConsent[];
  runs: Run[];
  tasks: Task[];
  artifacts: Artifact[];
  reports: Report[];
  issues: Issue[];
  replies: IssueReply[];
};

export type Actor = { kind: "user" } | { kind: "member"; memberId: string };

export type ProjectEvent = {
  eventId: string;
  type:
    | "ProjectCreated" | "ProjectRenamed" | "MemberAdded" | "MemberRemoved" | "BindingChanged"
    | "MemberPurposeUpdated" | "HandshakeRecorded" | "MessageQueued" | "MessageAdded" | "MessageDeliveryChanged"
    | "PlanVersionCreated" | "ExecutionConsentRecorded" | "RunStarted" | "RunPaused" | "RunResumed" | "RunCompleted"
    | "TaskQueued" | "TaskDispatchPrepared" | "InputWillStart" | "TaskStatusChanged" | "ReportReceived"
    | "IssueOpened" | "IssueResolved" | "IssueReplyQueued" | "ReplyDeliveryChanged" | "TaskCancelRequested" | "TaskReworkRequested" | "TaskRetryRequested";
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
  | { type: "SetMessageDelivery"; messageId: string; delivery: MessageDelivery }
  | TaskActionBody;

export type ReportInput = {
  reportId: string;
  attemptId: string;
  kind: ReportKind;
  summary: string;
  question?: string;
  artifacts?: { name: string; mediaType: Artifact["mediaType"]; text: string }[];
};
export type TaskActionBody =
  | { type: "SubmitPlan"; planId: string; plan: unknown; basePlanVersion?: number }
  | { type: "StartRun"; runId: string; planId: string; version: number; taskIds: string[]; consent: { id: string; source: "start-button" | "user-message"; sourceMessageId?: string } }
  | { type: "PauseRun" | "ResumeRun"; runId: string }
  | { type: "PrepareDispatch"; taskId: string; attemptId: string; effectId: string }
  | { type: "RecordInputStart"; taskId: string; attemptId: string; effectId: string }
  | { type: "RecordInputResult"; taskId: string; attemptId: string; effectId: string; outcome: "sent" | "not-sent" | "unknown" }
  | { type: "ReceiveReport"; taskId: string; report: ReportInput }
  | { type: "ReplyIssue"; issueId: string; replyId: string; text: string }
  | { type: "SetReplyDelivery"; replyId: string; delivery: MessageDelivery }
  | { type: "AcceptResult"; taskId: string; attemptId: string; checks?: { criterion: string; evidenceArtifactIds: string[] }[] }
  | { type: "RequestRework"; taskId: string; attemptId: string; feedback: string }
  | { type: "RequestCancel"; taskId: string }
  | { type: "RetryTask"; taskId: string; memberId?: string }
  | { type: "ReconcileTask"; taskId: string; attemptId: string; decision: "not-received" | "running" | "failed" };

export type ProjectAction = { actionId: string; actor: Actor; body: ActionBody };

export type ProjectErrorCode =
  | "bad_args" | "not_found" | "forbidden" | "already_exists" | "instance_in_use" | "needs_user_decision"
  | "invalid_plan" | "revision_conflict" | "stale_attempt" | "report_conflict" | "invalid_state";
export type ProjectError = { code: ProjectErrorCode; message: string; details?: unknown };
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export type Decision = { events: ProjectEvent[] };
