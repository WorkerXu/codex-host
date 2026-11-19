import { z } from "zod";
import type { HubAdminParams, HubServer, HubKey } from "@codexhost/shared-contracts";
import { HubAdminError } from "./hub-admin-http.js";

export type McpRequest = (path: string, method?: string, body?: unknown) => Promise<unknown>;
const object = z.record(z.string(), z.unknown());
const response = z.object({ success: z.boolean(), data: z.unknown().optional() });
const configSchema = z
  .object({ enabled: z.boolean().optional(), type: z.string().optional() })
  .passthrough();
const serverSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  status: z.string(),
  enabled: z.boolean().optional(),
  config: configSchema,
  tools: z.array(object).default([]),
  prompts: z.array(object).default([]),
  resources: z.array(object).default([]),
});
const keySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  kind: z.string().default("system"),
  accessType: z.string(),
  allowedServers: z.array(z.string()).default([]),
  excludedServers: z.array(z.string()).default([]),
  allowedGroups: z.array(z.string()).default([]),
  excludedGroups: z.array(z.string()).default([]),
});
async function data(request: McpRequest, path: string, method?: string, body?: unknown) {
  const value = response.parse(await request(path, method, body));
  if (!value.success) throw new HubAdminError("failed");
  return value.data;
}
export async function runMcpAdmin(request: McpRequest, params: HubAdminParams): Promise<unknown> {
  const segment = (value: string) => encodeURIComponent(value);
  switch (params.op) {
    case "servers": {
      const servers: HubServer[] = z
        .array(serverSchema)
        .parse(await data(request, "/api/servers"))
        .map((server) => ({
          name: server.name,
          version: server.version ?? "—",
          type: server.config.type ?? "unknown",
          status:
            server.enabled === false
              ? "disabled"
              : server.status === "connected"
                ? "online"
                : ["connecting", "idle", "not_initialized"].includes(server.status)
                  ? "inactive"
                  : "offline",
          tools: server.tools.length,
          prompts: server.prompts.length,
          resources: server.resources.length,
          calls: null,
        }));
      return { servers };
    }
    case "tools": {
      const value = z
        .object({
          tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
        })
        .parse(await data(request, `/api/servers/${segment(params.name)}`));
      return {
        tools: value.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
        })),
      };
    }
    case "serverSave": {
      const { name, ...input } = params.input;
      let config: Record<string, unknown> = input;
      if (params.originalName) {
        const original = z
          .object({ config: object })
          .parse(await data(request, `/api/servers/${segment(params.originalName)}`)).config;
        // Preserve native options and secrets the renderer never receives.
        config = { ...original, ...input };
        if (input.type !== original.type) {
          const removed = input.type === "stdio" ? ["url", "headers"] : ["command", "args", "env"];
          config = Object.fromEntries(
            Object.entries(config).filter(([field]) => !removed.includes(field)),
          );
        }
      }
      if (input.type === "stdio" ? !String(config.command ?? "").trim() : !config.url)
        throw new HubAdminError("invalid");
      await data(
        request,
        params.originalName ? `/api/servers/${segment(params.originalName)}` : "/api/servers",
        params.originalName ? "PUT" : "POST",
        params.originalName ? { newName: name, config } : { name, config },
      );
      return { ok: true };
    }
    case "serverToggle":
      await data(request, `/api/servers/${segment(params.name)}/toggle`, "POST", {
        enabled: params.enabled,
      });
      return { ok: true };
    case "serverDelete":
      await data(request, `/api/servers/${segment(params.name)}`, "DELETE");
      return { ok: true };
    case "keys": {
      const keys: HubKey[] = z
        .array(keySchema)
        .parse(await data(request, "/api/auth/keys"))
        .map((key) => ({
          id: key.id,
          name: key.name,
          enabled: key.enabled,
          kind: key.kind,
          accessType: key.accessType,
          masked: "••••••••",
          servers: key.accessType === "exclude" ? key.excludedServers : key.allowedServers,
          groups: key.accessType === "exclude" ? key.excludedGroups : key.allowedGroups,
        }));
      const settings = z
        .object({
          systemConfig: z
            .object({
              routing: z
                .object({
                  enableBearerAuth: z.boolean().optional(),
                  bearerAuthHeaderName: z.string().optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .parse(await data(request, "/api/settings"));
      return {
        keys,
        enabled: settings.systemConfig?.routing?.enableBearerAuth ?? true,
        headerName: settings.systemConfig?.routing?.bearerAuthHeaderName ?? "Authorization",
      };
    }
    case "keySave": {
      if (params.id) {
        const keys = z.array(keySchema).parse(await data(request, "/api/auth/keys"));
        const key = keys.find((key) => key.id === params.id);
        if (!key) throw new HubAdminError("missing");
        // The compact editor cannot represent native group/user scopes.
        if (
          key.kind === "user" ||
          key.allowedGroups.length ||
          key.excludedGroups.length ||
          !["all", "exclude", "servers"].includes(key.accessType)
        )
          throw new HubAdminError("conflict");
      }
      const { servers, ...input } = params.input;
      const value = await data(
        request,
        params.id ? `/api/auth/keys/${segment(params.id)}` : "/api/auth/keys",
        params.id ? "PUT" : "POST",
        {
          ...input,
          allowedServers: input.accessType === "servers" ? servers : [],
          excludedServers: input.accessType === "exclude" ? servers : [],
          allowedGroups: [],
          excludedGroups: [],
        },
      );
      return params.id
        ? { ok: true }
        : { ok: true, token: z.object({ token: z.string().min(1) }).parse(value).token };
    }
    case "keyRegenerate": {
      const value = await data(request, `/api/auth/keys/${segment(params.id)}/reset`, "POST");
      return { ok: true, token: z.object({ token: z.string().min(1) }).parse(value).token };
    }
    case "keyDelete":
      await data(request, `/api/auth/keys/${segment(params.id)}`, "DELETE");
      return { ok: true };
    case "authSave":
      await data(request, "/api/system-config", "PUT", {
        routing: { enableBearerAuth: params.enabled, bearerAuthHeaderName: params.headerName },
      });
      return { ok: true };
    default:
      throw new HubAdminError("invalid");
  }
}
