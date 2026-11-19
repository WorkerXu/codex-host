import { hubAdminParamsSchema, hubResultSchemas } from "@codexhost/shared-contracts";
import { HubAdminError, hubJson } from "./hub-admin-http.js";
import { McpHubConnectionStore } from "./mcphub-connection.js";
import { HubRemote } from "./hub-remote.js";
import { z } from "zod";
import { runMcpAdmin } from "./mcphub-admin.js";
import { runMemAdmin } from "./memhub-admin.js";

type Remote = Pick<HubRemote, "endpoints" | "token" | "forgetToken" | "mcphubHeaderName" | "stop">;
export interface HubAdminServiceOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  mcpConnection?: Pick<McpHubConnectionStore, "read" | "write">;
  mcpHeaderName?: () => Promise<string>;
  memoryToken?: () => Promise<string>;
  forgetMemoryToken?: () => Promise<void>;
  remote?: Remote;
}
export class HubAdminService {
  private readonly connection: Pick<McpHubConnectionStore, "read" | "write">;
  private readonly remote: Remote;
  constructor(private readonly options: HubAdminServiceOptions = {}) {
    this.connection = options.mcpConnection ?? new McpHubConnectionStore(options);
    this.remote = options.remote ?? new HubRemote(options.environment ?? process.env);
  }
  async stop(): Promise<void> {
    await this.remote.stop();
  }
  async request(input: unknown): Promise<unknown> {
    const parsed = hubAdminParamsSchema.safeParse(input);
    if (!parsed.success) throw new HubAdminError("invalid");
    const params = parsed.data;
    try {
      const fetcher = this.options.fetch ?? fetch;
      let result: unknown;
      if (params.op === "overview" || params.op === "search" || params.op === "memory") {
        const endpoints = await this.remote.endpoints();
        result = await this.#memory(fetcher, endpoints.memhub, params);
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
            if (params.op === "mcpOverview") {
              const endpoints = await this.remote.endpoints();
              const header = await (this.options.mcpHeaderName ?? (() => this.#header()))();
              const request = (path: string, method?: string, body?: unknown) =>
                hubJson(
                  fetcher,
                  endpoints.mcphub,
                  path,
                  { [header]: `Bearer ${key}` },
                  method,
                  body,
                );
              const [servers, keys] = await Promise.all([
                runMcpAdmin(request, { op: "servers" }),
                runMcpAdmin(request, { op: "keys" }),
              ]);
              result = {
                ...state(key),
                servers: (servers as { servers: unknown[] }).servers,
                keys,
              };
            } else {
              const endpoints = await this.remote.endpoints();
              const header = await (this.options.mcpHeaderName ?? (() => this.#header()))();
              const request = (path: string, method?: string, body?: unknown) =>
                hubJson(
                  fetcher,
                  endpoints.mcphub,
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
  async #header(): Promise<string> {
    return this.remote.mcphubHeaderName();
  }
  async #memory(
    fetcher: typeof fetch,
    base: string,
    params: Parameters<typeof runMemAdmin>[1],
  ): Promise<unknown> {
    const run = async () => {
      const token = await (this.options.memoryToken ?? (() => this.remote.token()))();
      return runMemAdmin(
        (path) => hubJson(fetcher, base, path, { Authorization: `Bearer ${token}` }),
        params,
      );
    };
    try {
      return await run();
    } catch (error) {
      // A rotated token is the one failure worth retrying without user action.
      if (!(error instanceof HubAdminError) || error.code !== "forbidden") throw error;
      await (this.options.forgetMemoryToken ?? (() => this.remote.forgetToken()))();
      return run();
    }
  }
}
