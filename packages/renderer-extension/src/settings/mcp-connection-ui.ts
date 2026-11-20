import type { RendererHubAdminClient } from "../renderer-hub-admin-client.js";
import { hubErrorText } from "../renderer-hub-admin-client.js";
import { hubMcpKeySchema } from "@codexhost/shared-contracts";
import { createRendererSettingsIcon } from "./icons.js";
import type { HubMenuItem } from "./hub-action-menu.js";
import { hubButton, hubElement, hubField, hubFieldError, type HubPage } from "./hub-admin-ui.js";

export function createMcpConnectionUi(
  ui: HubPage,
  client: RendererHubAdminClient,
  refresh: () => Promise<void>,
  actions: (label: string, items: HubMenuItem[]) => HTMLButtonElement,
) {
  const document = ui.document;
  const connect = (replace = false) => {
    const host = ui.hostId;
    const revision = ui.revision();
    const modal = ui.dialog(replace ? "更换密钥" : "连接 MCPHub");
    const input = hubField(document, modal.content, "管理员密钥") as HTMLInputElement;
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "输入专用的全权限管理员密钥";
    modal.content.append(
      hubElement(
        document,
        "p",
        "hub-muted",
        "需要系统级、全部访问（accessType 为全部）的密钥。通过验证后保存在本机。",
      ),
    );
    const submit = hubButton(
      document,
      "测试并连接",
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
        const host = ui.hostId;
        const revision = ui.revision();
        ui.confirm("断开 MCPHub", "删除此主机保存的管理员密钥？", async () => {
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
    if (invalid) {
      state.append(hubElement(document, "h3", "", "密钥无效或权限不足"));
    } else {
      state.classList.add("hub-connection-state--empty");
      const icon = createRendererSettingsIcon("connections", 40);
      icon.classList.add("hub-connection-icon");
      icon.setAttribute("stroke-width", "1.5");
      const copy = hubElement(document, "div", "hub-connection-copy");
      copy.append(
        hubElement(document, "h3", "", "连接 MCPHub"),
        hubElement(
          document,
          "p",
          "hub-muted",
          "需要“全部访问”类型的密钥（MCPHub 设置 › 密钥 中 accessType 为全部的密钥，例如 admin）",
        ),
      );
      state.append(icon, copy);
    }
    state.append(hubButton(document, invalid ? "更换密钥" : "连接", () => connect(invalid), true));
    ui.body.append(state);
  };
  return {
    show(state: { configured: boolean; last4: string | null }) {
      menu.hidden = !state.configured;
      menu.dataset.tooltip = state.last4
        ? `MCPHub 连接设置 · ••••${state.last4}`
        : "MCPHub 连接设置";
      if (!state.configured) empty();
    },
    authFailed: () => empty(true),
  };
}
