import type { HubKey, HubResult } from "@codexhost/shared-contracts";
import type { HubMenuItem } from "./hub-action-menu.js";
import { hubButton, hubElement, hubIconButton, hubPager, hubSwitch } from "./hub-admin-ui.js";
import { MCP_KEY_PAGE_SIZE, clampPage, pageCount, pageSlice } from "./mcp-page-tabs.js";

export type McpKeysState = "idle" | "loading" | "ready" | "error";
export interface McpKeysPanelOptions {
  data: HubResult<"keys"> | null;
  total: number;
  state: McpKeysState;
  page: number;
  actions: (label: string, items: HubMenuItem[]) => HTMLButtonElement;
  onPage(page: number): void;
  onCreate(): void;
  onEdit(key: HubKey): void;
  onRegenerate(key: HubKey): void;
  onDelete(key: HubKey): void;
  onAuthEdit(): void;
  onAuthToggle(): void;
  onRetry(): void;
}

export function renderMcpKeysPanel(parent: HTMLElement, options: McpKeysPanelOptions): void {
  const document = parent.ownerDocument;
  parent.replaceChildren();
  const total = options.data?.keys.length ?? options.total;
  const head = hubElement(document, "div", "hub-key-head");
  head.append(
    hubElement(document, "p", "hub-muted", `共 ${total} 个密钥`),
    hubButton(document, "创建密钥", options.onCreate, true),
  );
  parent.append(head);
  if (!options.data) {
    const state = hubElement(document, "div", "hub-keys-state");
    if (options.state === "error") {
      state.append(
        hubElement(document, "p", "hub-empty", "无法加载密钥"),
        hubButton(document, "重试", options.onRetry),
      );
    } else {
      state.append(hubElement(document, "p", "hub-empty", "正在加载密钥…"));
    }
    parent.append(state);
    return;
  }
  parent.append(authRow(document, options));
  const page = clampPage(options.page, options.data.keys.length, MCP_KEY_PAGE_SIZE);
  for (const key of pageSlice(options.data.keys, page, MCP_KEY_PAGE_SIZE))
    parent.append(keyRow(document, key, options));
  if (!options.data.keys.length) parent.append(hubElement(document, "p", "hub-empty", "暂无密钥"));
  if (options.data.keys.length > MCP_KEY_PAGE_SIZE) {
    const pages = pageCount(options.data.keys.length, MCP_KEY_PAGE_SIZE);
    parent.append(
      hubPager(document, {
        page,
        pages,
        summary: `共 ${options.data.keys.length} 个密钥 · 第 ${page} / ${pages} 页`,
        onPage: options.onPage,
      }),
    );
  }
}

function authRow(document: Document, options: McpKeysPanelOptions): HTMLElement {
  const auth = hubElement(document, "div", "hub-setting-row");
  const copy = hubElement(document, "div", "hub-setting-copy");
  copy.append(
    hubElement(document, "strong", "", "Bearer 认证"),
    hubElement(document, "p", "hub-muted", "连接服务器时校验访问密钥"),
  );
  const controls = hubElement(document, "div", "hub-row");
  controls.append(
    hubIconButton(document, "编辑认证请求头", "settings", options.onAuthEdit),
    hubSwitch(document, "Bearer 认证", options.data?.enabled ?? true, options.onAuthToggle),
  );
  auth.append(copy, controls);
  return auth;
}

function keyRow(document: Document, key: HubKey, options: McpKeysPanelOptions): HTMLElement {
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
  const status = hubElement(document, "span", "hub-status-dot", key.enabled ? "启用" : "禁用");
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
  const items: HubMenuItem[] = [];
  if (
    key.kind !== "user" &&
    !key.groups.length &&
    ["all", "exclude", "servers"].includes(key.accessType)
  )
    items.push({ label: "编辑", run: () => options.onEdit(key) });
  items.push(
    { label: "重新生成", run: () => options.onRegenerate(key) },
    { label: "删除", danger: true, run: () => options.onDelete(key) },
  );
  row.append(info, options.actions(`${key.name} 的操作`, items));
  return row;
}
