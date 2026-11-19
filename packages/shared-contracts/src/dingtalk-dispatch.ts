import { z } from "zod";

import { codexAgentFileNameSchema } from "./codex-agents.js";

/**
 * Settings for manual DingTalk dispatch on the local Host.
 *
 * A message is never dispatched automatically: the workbench opens the agent
 * panel from one selected message, scores the enabled agents once and runs the
 * chosen agents for that message only.
 *
 * Listening is configured per agent, keyed by the agent's file name so a
 * rename keeps the choice. An agent without a map entry is off. Dispatch also
 * needs the agent's native sidebar section and the Mac-local project inside
 * it; both are stored here and validated again by the Host.
 */
export const DINGTALK_DISPATCH_GET_METHOD = "codexhost/dingtalk-dispatch/get";
export const DINGTALK_DISPATCH_SET_METHOD = "codexhost/dingtalk-dispatch/set";
export const DINGTALK_DISPATCH_STATUS_METHOD = "codexhost/dingtalk-dispatch/status";
export const DINGTALK_DISPATCH_SCORE_METHOD = "codexhost/dingtalk-dispatch/score";
export const DINGTALK_DISPATCH_RUN_METHOD = "codexhost/dingtalk-dispatch/run";

export const DINGTALK_REPLY_SCOPES = ["group", "direct"] as const;
export type DingTalkReplyScope = (typeof DINGTALK_REPLY_SCOPES)[number];

export const DINGTALK_DISPATCH_MAX_AGENTS = 512;
export const DINGTALK_DISPATCH_MAX_RUN_AGENTS = 32;
/** Below this score the panel starts with nothing checked. */
export const DINGTALK_DISPATCH_DEFAULT_PICK_MIN = 0.3;

const identifierSchema = z.string().trim().min(1).max(512);
const pathSchema = z.string().min(1).max(4096);

export const dingtalkAgentDispatchSchema = z
  .object({
    enabled: z.boolean(),
    /** Reply in the originating group (default) or in a direct message. */
    replyScope: z.enum(DINGTALK_REPLY_SCOPES),
    /** Native sidebar section that contains the dispatch project. */
    sectionId: identifierSchema.nullable().default(null),
    /** Mac-local Desktop project used as the dispatch target. */
    projectId: identifierSchema.nullable().default(null),
    /** Primary root path of that project; becomes the Thread cwd. */
    projectPath: pathSchema.nullable().default(null),
    /** Project roots become the Thread's working folders; primary first. */
    projectRoots: z.array(pathSchema).max(32).default([]),
  })
  .strip();

export type DingTalkAgentDispatch = z.infer<typeof dingtalkAgentDispatchSchema>;

/**
 * Older files also carried `eventTypes` and a global `threshold`. This schema
 * strips unknown keys, so reading keeps `enabled` and `replyScope` and drops
 * the retired auto-dispatch settings.
 */
export const dingtalkDispatchSettingsSchema = z
  .object({
    /** Keyed by `fileName`; a missing key means the agent does not listen. */
    agents: z
      .record(codexAgentFileNameSchema, dingtalkAgentDispatchSchema)
      .refine((agents) => Object.keys(agents).length <= DINGTALK_DISPATCH_MAX_AGENTS, {
        message: "Too many agents",
      }),
  })
  .strip();

export type DingTalkDispatchSettings = z.infer<typeof dingtalkDispatchSettingsSchema>;

export const DINGTALK_DISPATCH_RESULTS = ["replied", "failed", "skipped"] as const;
export type DingTalkDispatchResult = (typeof DINGTALK_DISPATCH_RESULTS)[number];

export const dingtalkDispatchAgentStatusSchema = z
  .object({
    lastDispatchAt: z.number().int().nonnegative(),
    result: z.enum(DINGTALK_DISPATCH_RESULTS),
    /** Conversation title and, on failure, the public reason. Never a threshold. */
    detail: z.string().max(200).optional(),
  })
  .strict();

export const dingtalkDispatchStatusSchema = z
  .record(codexAgentFileNameSchema, dingtalkDispatchAgentStatusSchema)
  .refine((status) => Object.keys(status).length <= DINGTALK_DISPATCH_MAX_AGENTS, {
    message: "Too many agents",
  });
