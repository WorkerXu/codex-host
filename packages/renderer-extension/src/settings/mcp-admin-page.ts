import type { HubKey, HubServer, HubResult } from "@codexhost/shared-contracts";
import type { RendererHubAdminClient } from "../renderer-hub-admin-client.js";
import { hubErrorText } from "../renderer-hub-admin-client.js";
import type { RendererSettingsPageDefinition } from "./core.js";
import { HubCacheController, hubAgeLabel, type HubCacheView } from "./hub-cache.js";
import {
  createHubPage,
  hubButton,
  hubElement,
  hubField,
  hubIconButton,
  hubSwitch,
} from "./hub-admin-ui.js";
import { openAgentMenu, type AgentMenuHandle, type AgentMenuItem } from "./agent-card-menu.js";
import { createMcpConnectionUi } from "./mcp-connection-ui.js";
import { mcpDialogs } from "./mcp-admin-dialogs.js";

export interface HubAdminPageOptions {
  createClient(): RendererHubAdminClient | null;
}
type McpView = {
  configured: boolean;
  last4: string | null;
  servers: HubServer[];
  keys: HubResult<"keys">;
};
const statuses = { online: "在线", offline: "离线", inactive: "未激活", disabled: "禁用" };
const emptyKeys: HubResult<"keys"> = {
  enabled: true,
  headerName: "Authorization",
  keys: [],
};
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
      const ui = createHubPage(context, label, client);
      if (!client) {
        ui.status.textContent = "连接失败";
        return;
      }
      const document = ui.document;
      let servers: HubServer[] = [];
      let keys: HubResult<"keys"> = emptyKeys;
      let query = "";
      let filter = "all";
      let menu: AgentMenuHandle | null = null;
      const closeMenu = () => {
        menu?.close();
        menu = null;
      };
      const actions = (label: string, items: AgentMenuItem[]) => {
        const anchor = hubIconButton(document, label, "ellipsis", () => {
          if (menu && anchor.getAttribute("aria-expanded") === "true") {
            closeMenu();
            return;
          }
          closeMenu();
          const view = document.defaultView;
          if (!view) return;
          anchor.setAttribute("aria-expanded", "true");
          menu = openAgentMenu({
            document,
            view,
            container: ui.page,
            anchor,
            label,
            items,
            onClose() {
              anchor.setAttribute("aria-expanded", "false");
              menu = null;
            },
          });
        });
        anchor.setAttribute("aria-haspopup", "menu");
        anchor.setAttribute("aria-expanded", "false");
        return anchor;
      };
      const fail = (error: unknown, visible: boolean) => {
        if (error instanceof Error && error.message === "mcp-auth") connection.authFailed();
        else ui.status.textContent = hubErrorText(error);
        if (visible) throw error;
      };
      const applyView = (view: HubCacheView<McpView>) => {
        servers = view.value.servers;
        keys = view.value.keys;
        connection.show({ configured: view.value.configured, last4: view.value.last4 });
        ui.updated.hidden = !view.value.configured;
        if (view.value.configured) {
          ui.updated.textContent = `更新于 ${hubAgeLabel(view.updatedAt)}`;
          render();
        }
        ui.status.textContent = "";
      };
      const controller = new HubCacheController<McpView>(
        "hub-mcp",
        async () => {
          const result = await client.request(ui.hostId, { op: "mcpOverview" });
          return {
            configured: result.configured,
            last4: result.last4,
            servers: result.servers ?? [],
            keys: result.keys ?? emptyKeys,
          };
        },
        applyView,
      );
      let retry: ReturnType<typeof setTimeout> | null = null;
      const scheduleRetry = (error: unknown) => {
        const code = (error as { message?: string } | null)?.message;
        if (code !== "connecting" && code !== "retrying") return;
        if (retry) clearTimeout(retry);
        retry = setTimeout(() => {
          retry = null;
          background();
        }, 3_000);
      };
      const refresh = async (pending?: string) => {
        await ui.load(async () => {
          try {
            await controller.refresh();
          } catch (error) {
            scheduleRetry(error);
            fail(error, true);
          }
        }, pending);
      };
      const background = () => {
        void controller.refresh().catch((error: unknown) => {
          fail(error, false);
          scheduleRetry(error);
        });
      };
      context.signal.addEventListener(
        "abort",
        () => {
          if (retry) clearTimeout(retry);
          retry = null;
        },
        { once: true },
      );
      const connection = createMcpConnectionUi(ui, client, refresh, actions);
      const dialogs = mcpDialogs(ui, client, refresh, () => servers);
      const list = hubElement(document, "div", "hub-server-list");
      const renderServers = () => {
        closeMenu();
        list.replaceChildren();
        const visible = servers.filter(
          (server) =>
            server.name.toLowerCase().includes(query.toLowerCase()) &&
            (filter === "all" || server.status === filter),
        );
        for (const server of visible) {
          const card = hubElement(document, "article", "hub-server");
          card.dataset.disabled = String(server.status === "disabled");
          const top = hubElement(document, "div", "hub-server-top");
          const title = hubButton(document, server.name, () => {
            void dialogs.tools(server);
          });
          title.className = "hub-server-title";
          const controls = hubElement(document, "div", "hub-card-controls");
          const toggle = hubSwitch(
            document,
            `${server.name} 启用状态`,
            server.status !== "disabled",
            () => {
              const host = ui.hostId;
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
            },
          );
          const items: AgentMenuItem[] = [];
          if (["streamable-http", "sse", "stdio"].includes(server.type))
            items.push({ label: "编辑", run: () => dialogs.server(server) });
          items.push({
            label: "删除",
            danger: true,
            run() {
              const host = ui.hostId;
              ui.confirm("删除服务器", `删除 ${server.name}？此操作无法撤销。`, async () => {
                await client.request(host, {
                  op: "serverDelete",
                  name: server.name,
                  confirmed: true,
                });
                await refresh();
              });
            },
          });
          controls.append(toggle, actions(`${server.name} 的操作`, items));
          top.append(title, controls);
          const status = hubElement(document, "span", "hub-status-dot", statuses[server.status]);
          status.dataset.status = server.status;
          const protocol =
            server.type === "streamable-http"
              ? "流式 HTTP"
              : server.type === "sse"
                ? "SSE"
                : server.type;
          const meta = hubElement(document, "div", "hub-server-meta");
          meta.append(status, hubElement(document, "span", "", protocol));
          if (server.version && server.version !== "—")
            meta.append(hubElement(document, "span", "", `v${server.version.replace(/^v/u, "")}`));
          const counts = [
            `${server.tools} 工具`,
            `${server.prompts} 提示词`,
            `${server.resources} 资源`,
          ];
          if (server.calls !== null) counts.push(`${server.calls} 次调用`);
          card.append(
            top,
            meta,
            hubElement(document, "p", "hub-server-counts", counts.join(" · ")),
          );
          card.addEventListener("click", (event) => {
            if (!(event.target as Element).closest("button")) void dialogs.tools(server);
          });
          list.append(card);
        }
        if (!visible.length)
          list.append(hubElement(document, "p", "hub-empty", "没有匹配的服务器"));
      };
      const keyRow = (key: HubKey) => {
        const row = hubElement(document, "article", "hub-key");
        const info = hubElement(document, "div", "hub-key-info");
        const scope =
          key.accessType === "all"
            ? "全部服务器"
            : key.accessType === "exclude"
              ? `排除：${key.servers.join("、")}`
              : key.accessType === "servers"
                ? `仅限：${key.servers.join("、")}`
                : "自定义范围";
        const top = hubElement(document, "div", "hub-row");
        const status = hubElement(
          document,
          "span",
          "hub-status-dot",
          key.enabled ? "启用" : "禁用",
        );
        status.dataset.status = key.enabled ? "online" : "disabled";
        top.append(hubElement(document, "strong", "", key.name), status);
        info.append(
          top,
          hubElement(
            document,
            "p",
            "hub-muted",
            `${key.masked} · ${scope}${key.groups.length ? ` · 组：${key.groups.join("、")}` : ""}${key.kind === "user" ? " · 用户密钥" : ""}`,
          ),
        );
        const items: AgentMenuItem[] = [];
        if (
          key.kind !== "user" &&
          !key.groups.length &&
          ["all", "exclude", "servers"].includes(key.accessType)
        )
          items.push({ label: "编辑", run: () => dialogs.key(key) });
        items.push(
          {
            label: "重新生成",
            run() {
              const host = ui.hostId;
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
            },
          },
          {
            label: "删除",
            danger: true,
            run() {
              const host = ui.hostId;
              ui.confirm("删除密钥", `删除 ${key.name}？使用此密钥的连接将失去权限。`, async () => {
                await client.request(host, { op: "keyDelete", id: key.id, confirmed: true });
                await refresh();
              });
            },
          },
        );
        row.append(info, actions(`${key.name} 的操作`, items));
        return row;
      };
      const render = () => {
        closeMenu();
        ui.body.replaceChildren();
        const toolbar = hubElement(document, "div", "hub-row hub-toolbar");
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
          hubIconButton(document, "刷新", "refresh", () => {
            void refresh();
          }),
          hubButton(document, "添加服务器", () => dialogs.server(), true),
        );
        const tabs = hubElement(document, "div", "hub-tabs");
        tabs.setAttribute("aria-label", "服务器状态");
        for (const [value, text] of [["all", "全部"] as const, ...Object.entries(statuses)]) {
          const tab = hubButton(document, text, () => {
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
          hubButton(document, "创建密钥", () => dialogs.key()),
        );
        ui.body.append(keyHeader);
        const auth = hubElement(document, "div", "hub-setting-row");
        const copy = hubElement(document, "div", "hub-setting-copy");
        copy.append(
          hubElement(document, "strong", "", "Bearer 认证"),
          hubElement(document, "p", "hub-muted", "连接服务器时校验访问密钥"),
        );
        const controls = hubElement(document, "div", "hub-row");
        controls.append(
          hubIconButton(document, "编辑认证请求头", "settings", () => {
            const host = ui.hostId;
            const modal = ui.dialog("认证请求头");
            const header = hubField(document, modal.content, "请求头名称", keys.headerName);
            modal.footer.append(
              hubButton(
                document,
                "保存",
                () => {
                  void ui.load(async () => {
                    await client.request(host, {
                      op: "authSave",
                      enabled: keys.enabled,
                      headerName: header.value,
                      confirmed: !keys.enabled,
                    });
                    modal.close();
                    await refresh();
                  });
                },
                true,
              ),
            );
          }),
          hubSwitch(document, "Bearer 认证", keys.enabled, () => {
            const host = ui.hostId;
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
          }),
        );
        auth.append(copy, controls);
        ui.body.append(auth);
        for (const key of keys.keys) ui.body.append(keyRow(key));
        if (!keys.keys.length) ui.body.append(hubElement(document, "p", "hub-empty", "暂无密钥"));
      };
      const tick = setInterval(() => {
        const view = controller.peek();
        if (view && !ui.updated.hidden)
          ui.updated.textContent = `更新于 ${hubAgeLabel(view.updatedAt)}`;
      }, 30_000);
      context.signal.addEventListener("abort", () => clearInterval(tick), { once: true });
      void ui.initialize(() => {
        const cached = controller.peek();
        if (cached) {
          applyView(cached);
          background();
        } else void refresh("正在连接 India…");
      });
      return closeMenu;
    },
  });
}
