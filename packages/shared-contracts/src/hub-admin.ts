import { z } from "zod";

export const HUB_ADMIN_METHOD = "codexhost/hub-admin/request";
export const HUB_ERROR_MESSAGES = {
  timeout: "连接超时",
  connection: "连接失败",
  forbidden: "无权限",
  "mcp-auth": "密钥无效或权限不足",
  unavailable: "服务未运行",
  invalid: "请检查输入内容",
  failed: "操作失败",
  missing: "内容不存在",
  conflict: "配置已变化，请刷新后重试",
  connecting: "正在连接 India…",
  retrying: "连接失败，重试中",
} as const;
const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => value !== "." && value !== "..");
const id = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value !== "." && value !== "..");
const pairs = z.record(z.string().min(1).max(200), z.string().max(16000));
export const hubServerInputSchema = z.strictObject({
  name,
  type: z.enum(["streamable-http", "sse", "stdio"]),
  url: z.httpUrl().max(4000).optional(),
  command: z.string().max(4000).optional(),
  args: z.array(z.string().max(4000)).max(100).optional(),
  env: pairs.optional(),
  headers: pairs.optional(),
});
export type HubServerInput = z.infer<typeof hubServerInputSchema>;
export const hubKeyInputSchema = z
  .strictObject({
    name,
    enabled: z.boolean(),
    accessType: z.enum(["all", "exclude", "servers"]),
    servers: z.array(name).max(1000),
  })
  .refine((v) => v.accessType === "all" || v.servers.length > 0);
export type HubKeyInput = z.infer<typeof hubKeyInputSchema>;
const memoryLocator = {
  id,
  kind: z.enum(["chat", "experience", "fact"]),
  variant: z.enum(["working", "coding"]).nullable(),
};
export const hubMcpKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/u);
const mcpConnection = z.strictObject({
  configured: z.boolean(),
  last4: z.string().length(4).nullable(),
});
export const hubAdminParamsSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("mcpOverview") }),
  z.strictObject({ op: z.literal("mcpConnection") }),
  z.strictObject({ op: z.literal("mcpConnect"), key: hubMcpKeySchema }),
  z.strictObject({ op: z.literal("mcpDisconnect"), confirmed: z.literal(true) }),
  z.strictObject({ op: z.literal("servers") }),
  z.strictObject({
    op: z.literal("serverSave"),
    originalName: name.optional(),
    input: hubServerInputSchema,
  }),
  z.strictObject({ op: z.literal("serverDelete"), name, confirmed: z.literal(true) }),
  z
    .strictObject({
      op: z.literal("serverToggle"),
      name,
      enabled: z.boolean(),
      confirmed: z.boolean(),
    })
    .refine((v) => v.enabled || v.confirmed),
  z.strictObject({ op: z.literal("tools"), name }),
  z.strictObject({ op: z.literal("keys") }),
  z.strictObject({ op: z.literal("keySave"), id: id.optional(), input: hubKeyInputSchema }),
  z.strictObject({ op: z.literal("keyDelete"), id, confirmed: z.literal(true) }),
  z.strictObject({ op: z.literal("keyRegenerate"), id, confirmed: z.literal(true) }),
  z
    .strictObject({
      op: z.literal("authSave"),
      enabled: z.boolean(),
      headerName: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/),
      confirmed: z.boolean(),
    })
    .refine((v) => v.enabled || v.confirmed),
  z.strictObject({ op: z.literal("overview") }),
  z.strictObject({
    op: z.literal("search"),
    query: z.string().max(512),
    source: z.string().max(200),
    offset: z.number().int().min(0).max(1000000),
    windowId: z.string().max(64).optional(),
  }),
  z.strictObject({ op: z.literal("memory"), ...memoryLocator }),
]);
export type HubAdminParams = z.infer<typeof hubAdminParamsSchema>;
export type HubOperation = HubAdminParams["op"];
export const hubServerSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  status: z.enum(["online", "offline", "inactive", "disabled"]),
  type: z.string(),
  tools: z.number(),
  prompts: z.number(),
  resources: z.number(),
  calls: z.number().nullable(),
});
export type HubServer = z.infer<typeof hubServerSchema>;
export const hubKeySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  masked: z.string(),
  enabled: z.boolean(),
  accessType: z.string(),
  servers: z.array(z.string()),
  groups: z.array(z.string()),
  kind: z.string(),
});
export type HubKey = z.infer<typeof hubKeySchema>;
export const hubMemorySchema = z.strictObject({
  ...memoryLocator,
  title: z.string(),
  text: z.string(),
  source: z.string(),
  time: z.number().nullable(),
  conversation: z.string().nullable(),
});
export type HubMemory = z.infer<typeof hubMemorySchema>;
const saved = z.strictObject({ ok: z.literal(true), token: z.string().optional() });
export const hubResultSchemas = {
  mcpOverview: z.strictObject({
    configured: z.boolean(),
    last4: z.string().length(4).nullable(),
    servers: z.array(hubServerSchema).nullable(),
    keys: z
      .strictObject({
        enabled: z.boolean(),
        headerName: z.string(),
        keys: z.array(hubKeySchema),
      })
      .nullable(),
  }),
  mcpConnection,
  mcpConnect: mcpConnection,
  mcpDisconnect: mcpConnection,
  servers: z.strictObject({ servers: z.array(hubServerSchema) }),
  serverSave: saved,
  serverDelete: saved,
  serverToggle: saved,
  tools: z.strictObject({
    tools: z.array(z.strictObject({ name: z.string(), description: z.string() })),
  }),
  keys: z.strictObject({
    enabled: z.boolean(),
    headerName: z.string(),
    keys: z.array(hubKeySchema),
  }),
  keySave: saved,
  keyDelete: saved,
  keyRegenerate: saved,
  authSave: saved,
  overview: z.strictObject({
    total: z.number(),
    consolidation: z.enum(["idle", "running", "blocked", "waiting"]),
    updatedAt: z.number().nullable(),
    recent: z.array(hubMemorySchema),
    sources: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  }),
  search: z.strictObject({
    total: z.number(),
    offset: z.number(),
    windowId: z.string().nullable(),
    memories: z.array(hubMemorySchema),
  }),
  memory: hubMemorySchema,
};
export type HubResult<O extends HubOperation> = z.infer<(typeof hubResultSchemas)[O]>;
