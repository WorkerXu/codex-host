/** Shell commands in native dispatch Threads may only read DingTalk data. */
export const DINGTALK_DISPATCH_ENV = "CODEXHOST_DINGTALK_DISPATCH";

/** Public step kinds shown on the progress card; each maps to one official icon. */
export type DingTalkProgressStepKind =
  "context" | "command" | "tool" | "file" | "search" | "answer";

export type DingTalkProgressStepStatus = "running" | "done" | "failed";

/** One real step of a dispatched Turn, already sanitized for DingTalk. */
export interface DingTalkProgressStep {
  /** Stable within one Turn; repeated events replace the same step. */
  id: string;
  kind: DingTalkProgressStepKind;
  title: string;
  /** Short public detail such as the command that ran; never output or reasoning. */
  detail: string;
  status: DingTalkProgressStepStatus;
}

/**
 * Progress of one Turn: a step start/finish, or a short public status line for
 * the panel title. Private reasoning and raw tool output never reach this type.
 */
export type DingTalkProgressEvent =
  { type: "step"; step: DingTalkProgressStep } | { type: "status"; text: string };

/** Native Codex conversation started for one dispatched DingTalk message. */
export interface DingTalkDispatchThreadInput {
  cwd: string;
  /** Desktop project the Thread is assigned to; also places it in its section. */
  projectId: string | null;
  /** Project roots; every one becomes a working folder of the Thread. */
  projectRoots: readonly string[];
  title: string;
  developerInstructions: string;
  model: string | null;
  reasoningEffort: string | null;
  prompt: string;
  /** Complete public steps and status lines, never reasoning or tool output. */
  onProgress?(event: DingTalkProgressEvent): void;
  /** Approval summaries run with all execution and connector tools disabled. */
  readOnlySummary?: boolean;
}

export interface DingTalkDispatchRunResult {
  answer: string;
  status: "completed" | "failed" | "interrupted";
  errorMessage: string | null;
}

export interface DingTalkDispatchRun {
  threadId: string;
  turnId: string;
  completed: Promise<DingTalkDispatchRunResult>;
}

export type DingTalkDispatchThreadStarter = (
  input: DingTalkDispatchThreadInput,
) => Promise<DingTalkDispatchRun>;
