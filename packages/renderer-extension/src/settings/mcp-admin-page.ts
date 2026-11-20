import type { HubKey, HubResult, HubServer } from "@codexhost/shared-contracts";
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
  hubPager,
  hubSwitch,
} from "./hub-admin-ui.js";
import { openHubMenu, type HubMenuHandle, type HubMenuItem } from "./hub-action-menu.js";
import { createMcpConnectionUi } from "./mcp-connection-ui.js";
import { mcpDialogs } from "./mcp-admin-dialogs.js";
import { renderMcpKeysPanel, type McpKeysState } from "./mcp-keys-panel.js";
import {
  MCP_KEY_PAGE_SIZE,
  MCP_PANEL_IDS,
  MCP_SERVER_PAGE_SIZE,
  MCP_TAB_IDS,
  clampPage,
  createMcpPageTabs,
  mcpTabStorage,
  pageCount,
  pageSlice,
  readMcpAdminTab,
  writeMcpAdminTab,
  type McpAdminTab,
  type McpPageTabsHandle,
} from "./mcp-page-tabs.js";

export interface HubAdminPageOptions {
  createClient(): RendererHubAdminClient | null;
}
type McpView = {
  configured: boolean;
  last4: string | null;
  servers: HubServer[];
  keyTotal: number;
};
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
      const ui = createHubPage(context, label, client);
      if (!client) {
        ui.status.textContent = "连接失败";
        return;
      }
      const document = ui.document;
      const storage = mcpTabStorage(document);
      let tab: McpAdminTab = readMcpAdminTab(storage);
      let servers: HubServer[] = [];
      let keys: HubResult<"keys"> | null = null;
      let keyTotal = 0;
      let keysState: McpKeysState = "idle";
      let query = "";
      let filter = "all";
      let serverPage = 1;
      let keyPage = 1;
      let tabs: McpPageTabsHandle | null = null;
      let serverPanel: HTMLElement | null = null;
      let keysPanel: HTMLElement | null = null;
      let menu: HubMenuHandle | null = null;
      const closeMenu = () => {
        menu?.close();
        menu = null;
      };
      const actions = (label: string, items: HubMenuItem[]) => {
        const anchor = hubIconButton(document, label, "ellipsis", () => {
          if (menu && anchor.getAttribute("aria-expanded") === "true") {
            closeMenu();
            return;
          }
          closeMenu();
          const view = document.defaultView;
          if (!view) return;
          anchor.setAttribute("aria-expanded", "true");
          menu = openHubMenu({
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
      const showPanels = () => {
        if (serverPanel) serverPanel.hidden = tab !== "servers";
        if (keysPanel) keysPanel.hidden = tab !== "keys";
      };
      const panel = (id: string, labelledBy: string) => {
        const element = hubElement(document, "div", "hub-tab-panel");
        element.id = id;
        element.setAttribute("role", "tabpanel");
        element.setAttribute("aria-labelledby", labelledBy);
        return element;
      };
      const regenerateKey = (key: HubKey) => {
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
      };
      const deleteKey = (key: HubKey) => {
        const host = ui.hostId;
        ui.confirm("删除密钥", `删除 ${key.name}？使用此密钥的连接将失去权限。`, async () => {
          await client.request(host, { op: "keyDelete", id: key.id, confirmed: true });
          await refresh();
        });
      };
      const editAuth = () => {
        const current = keys;
        if (!current) return;
        const host = ui.hostId;
        const modal = ui.dialog("认证请求头");
        const header = hubField(document, modal.content, "请求头名称", current.headerName);
        modal.footer.append(
          hubButton(
            document,
            "保存",
            () => {
              void ui.load(async () => {
                await client.request(host, {
                  op: "authSave",
                  enabled: current.enabled,
                  headerName: header.value,
                  confirmed: !current.enabled,
                });
                modal.close();
                await refresh();
              });
            },
            true,
          ),
        );
      };
      const toggleAuth = () => {
        const current = keys;
        if (!current) return;
        const host = ui.hostId;
        const action = async () => {
          await client.request(host, {
            op: "authSave",
            enabled: !current.enabled,
            headerName: current.headerName,
            confirmed: current.enabled,
          });
          await refresh();
        };
        if (current.enabled)
          ui.confirm("关闭 Bearer 认证", "关闭后，服务将不再校验 Bearer 密钥。", action);
        else void ui.load(action);
      };
      const renderKeys = () => {
        closeMenu();
        if (!keysPanel) return;
        if (keys) keyPage = clampPage(keyPage, keys.keys.length, MCP_KEY_PAGE_SIZE);
        renderMcpKeysPanel(keysPanel, {
          data: keys,
          total: keyTotal,
          state: keysState,
          page: keyPage,
          actions,
          onPage(next) {
            keyPage = next;
            renderKeys();
          },
          onCreate: () => dialogs.key(),
          onEdit: (key) => dialogs.key(key),
          onRegenerate: regenerateKey,
          onDelete: deleteKey,
          onAuthEdit: editAuth,
          onAuthToggle: toggleAuth,
          onRetry() {
            keysState = "idle";
            openKeys();
          },
        });
      };
      const serverCard = (server: HubServer) => {
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
        const items: HubMenuItem[] = [];
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
        card.append(top, meta, hubElement(document, "p", "hub-server-counts", counts.join(" · ")));
        card.addEventListener("click", (event) => {
          if (!(event.target as Element).closest("button")) void dialogs.tools(server);
        });
        return card;
      };
      const renderServers = (root: HTMLElement) => {
        const toolbar = hubElement(document, "div", "hub-row hub-toolbar");
        const search = hubElement(document, "input");
        search.type = "search";
        search.placeholder = "搜索服务器";
        search.setAttribute("aria-label", "搜索服务器");
        search.value = query;
        const list = hubElement(document, "div", "hub-server-list");
        const pager = hubElement(document, "div", "hub-pager");
        const renderPage = () => {
          const visible = servers.filter(
            (server) =>
              server.name.toLowerCase().includes(query.toLowerCase()) &&
              (filter === "all" || server.status === filter),
          );
          serverPage = clampPage(serverPage, visible.length, MCP_SERVER_PAGE_SIZE);
          list.replaceChildren();
          for (const server of pageSlice(visible, serverPage, MCP_SERVER_PAGE_SIZE))
            list.append(serverCard(server));
          if (!visible.length)
            list.append(hubElement(document, "p", "hub-empty", "没有匹配的服务器"));
          pager.replaceChildren();
          if (visible.length > MCP_SERVER_PAGE_SIZE) {
            const pages = pageCount(visible.length, MCP_SERVER_PAGE_SIZE);
            pager.append(
              hubPager(document, {
                page: serverPage,
                pages,
                summary: `共 ${visible.length} 个服务器 · 第 ${serverPage} / ${pages} 页`,
                onPage(next) {
                  serverPage = next;
                  renderPage();
                },
              }),
            );
          }
        };
        search.addEventListener("input", () => {
          query = search.value;
          serverPage = 1;
          renderPage();
        });
        toolbar.append(
          search,
          hubIconButton(document, "刷新", "refresh", () => {
            void refresh();
          }),
          hubButton(document, "添加服务器", () => dialogs.server(), true),
        );
        const filters = hubElement(document, "div", "hub-tabs");
        filters.setAttribute("aria-label", "服务器状态");
        for (const [value, text] of [["all", "全部"] as const, ...Object.entries(statuses)]) {
          const button = hubButton(document, text, () => {
            filter = value;
            serverPage = 1;
            for (const candidate of filters.querySelectorAll("button"))
              candidate.setAttribute("aria-pressed", String(candidate === button));
            renderPage();
          });
          button.setAttribute("aria-pressed", String(filter === value));
          filters.append(button);
        }
        root.replaceChildren(toolbar, filters, list, pager);
        renderPage();
      };
      const render = () => {
        closeMenu();
        tabs = createMcpPageTabs(document, {
          selected: tab,
          serverCount: servers.length,
          keyCount: keys?.keys.length ?? keyTotal,
          onSelect(next) {
            tab = next;
            writeMcpAdminTab(storage, next);
            closeMenu();
            showPanels();
            if (next === "keys") openKeys();
          },
        });
        serverPanel = panel(MCP_PANEL_IDS.servers, MCP_TAB_IDS.servers);
        keysPanel = panel(MCP_PANEL_IDS.keys, MCP_TAB_IDS.keys);
        ui.body.replaceChildren(tabs.root, serverPanel, keysPanel);
        renderServers(serverPanel);
        renderKeys();
        showPanels();
        if (tab === "keys") openKeys();
      };
      const applyKeys = (view: HubCacheView<HubResult<"keys">>) => {
        keys = view.value;
        keysState = "ready";
        tabs?.setCounts(servers.length, view.value.keys.length);
        renderKeys();
        ui.status.textContent = "";
      };
      const keysController = new HubCacheController<HubResult<"keys">>(
        "hub-mcp-keys",
        () => client.request(ui.hostId, { op: "keys" }),
        applyKeys,
      );
      const openKeys = () => {
        if (keysState !== "idle") return;
        const cached = keysController.peek();
        keysState = cached ? "ready" : "loading";
        if (cached) {
          applyKeys(cached);
          void keysController.refresh().catch((error: unknown) => fail(error, false));
          return;
        }
        renderKeys();
        void (async () => {
          try {
            await keysController.refresh();
          } catch (error) {
            keysState = "error";
            scheduleRetry(error);
            fail(error, false);
          } finally {
            renderKeys();
          }
        })();
      };
      const applyView = (view: HubCacheView<McpView>) => {
        servers = view.value.servers;
        keyTotal = view.value.keyTotal;
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
            keyTotal: result.keys?.keys.length ?? 0,
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
        if (keysState === "ready") {
          try {
            await keysController.refresh();
          } catch (error) {
            fail(error, false);
          }
        }
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
