/** Shell commands in native dispatch Threads may only read DingTalk data. */
export const DINGTALK_DISPATCH_ENV = "CODEXHOST_DINGTALK_DISPATCH";

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
  /** Complete public commentary or plan steps, never reasoning or tool output. */
  onProgress?(text: string): void;
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
