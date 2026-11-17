import { hubAdminParamsSchema, hubResultSchemas } from "@codexhost/shared-contracts";
import { HubAdminError, hubJson } from "./hub-admin-http.js";
import { memhubCredentials } from "./hub-admin-credentials.js";
import { McpHubConnectionStore, mcphubHeaderName } from "./mcphub-connection.js";
import { z } from "zod";
import { runMcpAdmin } from "./mcphub-admin.js";
import { runMemAdmin } from "./memhub-admin.js";

export interface HubAdminServiceOptions {
  fetch?: typeof fetch;
  mcpConnection?: Pick<McpHubConnectionStore, "read" | "write">;
  mcpHeaderName?: () => Promise<string>;
  memoryCredentials?: () => Promise<Record<string, string>>;
}
export class HubAdminService {
  private readonly connection: Pick<McpHubConnectionStore, "read" | "write">;
  constructor(private readonly options: HubAdminServiceOptions = {}) {
    this.connection = options.mcpConnection ?? new McpHubConnectionStore();
  }
  async request(input: unknown): Promise<unknown> {
    const parsed = hubAdminParamsSchema.safeParse(input);
    if (!parsed.success) throw new HubAdminError("invalid");
    const params = parsed.data;
    try {
      const fetcher = this.options.fetch ?? fetch;
      let result: unknown;
      if (params.op === "overview" || params.op === "search" || params.op === "memory") {
        const headers = await (this.options.memoryCredentials ?? memhubCredentials)();
        result = await runMemAdmin(
          (path) => hubJson(fetcher, "http://127.0.0.1:8765", path, headers),
          params,
        );
      } else {
        try {
          const state = (key: string | null) => ({
            configured: key !== null,
            last4: key?.slice(-4) ?? null,
          });
          if (params.op === "mcpConnection") result = state(await this.connection.read());
          else if (params.op === "mcpDisconnect") {
            await this.connection.write(null);
            result = state(null);
          } else {
            const key = params.op === "mcpConnect" ? params.key : await this.connection.read();
            if (!key) throw new HubAdminError("mcp-auth");
            const header = await (this.options.mcpHeaderName ?? mcphubHeaderName)();
            const request = (path: string, method?: string, body?: unknown) =>
              hubJson(
                fetcher,
                "http://127.0.0.1:3000",
                path,
                { [header]: `Bearer ${key}` },
                method,
                body,
              );
            if (params.op === "mcpConnect") {
              // This route is read-only and requires a system-level all-access key.
              z.object({ success: z.literal(true), data: z.array(z.unknown()) }).parse(
                await request("/api/auth/keys"),
              );
              await this.connection.write(key);
              result = state(key);
            } else result = await runMcpAdmin(request, params);
          }
        } catch (error) {
          if (error instanceof HubAdminError && error.code === "forbidden")
            throw new HubAdminError("mcp-auth");
          throw error;
        }
      }
      return hubResultSchemas[params.op].parse(result);
    } catch (error) {
      if (error instanceof HubAdminError) throw error;
      // Upstream validation errors may contain secrets; never propagate or diagnose them.
      throw new HubAdminError("failed");
    }
  }
}
