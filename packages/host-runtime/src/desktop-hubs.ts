import type { JsonRpcRequest, JsonValue } from "@codexhost/protocol-core";
import { HUB_ADMIN_METHOD, SKILLS_HUB_METHOD, jsonValueSchema } from "@codexhost/shared-contracts";
import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import { HubAdminError } from "./hub-admin-http.js";
import type { HubAdminService } from "./hub-admin-service.js";
import { getSkillsHub, skillsError, type SkillsHubService } from "./skills-hub/service.js";

export interface DesktopHubServices {
  skills?: Pick<SkillsHubService, "request">;
  admin?: Pick<HubAdminService, "request">;
}

export function isDesktopHubMethod(method: string): boolean {
  return method === SKILLS_HUB_METHOD || method.startsWith("codexhost/hub-admin/");
}

export async function handleDesktopHubRequest(
  request: JsonRpcRequest,
  desktop: boolean,
  environment: NodeJS.ProcessEnv,
  services?: DesktopHubServices,
): Promise<JsonValue> {
  const skills = request.method === SKILLS_HUB_METHOD;
  const admin = request.method === HUB_ADMIN_METHOD;
  if (!desktop || (!skills && (!admin || !services?.admin)))
    return rpcError(request, -32601, "Method is unavailable on this Host");

  try {
    const service = skills ? (services?.skills ?? getSkillsHub(environment)) : services?.admin;
    const result = jsonValueSchema.parse(await service?.request(request.params));
    return rpcEnvelope(request, { result });
  } catch (error) {
    return rpcError(
      request,
      -32096,
      skills ? skillsError(error) : error instanceof HubAdminError ? error.code : "failed",
    );
  }
}
