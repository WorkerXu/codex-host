import { z } from "zod";
import { runDwsRaw } from "./dingtalk-cli.js";
import { downloadDingTalkMedia } from "./dingtalk-media.js";
import { DelegationControlError } from "./delegation-types.js";

export const DINGTALK_DWS_PEER_ROUTE = "/v1/dingtalk/dws";
export const DINGTALK_MEDIA_PEER_ROUTE = "/v1/dingtalk/media";

const dwsParams = z.object({ args: z.array(z.string()).min(1) }).strict();
const id = z.string().min(1).max(4096);
const mediaParams = z
  .object({
    conversationId: id,
    messageId: id,
    resourceId: id,
    resourceIdType: id,
  })
  .strict();

export function isDingTalkPeerRoute(route: string | undefined) {
  return route === DINGTALK_DWS_PEER_ROUTE || route === DINGTALK_MEDIA_PEER_ROUTE;
}

export async function handleDingTalkPeerRoute(
  environment: NodeJS.ProcessEnv,
  route: typeof DINGTALK_DWS_PEER_ROUTE | typeof DINGTALK_MEDIA_PEER_ROUTE,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (route === DINGTALK_DWS_PEER_ROUTE) {
    const parsed = dwsParams.safeParse(body);
    if (!parsed.success)
      throw new DelegationControlError("INVALID_ARGUMENT", "Invalid dws arguments");
    return await runDwsRaw(parsed.data.args, { environment, timeoutMs: 60_000 });
  }
  const parsed = mediaParams.safeParse(body);
  if (!parsed.success)
    throw new DelegationControlError("INVALID_ARGUMENT", "Invalid DingTalk media reference");
  return await downloadDingTalkMedia({ environment, request: parsed.data });
}
