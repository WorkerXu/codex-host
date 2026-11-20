import { hubMcpKeySchema } from "@codexhost/shared-contracts";
import { z } from "zod";
import { HubAdminError } from "./hub-admin-http.js";

/** The credential is scoped to the Host process. */
export class McpHubConnectionStore {
  #key: string | null = null;

  read(): string | null {
    return this.#key;
  }

  write(key: string | null): void {
    const parsed = hubMcpKeySchema.nullable().safeParse(key);
    if (!parsed.success) throw new HubAdminError("invalid");
    this.#key = parsed.data;
  }
}

export interface McpHubRouting {
  enableBearerAuth?: boolean | undefined;
  skipAuth?: boolean | undefined;
  bearerAuthHeaderName?: string | undefined;
}
/** Routing policy only; never derive a credential from MCPHub's users or keys. */
export function headerNameFromRouting(routing: McpHubRouting): string {
  // Anonymous dashboard access cannot prove that the presented key is valid.
  if (routing.enableBearerAuth === false || routing.skipAuth) throw new HubAdminError("mcp-auth");
  return z
    .string()
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u)
    .parse(routing.bearerAuthHeaderName?.trim() || "Authorization");
}
