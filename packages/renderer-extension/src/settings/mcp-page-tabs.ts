import { hubElement } from "./hub-admin-ui.js";

export type McpAdminTab = "servers" | "keys";
export const MCP_SERVER_PAGE_SIZE = 12;
export const MCP_KEY_PAGE_SIZE = 20;
export const MCP_TAB_IDS: Record<McpAdminTab, string> = {
  servers: "hub-mcp-tab-servers",
  keys: "hub-mcp-tab-keys",
};
export const MCP_PANEL_IDS: Record<McpAdminTab, string> = {
  servers: "hub-mcp-panel-servers",
  keys: "hub-mcp-panel-keys",
};
const TAB_STORAGE_KEY = "codexhost.mcp-page-tab";
const tabLabels: Record<McpAdminTab, string> = { servers: "服务器", keys: "密钥" };
const tabOrder: McpAdminTab[] = ["servers", "keys"];

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, Math.trunc(page)), pageCount(total, pageSize));
}
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const current = clampPage(page, items.length, pageSize);
  return items.slice((current - 1) * pageSize, current * pageSize);
}
/** Session storage can be blocked; the tab then simply resets to 服务器. */
export function mcpTabStorage(document: Document): Storage | null {
  try {
    return document.defaultView?.sessionStorage ?? null;
  } catch {
    return null;
  }
}
export function readMcpAdminTab(storage: Storage | null): McpAdminTab {
  try {
    return storage?.getItem(TAB_STORAGE_KEY) === "keys" ? "keys" : "servers";
  } catch {
    return "servers";
  }
}
export function writeMcpAdminTab(storage: Storage | null, tab: McpAdminTab): void {
  try {
    storage?.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // A blocked session storage must not break switching tabs.
  }
}

export interface McpPageTabsOptions {
  selected: McpAdminTab;
  serverCount: number;
  keyCount: number;
  onSelect(tab: McpAdminTab): void;
}
export interface McpPageTabsHandle {
  root: HTMLElement;
  setCounts(serverCount: number, keyCount: number): void;
}

export function createMcpPageTabs(
  document: Document,
  options: McpPageTabsOptions,
): McpPageTabsHandle {
  const root = hubElement(document, "div", "hub-page-tabs");
  root.setAttribute("role", "tablist");
  root.setAttribute("aria-label", "MCP 服务器内容");
  let selected = options.selected;
  const buttons = new Map<McpAdminTab, HTMLButtonElement>();
  const counts = new Map<McpAdminTab, HTMLElement>();
  const tabAt = (index: number): McpAdminTab =>
    tabOrder[(index + tabOrder.length) % tabOrder.length] ?? "servers";
  const select = (tab: McpAdminTab, reveal: boolean) => {
    if (tab === selected) return;
    selected = tab;
    for (const candidate of tabOrder) {
      const button = buttons.get(candidate);
      if (!button) continue;
      button.setAttribute("aria-selected", String(candidate === tab));
      button.tabIndex = candidate === tab ? 0 : -1;
    }
    if (reveal) buttons.get(tab)?.focus();
    options.onSelect(tab);
  };
  const setCount = (tab: McpAdminTab, count: number) => {
    const value = counts.get(tab);
    const button = buttons.get(tab);
    if (!value) return;
    value.textContent = String(count);
    button?.setAttribute("aria-label", `${tabLabels[tab]} ${count}`);
  };
  for (const tab of tabOrder) {
    const button = hubElement(document, "button");
    button.type = "button";
    button.id = MCP_TAB_IDS[tab];
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", MCP_PANEL_IDS[tab]);
    button.setAttribute("aria-selected", String(tab === selected));
    button.tabIndex = tab === selected ? 0 : -1;
    const count = hubElement(document, "span", "hub-tab-count");
    button.append(hubElement(document, "span", "hub-tab-label", tabLabels[tab]), count);
    button.addEventListener("click", () => select(tab, false));
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const index = tabOrder.indexOf(tab);
        select(tabAt(index + direction), true);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        select(tabAt(event.key === "Home" ? 0 : tabOrder.length - 1), true);
      }
    });
    buttons.set(tab, button);
    counts.set(tab, count);
    root.append(button);
  }
  setCount("servers", options.serverCount);
  setCount("keys", options.keyCount);
  return {
    root,
    setCounts(serverCount, keyCount) {
      setCount("servers", serverCount);
      setCount("keys", keyCount);
    },
  };
}
