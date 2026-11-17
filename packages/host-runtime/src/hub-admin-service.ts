import { hubAdminParamsSchema, hubResultSchemas } from "@codexhost/shared-contracts";
import { HubAdminError, hubJson } from "./hub-admin-http.js";
import { mcphubCredentials, memhubCredentials } from "./hub-admin-credentials.js";
import { runMcpAdmin } from "./mcphub-admin.js";
import { runMemAdmin } from "./memhub-admin.js";

export interface HubAdminServiceOptions {
  fetch?: typeof fetch;
  mcpCredentials?: () => Promise<Record<string, string>>;
  memoryCredentials?: () => Promise<Record<string, string>>;
}
export class HubAdminService {
  constructor(private readonly options: HubAdminServiceOptions = {}) {}
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
        const headers = await (this.options.mcpCredentials ?? mcphubCredentials)();
        result = await runMcpAdmin(
          (path, method, body) =>
            hubJson(fetcher, "http://127.0.0.1:3000", path, headers, method, body),
          params,
        );
      }
      return hubResultSchemas[params.op].parse(result);
    } catch (error) {
      if (error instanceof HubAdminError) throw error;
      // Upstream validation errors may contain secrets; never propagate or diagnose them.
      throw new HubAdminError("failed");
    }
  }
}
