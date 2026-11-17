import type { RendererHubAdminClient } from "../renderer-hub-admin-client.js";
import { hubErrorText } from "../renderer-hub-admin-client.js";
import { hubMcpKeySchema } from "@codexhost/shared-contracts";
import type { AgentMenuItem } from "./agent-card-menu.js";
import { hubButton, hubElement, hubField, hubFieldError, type HubPage } from "./hub-admin-ui.js";

export function createMcpConnectionUi(
  ui: HubPage,
  client: RendererHubAdminClient,
  refresh: () => Promise<void>,
  actions: (label: string, items: AgentMenuItem[]) => HTMLButtonElement,
) {
  const document = ui.document;
  const connect = (replace = false) => {
    const host = ui.hosts.value;
    const revision = ui.revision();
    const modal = ui.dialog(replace ? "更换密钥" : "连接 MCPHub");
    const input = hubField(document, modal.content, "管理员密钥") as HTMLInputElement;
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "输入专用的全权限管理员密钥";
    modal.content.append(hubElement(document, "p", "hub-muted", "密钥仅保存在所选主机上。"));
    const submit = hubButton(
      document,
      "测试并保存",
      () => {
        const parsed = hubMcpKeySchema.safeParse(input.value);
        if (!parsed.success) {
          hubFieldError(input, "请输入有效的管理员密钥");
          return;
        }
        if (!ui.valid(host, revision)) return;
        hubFieldError(input, "");
        input.value = "";
        modal.error.textContent = "正在测试…";
        modal.root.dataset.busy = "true";
        modal.root
          .querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")
          .forEach((element) => {
            element.disabled = true;
          });
        void client
          .request(host, { op: "mcpConnect", key: parsed.data })
          .then(async () => {
            if (!ui.valid(host, revision)) return;
            modal.close();
            await refresh();
          })
          .catch((error: unknown) => {
            if (ui.valid(host, revision) && modal.root.isConnected)
              modal.error.textContent = hubErrorText(error);
          })
          .finally(() => {
            delete modal.root.dataset.busy;
            modal.root
              .querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")
              .forEach((element) => {
                element.disabled = false;
              });
            if (modal.root.isConnected) input.focus();
          });
      },
      true,
    );
    modal.root.addEventListener(
      "close",
      () => {
        input.value = "";
      },
      { once: true },
    );
    modal.footer.append(submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !submit.disabled) {
        event.preventDefault();
        submit.click();
      }
    });
    input.focus();
  };
  const menu = actions("MCPHub 连接设置", [
    { label: "更换密钥", run: () => connect(true) },
    {
      label: "断开",
      run: () => {
        const host = ui.hosts.value;
        const revision = ui.revision();
        ui.confirm("断开 MCPHub", "移除此主机保存的管理员密钥？", async () => {
          await client.request(host, { op: "mcpDisconnect", confirmed: true });
          if (ui.valid(host, revision)) await refresh();
        });
      },
    },
  ]);
  menu.hidden = true;
  ui.headerControls.append(menu);
  const empty = (invalid = false) => {
    ui.body.replaceChildren();
    const state = hubElement(document, "div", "hub-connection-state");
    state.append(
      hubElement(document, "h3", "", invalid ? "密钥无效或权限不足" : "连接 MCPHub"),
      hubButton(document, invalid ? "更换密钥" : "连接 MCPHub", () => connect(invalid), true),
    );
    ui.body.append(state);
  };
  ui.hosts.addEventListener("change", () => {
    menu.hidden = true;
  });
  return {
    async ready() {
      const host = ui.hosts.value;
      const revision = ui.revision();
      const state = await client.request(host, { op: "mcpConnection" });
      if (!ui.valid(host, revision)) return false;
      menu.hidden = !state.configured;
      menu.dataset.tooltip = state.last4
        ? `MCPHub 连接设置 · ••••${state.last4}`
        : "MCPHub 连接设置";
      if (!state.configured) empty();
      return state.configured;
    },
    authFailed: () => empty(true),
  };
}
