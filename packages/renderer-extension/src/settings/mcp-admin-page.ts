import type { HubKey, HubServer, HubResult } from "@codexhost/shared-contracts";
import type { RendererHubAdminClient } from "../renderer-hub-admin-client.js";
import type { RendererSettingsPageDefinition } from "./core.js";
import { createHubPage, hubButton, hubElement, hubField } from "./hub-admin-ui.js";
import { mcpDialogs } from "./mcp-admin-dialogs.js";

export interface HubAdminPageOptions {
  createClient(): RendererHubAdminClient | null;
}
const statuses = { online: "在线", offline: "离线", inactive: "未激活", disabled: "禁用" };
export function createMcpAdminPage(
  options: HubAdminPageOptions,
  label = "MCP 服务器",
): RendererSettingsPageDefinition {
  return Object.freeze<RendererSettingsPageDefinition>({
    id: "mcp-servers",
    label,
    icon: "connections",
    mount(context) {
      const client = options.createClient();
      const ui = createHubPage(context, label, "india", client);
      if (!client) {
        ui.status.textContent = "连接失败";
        return;
      }
      const document = ui.document;
      let servers: HubServer[] = [];
      let keys: HubResult<"keys"> = { enabled: true, headerName: "Authorization", keys: [] };
      let query = "";
      let filter = "all";
      const refresh = async () => {
        const host = ui.hosts.value;
        const revision = ui.revision();
        if (!host) return;
        await ui.load(async () => {
          const [serverResult, keyResult] = await Promise.all([
            client.request(host, { op: "servers" }),
            client.request(host, { op: "keys" }),
          ]);
          if (!ui.valid(host, revision)) return;
          servers = serverResult.servers;
          keys = keyResult;
          render();
        });
      };
      const dialogs = mcpDialogs(ui, client, refresh, () => servers);
      const list = hubElement(document, "div", "hub-server-list");
      const renderServers = () => {
        list.replaceChildren();
        const visible = servers.filter(
          (server) =>
            server.name.toLowerCase().includes(query.toLowerCase()) &&
            (filter === "all" || server.status === filter),
        );
        for (const server of visible) {
          const card = hubElement(document, "article", "hub-server");
          const top = hubElement(document, "div", "hub-row");
          const name = hubElement(document, "strong", "", server.name);
          const status = hubElement(document, "span", "hub-badge", statuses[server.status]);
          status.dataset.status = server.status;
          top.append(name, hubElement(document, "span", "hub-muted", server.version), status);
          const toggle = hubButton(document, server.status === "disabled" ? "启用" : "禁用", () => {
            const host = ui.hosts.value;
            const enabled = server.status === "disabled";
            const action = async () => {
              await client.request(host, {
                op: "serverToggle",
                name: server.name,
                enabled,
                confirmed: !enabled,
              });
              await refresh();
            };
            if (enabled) void ui.load(action);
            else ui.confirm("禁用服务器", `禁用 ${server.name} 后，将无法调用其工具。`, action);
          });
          toggle.setAttribute("role", "switch");
          toggle.setAttribute("aria-checked", String(server.status !== "disabled"));
          toggle.setAttribute("aria-label", `${server.name} 启用状态`);
          top.append(toggle);
          const meta = hubElement(
            document,
            "p",
            "hub-muted",
            `${server.type === "streamable-http" ? "流式 HTTP" : server.type === "sse" ? "SSE" : server.type} · ${server.tools} 工具 · ${server.prompts} 提示词 · ${server.resources} 资源 · 调用 ${server.calls ?? "—"}`,
          );
          const actions = hubElement(document, "div", "hub-actions");
          const edit = hubButton(document, "编辑", () => dialogs.server(server));
          edit.disabled = !["streamable-http", "sse", "stdio"].includes(server.type);
          actions.append(
            hubButton(document, "查看工具", () => {
              void dialogs.tools(server);
            }),
            edit,
            hubButton(document, "删除", () => {
              const host = ui.hosts.value;
              ui.confirm("删除服务器", `删除 ${server.name}？此操作无法撤销。`, async () => {
                await client.request(host, {
                  op: "serverDelete",
                  name: server.name,
                  confirmed: true,
                });
                await refresh();
              });
            }),
          );
          card.append(top, meta, actions);
          list.append(card);
        }
        if (!visible.length)
          list.append(hubElement(document, "p", "hub-empty", "没有匹配的服务器"));
      };
      const keyRow = (key: HubKey) => {
        const row = hubElement(document, "article", "hub-key");
        const info = hubElement(document, "div");
        const scope =
          key.accessType === "all"
            ? "全部服务器"
            : key.accessType === "exclude"
              ? `排除：${key.servers.join("、")}`
              : key.accessType === "servers"
                ? `仅限：${key.servers.join("、")}`
                : key.accessType;
        info.append(
          hubElement(document, "strong", "", key.name),
          hubElement(
            document,
            "p",
            "hub-muted",
            `${key.masked} · ${key.enabled ? "启用" : "禁用"} · ${scope}${key.groups.length ? ` · 组：${key.groups.join("、")}` : ""}${key.kind === "user" ? " · 用户密钥" : ""}`,
          ),
        );
        const actions = hubElement(document, "div", "hub-actions");
        const edit = hubButton(document, "编辑", () => dialogs.key(key));
        edit.disabled =
          key.kind === "user" ||
          key.groups.length > 0 ||
          !["all", "exclude", "servers"].includes(key.accessType);
        if (edit.disabled) edit.title = "此访问范围请在 MCPHub 中编辑";
        actions.append(
          edit,
          hubButton(document, "重新生成", () => {
            const host = ui.hosts.value;
            const revision = ui.revision();
            ui.confirm("重新生成密钥", `重新生成 ${key.name}？旧密钥将立即失效。`, async () => {
              const result = await client.request(host, {
                op: "keyRegenerate",
                id: key.id,
                confirmed: true,
              });
              if (ui.valid(host, revision) && result.token) dialogs.reveal(result.token);
              await refresh();
            });
          }),
          hubButton(document, "删除", () => {
            const host = ui.hosts.value;
            ui.confirm("删除密钥", `删除 ${key.name}？使用此密钥的连接将失去权限。`, async () => {
              await client.request(host, { op: "keyDelete", id: key.id, confirmed: true });
              await refresh();
            });
          }),
        );
        row.append(info, actions);
        return row;
      };
      const render = () => {
        ui.body.replaceChildren();
        const toolbar = hubElement(document, "div", "hub-row");
        const search = hubElement(document, "input");
        search.type = "search";
        search.placeholder = "搜索服务器";
        search.setAttribute("aria-label", "搜索服务器");
        search.value = query;
        search.addEventListener("input", () => {
          query = search.value;
          renderServers();
        });
        toolbar.append(
          search,
          hubButton(document, "添加服务器", () => dialogs.server(), true),
          hubButton(document, "刷新", () => {
            void refresh();
          }),
        );
        const tabs = hubElement(document, "div", "hub-tabs");
        tabs.setAttribute("aria-label", "服务器状态");
        for (const [value, label] of [["all", "全部"] as const, ...Object.entries(statuses)]) {
          const tab = hubButton(document, label, () => {
            filter = value;
            for (const button of tabs.querySelectorAll("button"))
              button.setAttribute("aria-pressed", String(button === tab));
            renderServers();
          });
          tab.setAttribute("aria-pressed", String(filter === value));
          tabs.append(tab);
        }
        ui.body.append(toolbar, tabs, list);
        renderServers();
        const keyHeader = hubElement(document, "div", "hub-row hub-section-head");
        keyHeader.append(
          hubElement(document, "h3", "", "密钥"),
          hubButton(document, "创建密钥", () => dialogs.key(), true),
        );
        ui.body.append(keyHeader);
        const auth = hubElement(document, "div", "hub-auth hub-row");
        const header = hubField(document, auth, "认证请求头", keys.headerName);
        const enabled = hubButton(
          document,
          keys.enabled ? "Bearer 认证已开启" : "Bearer 认证已关闭",
          () => {
            const host = ui.hosts.value;
            const action = async () => {
              await client.request(host, {
                op: "authSave",
                enabled: !keys.enabled,
                headerName: keys.headerName,
                confirmed: keys.enabled,
              });
              await refresh();
            };
            if (keys.enabled)
              ui.confirm("关闭 Bearer 认证", "关闭后，服务将不再校验 Bearer 密钥。", action);
            else void ui.load(action);
          },
        );
        enabled.setAttribute("role", "switch");
        enabled.setAttribute("aria-checked", String(keys.enabled));
        auth.append(
          enabled,
          hubButton(document, "保存请求头", () => {
            const host = ui.hosts.value;
            void ui.load(async () => {
              await client.request(host, {
                op: "authSave",
                enabled: keys.enabled,
                headerName: header.value,
                confirmed: !keys.enabled,
              });
              await refresh();
            });
          }),
        );
        ui.body.append(auth);
        for (const key of keys.keys) ui.body.append(keyRow(key));
        if (!keys.keys.length) ui.body.append(hubElement(document, "p", "hub-empty", "暂无密钥"));
      };
      void ui.initialize(() => {
        void refresh();
      });
    },
  });
}
