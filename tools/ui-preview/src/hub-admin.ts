import type {
  HubAdminParams,
  HubMemory,
  HubOperation,
  HubResult,
  HubServer,
  HubKey,
} from "@codexhost/shared-contracts";
import type { RendererHubAdminClient } from "../../../packages/renderer-extension/src/renderer-hub-admin-client.js";

const memory = (index: number): HubMemory => ({
  id: `memory-${index}`,
  kind: "chat",
  variant: null,
  title: ["项目构建与测试约定", "界面使用偏好", "服务连接方式", "工作区说明"][index % 4]!,
  text: "项目使用 TypeScript 与 Rust。修改后先运行聚焦测试，再检查构建与包边界。界面沿用现有设置页的布局，保持简洁清晰。",
  source: index % 2 ? "claude" : "codex",
  time: 1794886200 - index * 3600,
  conversation: `session-${index}`,
});
export function createHubPreviewClient(error = false): RendererHubAdminClient {
  let servers: HubServer[] = [
    {
      name: "文档搜索",
      version: "1.4.2",
      status: "online",
      type: "streamable-http",
      tools: 12,
      prompts: 2,
      resources: 3,
      calls: null,
    },
    {
      name: "代码仓库",
      version: "2.1.0",
      status: "online",
      type: "stdio",
      tools: 8,
      prompts: 0,
      resources: 1,
      calls: null,
    },
    {
      name: "网页检索",
      version: "1.0.0",
      status: "offline",
      type: "sse",
      tools: 4,
      prompts: 0,
      resources: 0,
      calls: null,
    },
    {
      name: "本地文件",
      version: "—",
      status: "inactive",
      type: "stdio",
      tools: 0,
      prompts: 0,
      resources: 0,
      calls: null,
    },
    {
      name: "归档服务",
      version: "1.0.0",
      status: "disabled",
      type: "streamable-http",
      tools: 3,
      prompts: 1,
      resources: 0,
      calls: null,
    },
  ];
  let keys: HubKey[] = [
    {
      id: "key-1",
      name: "工作助手",
      masked: "••••••••",
      enabled: true,
      accessType: "all",
      servers: [],
      groups: [],
      kind: "system",
    },
    {
      id: "key-2",
      name: "只读检索",
      masked: "••••••••",
      enabled: true,
      accessType: "servers",
      servers: ["文档搜索", "网页检索"],
      groups: [],
      kind: "system",
    },
  ];
  let enabled = true;
  let headerName = "Authorization";
  return {
    hosts: async () => [
      { hostId: "india", displayName: "india" },
      { hostId: "oracle-main", displayName: "oracle-main" },
    ],
    async request<O extends HubOperation>(
      _host: string,
      input: Extract<HubAdminParams, { op: O }>,
    ): Promise<HubResult<O>> {
      if (error) throw new Error("forbidden");
      const params: HubAdminParams = input;
      let result: unknown = { ok: true };
      switch (params.op) {
        case "servers":
          result = { servers: structuredClone(servers) };
          break;
        case "keys":
          result = { enabled, headerName, keys: structuredClone(keys) };
          break;
        case "serverSave":
          servers = servers.filter((server) => server.name !== params.originalName);
          servers.push({
            ...servers[0]!,
            name: params.input.name,
            type: params.input.type,
            status: "inactive",
          });
          break;
        case "serverDelete":
          servers = servers.filter((server) => server.name !== params.name);
          break;
        case "serverToggle":
          servers = servers.map((server) =>
            server.name === params.name
              ? { ...server, status: params.enabled ? "online" : "disabled" }
              : server,
          );
          break;
        case "tools":
          result = {
            tools: [
              {
                name: "search_documents",
                description: "按关键词检索项目文档，返回匹配片段及来源。",
              },
              { name: "read_document", description: "读取指定文档的完整内容。" },
              { name: "list_collections", description: "列出可用的文档集合。" },
            ],
          };
          break;
        case "keySave":
          if (!params.id) result = { ok: true, token: "mcphub_preview_only_not_a_real_key" };
          break;
        case "keyRegenerate":
          result = { ok: true, token: "mcphub_preview_only_not_a_real_key" };
          break;
        case "keyDelete":
          keys = keys.filter((key) => key.id !== params.id);
          break;
        case "authSave":
          enabled = params.enabled;
          headerName = params.headerName;
          break;
        case "overview":
          result = {
            total: 128,
            consolidation: "running",
            updatedAt: 1794886200,
            recent: [0, 1, 2].map(memory),
            sources: [
              { id: "codex", label: "Codex" },
              { id: "claude", label: "Claude Code" },
            ],
          };
          break;
        case "search": {
          let values = Array.from({ length: 23 }, (_, index) => memory(index));
          if (params.source) values = values.filter((value) => value.source === params.source);
          if (params.query) values = values.filter((value) => value.title.includes(params.query));
          result = {
            total: values.length,
            offset: params.offset,
            windowId: params.query ? "window-preview" : null,
            memories: values.slice(params.offset, params.offset + 10),
          };
          break;
        }
        case "memory":
          result = {
            ...memory(Number(params.id.split("-")[1]) || 0),
            text: `${memory(0).text}\n\n测试约定\n运行与改动面匹配的测试，确认构建结果和类型检查。\n\n保留每条记忆的来源和对话引用，方便回看。`,
          };
          break;
      }
      return result as HubResult<O>;
    },
  };
}
