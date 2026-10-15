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
  // The model this agent should normally use (a task's own `model` wins). Free text such as opus or sonnet.
  model?: string;
};
// A model name is typed into an agent's terminal (`/model <name>`), so only plain identifier characters pass.
export const validModel = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\-\[\]\/]{0,59}$/.test(value);

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
  // Who accepts the result. Default coordinator. "auto-on-protocol-result" is only for intermediate
  // steps with no external effect: validatePlan rejects it when a later step writes outside.
  acceptance?: "coordinator" | "user" | "auto-on-protocol-result";
  // The step changes something outside HiGhostty (creates a ticket, sends mail…).
  externalWrite?: boolean;
  // The model that suits this step (e.g. a small one for routine edits, a large one for design); empty: the member's default.
  model?: string;
};
export type PlanVersion = { id: string; version: number; title: string; objective: string; scope: string; steps: Step[] };

export type TaskStatus = "queued" | "dispatching" | "sent" | "accepted" | "running" | "waiting-help" | "needs-input"
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
  // A result the coordinator wrote down from the screen of a worker that cannot report; it needs
  // the user's confirmation before it becomes a result.
  observed?: { summary: string; artifactIds: string[]; at: string };
  // When the task last moved or was last heard from (event time); used only to notice silence.
  activityAt?: string;
};
export type Run = {
  id: string; planId: string; planVersion: number; status: "running" | "paused" | "completed" | "closed"; taskIds: string[]; consentId: string;
  // Hand tasks over automatically when every check passes (otherwise each needs the user's button).
  auto: boolean;
  // Task ids that were not completed when the user closed the run.
  unfinished?: string[];
};
export type ExecutionConsent = { id: string; planId: string; version: number; source: "start-button" | "user-message" | "help-request"; sourceMessageId?: string; sourceHelpId?: string };
// S2 keeps artifact text inside the journal (reports are capped well below its 1 MiB line limit).
export type Artifact = { id: string; taskId: string; attemptId: string; name: string; mediaType: "text/plain" | "text/markdown" | "application/json"; text: string; bytes: number; source?: "screen" };
export type ReportKind = "accepted" | "progress" | "needs-input" | "declined" | "result" | "failed" | "cancelled";
export type Report = { reportId: string; taskId: string; attemptId: string; kind: ReportKind; summary: string; fingerprint: string; stale?: "old-attempt" | "unmatched" | "terminal" };
export type Issue = { id: string; taskId?: string; memberId: string; kind: "question" | "terminal-blocked" | "delivery-unknown" | "offline"; text: string; resolvedAt?: string };

// A user's answer to a worker's question; delivered into the worker's terminal like a task.
export type IssueReply = { id: string; issueId: string; taskId: string; attemptId: string; text: string; delivery: MessageDelivery };

// A worker asking the coordinator whether another agent can help. `delivery` is the request reaching the
// coordinator (`replied` once answered); the answer is then delivered to the asker like a reply.
export type Help = { id: string; memberId: string; executionId?: string; text: string; delivery: MessageDelivery; answer?: { text: string; delivery: MessageDelivery }; resultDelivery?: MessageDelivery };

// A fact the coordinator should act on (a result to check, a task that failed or was declined). Kept in the
// journal so it survives a restart; `delivery` is the wake-up reaching the coordinator, `handled` says the
// task has since moved on (accepted, reworked, retried…), which only the journal can tell.
export type NoticeKind = "result-ready" | "failed" | "declined";
export type Notice = { id: string; kind: NoticeKind; taskId: string; attemptId: string; delivery: MessageDelivery; handled: boolean };

// One work session run for a task attempt. The member is the long-lived collaborator; the execution is this
// session, found by its instance (a tmux session). A report from it counts only for its own task and attempt,
// so another job of the same member (or the member's personal terminal) cannot speak for it.
export type Execution = { id: string; memberId: string; taskId: string; attemptId: string; instanceId: string; generation: number; status: "live" | "ended" };

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
  helps: Help[];
  notices: Notice[];
  executions: Execution[];
};

