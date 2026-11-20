import {
  DINGTALK_DISPATCH_RUN_METHOD,
  DINGTALK_DISPATCH_SCORE_METHOD,
  dingtalkDispatchRunResultSchema,
  dingtalkDispatchScoreResultSchema,
  type DingTalkDispatchRunResult,
  type DingTalkDispatchScoreResult,
} from "@codexhost/shared-contracts";

export interface RendererDingTalkDispatchManager {
  sendRequest(
    method: string,
    params: unknown,
    options?: { priority?: "background" | "interactive"; timeoutMs?: number },
  ): Promise<unknown> | unknown;
}

/** Dispatch always runs on the desktop Host that owns the agents. */
export interface RendererDingTalkDispatchClientOptions {
  manager(): RendererDingTalkDispatchManager | null;
}

export interface RendererDingTalkDispatchClient {
  available(): boolean;
  /** One Gemini decision request for all enabled agents, from the message text. */
  score(conversationId: string, messageId: string): Promise<DingTalkDispatchScoreResult>;
  /** Starts the existing dispatch flow once per selected agent. */
  run(
    conversationId: string,
    messageId: string,
    agents: readonly string[],
  ): Promise<DingTalkDispatchRunResult>;
}

export function createRendererDingTalkDispatchClient(
  options: RendererDingTalkDispatchClientOptions,
): RendererDingTalkDispatchClient {
  const request = async (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
    const manager = options.manager();
    if (!manager) throw new Error("dispatch_unavailable");
    return await manager.sendRequest(method, params, { priority: "interactive", timeoutMs });
  };
  return {
    available: () => options.manager() !== null,
    async score(conversationId, messageId) {
      return dingtalkDispatchScoreResultSchema.parse(
        await request(DINGTALK_DISPATCH_SCORE_METHOD, { conversationId, messageId }, 20_000),
      );
    },
    async run(conversationId, messageId, agents) {
      return dingtalkDispatchRunResultSchema.parse(
        await request(
          DINGTALK_DISPATCH_RUN_METHOD,
          { conversationId, messageId, agents: [...new Set(agents)] },
          60_000,
        ),
      );
    },
  };
}
