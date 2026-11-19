import {
  HUB_ADMIN_METHOD,
  HUB_ERROR_MESSAGES,
  hubAdminParamsSchema,
  hubResultSchemas,
  type HubAdminParams,
  type HubOperation,
  type HubResult,
} from "@codexhost/shared-contracts";

export interface HubHost {
  hostId: string;
  displayName: string;
}
export interface RendererHubAdminClient {
  hosts(): Promise<HubHost[]>;
  request<O extends HubOperation>(
    hostId: string,
    input: Extract<HubAdminParams, { op: O }>,
  ): Promise<HubResult<O>>;
}
export function hubErrorText(error: unknown): string {
  const code = (error as { message?: string } | null)?.message;
  return code && Object.hasOwn(HUB_ERROR_MESSAGES, code)
    ? HUB_ERROR_MESSAGES[code as keyof typeof HUB_ERROR_MESSAGES]
    : "连接失败";
}
export function createRendererHubAdminClient(options: {
  forHost(hostId: string): {
    manager: {
      sendRequest(
        method: string,
        params: unknown,
        options: { priority: "interactive"; timeoutMs: number },
      ): unknown;
    };
  } | null;
  listHosts(): Promise<HubHost[]>;
}): RendererHubAdminClient {
  return {
    hosts: () => options.listHosts(),
    async request<O extends HubOperation>(
      hostId: string,
      input: Extract<HubAdminParams, { op: O }>,
    ): Promise<HubResult<O>> {
      const parsed = hubAdminParamsSchema.safeParse(input);
      if (!parsed.success) throw new Error("invalid");
      const params = parsed.data;
      const route = options.forHost(hostId);
      if (!route) throw new Error("connection");
      const value = await route.manager.sendRequest(HUB_ADMIN_METHOD, params, {
        priority: "interactive",
        timeoutMs: 30000,
      });
      return hubResultSchemas[params.op].parse(value) as HubResult<O>;
    },
  };
}