export type Actor = { kind: "user" } | { kind: "member"; memberId: string };

export type ProjectEvent = {
  eventId: string;
  type:
    | "ProjectCreated" | "ProjectRenamed" | "MemberAdded" | "MemberRemoved" | "BindingChanged"
    | "MemberPurposeUpdated" | "MemberModelUpdated" | "HandshakeRecorded" | "MessageQueued" | "MessageAdded" | "MessageDeliveryChanged"
    | "PlanVersionCreated" | "ExecutionConsentRecorded" | "RunStarted" | "RunPaused" | "RunResumed" | "RunCompleted"
    | "TaskQueued" | "TaskDispatchPrepared" | "InputWillStart" | "TaskStatusChanged" | "ReportReceived"
    | "RunAutoChanged" | "RunClosed" | "ObservedResultSubmitted"
    | "MemberLaunchChanged" | "ExecutionRegistered" | "ExecutionEnded" | "NoticeQueued" | "NoticeDeliveryChanged" | "HelpAsked" | "HelpAnswered" | "HelpDeliveryChanged" | "IssueOpened" | "IssueResolved" | "IssueReplyQueued" | "ReplyDeliveryChanged" | "TaskCancelRequested" | "TaskReworkRequested" | "TaskRetryRequested";
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
  | { type: "SetMemberModel"; memberId: string; model: string }
  // A worker with a launch spec runs each task in its own work session; null goes back to typing into its terminal.
  | { type: "SetMemberLaunch"; memberId: string; launch: LaunchSpec | null }
  | { type: "Hello"; purpose: string; reportMode: ReportMode; reportNeedsApproval?: boolean; protocolVersion: number }
  | { type: "SendMessage"; messageId: string; conversationId: string; text: string }
  | { type: "CoordinatorMessage"; messageId: string; inReplyTo?: string; text: string }
  | { type: "SetMessageDelivery"; messageId: string; delivery: MessageDelivery }
  // executionId: the work session the request came from (set from the caller's terminal, never typed by an agent).
  | { type: "AskHelp"; helpId: string; text: string; executionId?: string }
  | { type: "AnswerHelp"; helpId: string; text: string }
  | { type: "SetHelpDelivery"; helpId: string; part: "ask" | "answer" | "result"; delivery: MessageDelivery }
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
  | { type: "StartRun"; runId: string; planId: string; version: number; taskIds: string[]; auto?: boolean; consent: { id: string; source: "start-button" | "user-message" | "help-request"; sourceMessageId?: string; sourceHelpId?: string } }
  | { type: "SetRunAuto"; runId: string; auto: boolean }
  | { type: "CloseRun"; runId: string }
  | { type: "RecoverTasks" }
  | { type: "SubmitObservedResult"; taskId: string; attemptId: string; summary: string; artifacts?: { name: string; mediaType: Artifact["mediaType"]; text: string }[] }
  | { type: "ConfirmObservedResult"; taskId: string; attemptId: string }
  | { type: "PauseRun" | "ResumeRun"; runId: string }
  | { type: "PrepareDispatch"; taskId: string; attemptId: string; effectId: string }
  | { type: "RecordInputStart"; taskId: string; attemptId: string; effectId: string }
  | { type: "RecordInputResult"; taskId: string; attemptId: string; effectId: string; outcome: "sent" | "not-sent" | "unknown" }
  | { type: "ReceiveReport"; taskId: string; report: ReportInput }
  | { type: "ReplyIssue"; issueId: string; replyId: string; text: string }
  | { type: "SetReplyDelivery"; replyId: string; delivery: MessageDelivery }
  | { type: "SetNoticeDelivery"; noticeId: string; delivery: MessageDelivery }
  | { type: "RegisterExecution"; executionId: string; memberId: string; taskId: string; attemptId: string; instanceId: string; generation: number }
  | { type: "EndExecution"; executionId: string }
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