export type DingTalkDispatchStatus = z.infer<typeof dingtalkDispatchStatusSchema>;
export type DingTalkDispatchAgentStatus = z.infer<typeof dingtalkDispatchAgentStatusSchema>;

export function defaultDingTalkAgentDispatch(): DingTalkAgentDispatch {
  return {
    enabled: false,
    replyScope: "group",
    sectionId: null,
    projectId: null,
    projectPath: null,
    projectRoots: [],
  };
}

export function defaultDingTalkDispatchSettings(): DingTalkDispatchSettings {
  return { agents: {} };
}

export function dingtalkAgentDispatchFor(
  settings: DingTalkDispatchSettings,
  fileName: string,
): DingTalkAgentDispatch {
  return settings.agents[fileName] ?? defaultDingTalkAgentDispatch();
}

/** Enabled is not enough: dispatch needs the section and its Mac-local project. */
export function dingtalkAgentReadyForDispatch(agent: DingTalkAgentDispatch | undefined): boolean {
  return (
    agent?.enabled === true &&
    typeof agent.sectionId === "string" &&
    agent.sectionId.length > 0 &&
    typeof agent.projectId === "string" &&
    agent.projectId.length > 0 &&
    typeof agent.projectPath === "string" &&
    agent.projectPath.length > 0
  );
}

export const dingtalkDispatchEmptyParamsSchema = z.object({}).strict();

export const dingtalkDispatchMessageParamsSchema = z
  .object({
    conversationId: identifierSchema,
    messageId: identifierSchema,
  })
  .strict();
export type DingTalkDispatchMessageParams = z.infer<typeof dingtalkDispatchMessageParamsSchema>;

export const dingtalkDispatchCandidateSchema = z
  .object({
    fileName: codexAgentFileNameSchema,
    name: z.string().min(1).max(256),
    description: z.string().max(4096),
    /** False when the agent is missing its section/project settings. */
    ready: z.boolean(),
  })
  .strict();
export type DingTalkDispatchCandidate = z.infer<typeof dingtalkDispatchCandidateSchema>;

export const dingtalkDispatchScoreEntrySchema = z
  .object({
    agent: dingtalkDispatchCandidateSchema,
    /** Normalized 0–1, or null when scoring failed for this message. */
    score: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type DingTalkDispatchScoreEntry = z.infer<typeof dingtalkDispatchScoreEntrySchema>;

export const dingtalkDispatchScoreResultSchema = z
  .object({
    /** Sorted by score (high to low, null last), then by name. */
    agents: z.array(dingtalkDispatchScoreEntrySchema).max(DINGTALK_DISPATCH_MAX_AGENTS),
    /** True when Gemini failed; scores are all null and the list is by name. */
    failed: z.boolean(),
  })
  .strict();
export type DingTalkDispatchScoreResult = z.infer<typeof dingtalkDispatchScoreResultSchema>;

export const dingtalkDispatchRunParamsSchema = z
  .object({
    conversationId: identifierSchema,
    messageId: identifierSchema,
    agents: z.array(codexAgentFileNameSchema).min(1).max(DINGTALK_DISPATCH_MAX_RUN_AGENTS),
  })
  .strict();
export type DingTalkDispatchRunParams = z.infer<typeof dingtalkDispatchRunParamsSchema>;

export const dingtalkDispatchRunAgentResultSchema = z
  .object({
    fileName: codexAgentFileNameSchema,
    name: z.string().min(1).max(256),
    threadId: z.string().min(1).max(512).nullable(),
    error: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type DingTalkDispatchRunAgentResult = z.infer<typeof dingtalkDispatchRunAgentResultSchema>;

export const dingtalkDispatchRunResultSchema = z
  .object({
    results: z.array(dingtalkDispatchRunAgentResultSchema).max(DINGTALK_DISPATCH_MAX_RUN_AGENTS),
  })
  .strict();
export type DingTalkDispatchRunResult = z.infer<typeof dingtalkDispatchRunResultSchema>;
