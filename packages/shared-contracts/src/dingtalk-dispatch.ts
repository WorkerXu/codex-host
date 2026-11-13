import { z } from "zod";

import { CODEX_AGENT_NAME_PATTERN, isCodexAgentName } from "./codex-agents.js";

/**
 * Settings for a DingTalk listener and dispatcher that runs on the local Host.
 * This contract only persists the user's choices; the listener and dispatcher
 * runtime live outside this branch and read the same file.
 *
 * Approval events are never changed by an agent: a dispatched agent performs
 * the work described in its own `developer_instructions` (checking, preparing
 * material, recommending a conclusion), but it must not call approve, reject,
 * revoke or any other command that changes approval state. Only the user
 * decides the outcome.
 */
export const DINGTALK_DISPATCH_GET_METHOD = "codexhost/dingtalk-dispatch/get";
export const DINGTALK_DISPATCH_SET_METHOD = "codexhost/dingtalk-dispatch/set";

export const DINGTALK_EVENT_TYPES = ["mention_me", "mention_all", "approval_pending"] as const;
export type DingTalkEventType = (typeof DINGTALK_EVENT_TYPES)[number];

export const DINGTALK_REPLY_SCOPES = ["group", "direct"] as const;
export type DingTalkReplyScope = (typeof DINGTALK_REPLY_SCOPES)[number];

export const DEFAULT_DINGTALK_MATCH_THRESHOLD = 0.85;

const eventTypesSchema = z
  .array(z.enum(DINGTALK_EVENT_TYPES))
  .max(8)
  .refine((values) => new Set(values).size === values.length, {
    message: "Event types must not repeat",
  });

const participatingAgentsSchema = z
  .array(z.string().regex(CODEX_AGENT_NAME_PATTERN, "Invalid agent name"))
  .max(512)
  .refine((values) => new Set(values).size === values.length, {
    message: "Agents must not repeat",
  });

export const dingtalkDispatchSettingsSchema = z
  .object({
    enabled: z.boolean(),
    eventTypes: eventTypesSchema,
    /** Every agent scoring at or above this threshold receives the task. */
    matchThreshold: z.number().min(0).max(1),
    /** Reply in the originating group (default) or in a direct message. */
    replyScope: z.enum(DINGTALK_REPLY_SCOPES),
    /** Agents opted in; a missing file means every agent with a description. */
    participatingAgents: participatingAgentsSchema,
  })
  .strict();

export type DingTalkDispatchSettings = z.infer<typeof dingtalkDispatchSettingsSchema>;

export const DEFAULT_DINGTALK_DISPATCH_SETTINGS: Omit<
  DingTalkDispatchSettings,
  "participatingAgents"
> = {
  enabled: false,
  eventTypes: [...DINGTALK_EVENT_TYPES],
  matchThreshold: DEFAULT_DINGTALK_MATCH_THRESHOLD,
  replyScope: "group",
};

export const dingtalkDispatchEmptyParamsSchema = z.object({}).strict();

export function defaultDingTalkDispatchSettings(
  participatingAgents: readonly string[],
): DingTalkDispatchSettings {
  return {
    ...DEFAULT_DINGTALK_DISPATCH_SETTINGS,
    eventTypes: [...DINGTALK_EVENT_TYPES],
    participatingAgents: [...new Set(participatingAgents.filter(isCodexAgentName))].slice(0, 512),
  };
}
