import { z } from "zod";

import { jsonValueSchema } from "./json-value.js";

/** Moves a conversation to another Agent on the Host that owns it. */
export const THREAD_AGENT_SWITCH_METHOD = "codexhost/thread/agent/switch";

export const threadAgentSwitchParamsSchema = z
  .object({
    threadId: z.string().min(1).max(1_024),
    /** `codex`, or an external Harness loaded on the same Host. */
    agent: z.string().min(1).max(256),
    /**
     * Desktop `turn/start` input of the person's next request. An external
     * Harness Thread only exists once it has a Turn, so switching to one needs it;
     * switching to Codex does not take it.
     */
    input: z.array(jsonValueSchema).min(1).max(256).optional(),
  })
  .strict();

export type ThreadAgentSwitchParams = z.infer<typeof threadAgentSwitchParamsSchema>;

export const threadAgentSwitchResultSchema = z
  .object({
    /** The conversation's new Thread; the source Thread is archived. */
    threadId: z.string().min(1).max(1_024),
  })
  .strict();

export type ThreadAgentSwitchResult = z.infer<typeof threadAgentSwitchResultSchema>;
