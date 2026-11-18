import { z } from "zod";

import { codexAgentFileNameSchema } from "./codex-agents.js";

/**
 * Settings for a DingTalk listener and dispatcher that runs on the local Host.
 * This contract only persists the user's choices; the listener and dispatcher
 * runtime live outside this branch and read the same file.
 *
 * Listening is configured per agent, keyed by the agent's file name so a
 * rename keeps the choice. An agent without a map entry is off.
 *
 * Approval events are never changed by an agent: a dispatched agent performs
 * the work described in its own `developer_instructions` (checking, preparing
 * material, recommending a conclusion), but it must not call approve, reject,
 * revoke or any other command that changes approval state. Only the user
 * decides the outcome.
 */
export const DINGTALK_DISPATCH_GET_METHOD = "codexhost/dingtalk-dispatch/get";
export const DINGTALK_DISPATCH_SET_METHOD = "codexhost/dingtalk-dispatch/set";
export const DINGTALK_DISPATCH_STATUS_METHOD = "codexhost/dingtalk-dispatch/status";

export const DINGTALK_EVENT_TYPES = [
  "mention_me",
  "mention_all",
  "approval_pending",
  "direct_message",
] as const;
export type DingTalkEventType = (typeof DINGTALK_EVENT_TYPES)[number];

export const DINGTALK_REPLY_SCOPES = ["group", "direct"] as const;
export type DingTalkReplyScope = (typeof DINGTALK_REPLY_SCOPES)[number];

export const DEFAULT_DINGTALK_MATCH_THRESHOLD = 0.7;
export const DINGTALK_DISPATCH_MAX_AGENTS = 512;

const eventTypesSchema = z
  .array(z.enum(DINGTALK_EVENT_TYPES))
  .max(8)
  .refine((values) => new Set(values).size === values.length, {
    message: "Event types must not repeat",
  });

export const dingtalkAgentDispatchSchema = z
  .object({
    enabled: z.boolean(),
    eventTypes: eventTypesSchema,
    /** Reply in the originating group (default) or in a direct message. */
    replyScope: z.enum(DINGTALK_REPLY_SCOPES),
  })
  .strict();

export type DingTalkAgentDispatch = z.infer<typeof dingtalkAgentDispatchSchema>;

export const dingtalkDispatchSettingsSchema = z
  .object({
    /** Every agent scoring at or above this threshold receives the task. */
    threshold: z.number().min(0).max(1),
    /** Keyed by `fileName`; a missing key means the agent does not listen. */
    agents: z
      .record(codexAgentFileNameSchema, dingtalkAgentDispatchSchema)
      .refine((agents) => Object.keys(agents).length <= DINGTALK_DISPATCH_MAX_AGENTS, {
        message: "Too many agents",
      }),
  })
  .strict();

export type DingTalkDispatchSettings = z.infer<typeof dingtalkDispatchSettingsSchema>;

export const DINGTALK_DISPATCH_RESULTS = ["replied", "failed", "skipped"] as const;
export type DingTalkDispatchResult = (typeof DINGTALK_DISPATCH_RESULTS)[number];

export const dingtalkDispatchAgentStatusSchema = z
  .object({
    lastDispatchAt: z.number().int().nonnegative(),
    result: z.enum(DINGTALK_DISPATCH_RESULTS),
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

export const DEFAULT_DINGTALK_DISPATCH_SETTINGS: DingTalkDispatchSettings = {
  threshold: DEFAULT_DINGTALK_MATCH_THRESHOLD,
  agents: {},
};

/** A newly configured agent listens to every event type and replies in the group. */
export function defaultDingTalkAgentDispatch(): DingTalkAgentDispatch {
  return {
    enabled: false,
    eventTypes: [...DINGTALK_EVENT_TYPES],
    replyScope: "group",
  };
}

export function defaultDingTalkDispatchSettings(): DingTalkDispatchSettings {
  return { threshold: DEFAULT_DINGTALK_MATCH_THRESHOLD, agents: {} };
}

export function dingtalkAgentDispatchFor(
  settings: DingTalkDispatchSettings,
  fileName: string,
): DingTalkAgentDispatch {
  return settings.agents[fileName] ?? defaultDingTalkAgentDispatch();
}

export interface DingTalkDispatchTarget {
  fileName: string;
  replyScope: DingTalkReplyScope;
}

/**
 * Agents that listen to one event type. A dispatcher must use this instead of
 * a global switch: event types and reply scope are per agent.
 */
export function dingtalkDispatchTargets(
  settings: DingTalkDispatchSettings,
  eventType: DingTalkEventType,
): DingTalkDispatchTarget[] {
  return Object.entries(settings.agents)
    .filter(([, agent]) => agent.enabled && agent.eventTypes.includes(eventType))
    .map(([fileName, agent]) => ({ fileName, replyScope: agent.replyScope }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

export const dingtalkDispatchEmptyParamsSchema = z.object({}).strict();

export const DINGTALK_DISPATCH_PROJECT_METHOD = "codexhost/dingtalk-dispatch/prepare-project";
export const DINGTALK_DISPATCH_PROJECT_READY_METHOD = "codexhost/dingtalk-dispatch/project-ready";
export const dingtalkDispatchProjectSchema = z.strictObject({
  requestId: z.string().uuid(),
  cwd: z.string().min(1).max(4096),
});
export const dingtalkDispatchProjectReadySchema = z.strictObject({
  requestId: z.string().uuid(),
  error: z.string().max(2000).nullable(),
});
