import { createHubHeaderEditor } from "./hub-header-editor.js";
import {
  hubServerInputSchema,
  hubKeyInputSchema,
  type HubKey,
  type HubServer,
  type HubResult,
} from "@codexhost/shared-contracts";
import { hubErrorText, type RendererHubAdminClient } from "../renderer-hub-admin-client.js";
import {
  hubButton,
  hubElement,
  hubField,
  hubFieldError,
  hubSelect,
  type HubPage,
} from "./hub-admin-ui.js";

export function mcpDialogs(
  ui: HubPage,
  client: RendererHubAdminClient,
  refresh: () => Promise<void>,
  servers: () => HubServer[],
) {
  const document = ui.document;
  const reveal = (token: string) => {
    const modal = ui.dialog("保存密钥");
    modal.content.append(hubElement(document, "p", "hub-muted", "密钥仅显示一次，请妥善保存。"));
    const value = hubField(document, modal.content, "密钥", token, true);
    value.readOnly = true;
    if (modal.footer.firstElementChild) modal.footer.firstElementChild.textContent = "完成";
    modal.footer.append(
      hubButton(document, "复制", () => {
        void document.defaultView?.navigator.clipboard
          .writeText(value.value)
          .then(() => {
            modal.error.textContent = "已复制";
          })
          .catch(() => {
            modal.error.textContent = "复制失败，请手动复制";
          });
      }),
    );
    modal.root.addEventListener(
      "close",
      () => {
        value.value = "";
      },
      { once: true },
    );
  };
  const save = (
    modal: ReturnType<HubPage["dialog"]>,
    operation: () => Promise<HubResult<"keySave">>,
  ) => {
    const host = ui.hostId;
    const revision = ui.revision();
    const submit = hubButton(
      document,
      "保存",
      () => {
        if (!ui.valid(host, revision)) return;
        modal.error.textContent = "";
        modal.root.dataset.busy = "true";
        modal.root.querySelectorAll("button").forEach((button) => {
          button.disabled = true;
        });
        void operation()
          .then(async (result) => {
            modal.close();
            if (!ui.valid(host, revision)) return;
            if (result.token) reveal(result.token);
            await refresh();
          })
          .catch((error: unknown) => {
            modal.error.textContent =
              error instanceof Error && error.message === "invalid"
                ? modal.root.querySelector(".hub-field-error:not(:empty)")
                  ? ""
                  : "请检查输入内容"
                : hubErrorText(error);
          })
          .finally(() => {
            delete modal.root.dataset.busy;
            modal.root.querySelectorAll("button").forEach((button) => {
              button.disabled = false;
            });
          });
      },
      true,
    );
    modal.footer.append(submit);
  };
  return {
    reveal,
    server(server?: HubServer) {
      const host = ui.hostId;
      const modal = ui.dialog(server ? "编辑服务器" : "添加服务器");
      const name = hubField(document, modal.content, "名称", server?.name ?? "");
      const type = hubSelect(document, "协议", [
        ["streamable-http", "流式 HTTP"],
        ["sse", "SSE"],
        ["stdio", "stdio"],
      ]);
      type.value = server?.type ?? "streamable-http";
      const label = hubElement(document, "label", "hub-field");
      label.append(hubElement(document, "span", "", "协议"), type);
      modal.content.append(label);
      if (server)
        modal.content.append(
          hubElement(
            document,
            "p",
            "hub-muted",
            "连接信息不会回显。留空保留现有值；填写后替换对应项。",
          ),
        );
      const url = hubField(document, modal.content, "URL");
      const command = hubField(document, modal.content, "命令");
      const args = hubField(document, modal.content, "参数（JSON 数组）", "", true);
      const env = hubField(document, modal.content, "环境变量（JSON 对象）", "", true);
      const headers = createHubHeaderEditor(document);
      modal.content.append(headers.root);
      const update = () => {
        const stdio = type.value === "stdio";
        if (url.parentElement) url.parentElement.hidden = stdio;
        headers.root.hidden = stdio;
        for (const input of [command, args, env]) {
          if (input.parentElement) input.parentElement.hidden = !stdio;
        }
      };
      type.addEventListener("change", update);
      update();
      save(modal, async () => {
        const stdio = type.value === "stdio";
        for (const field of [name, url, command, args, env]) hubFieldError(field, "");
        const parse = (field: HTMLInputElement | HTMLTextAreaElement, array = false): unknown => {
          if (!field.value.trim()) return undefined;
          try {
            const value: unknown = JSON.parse(field.value);
            if (
              array
                ? !Array.isArray(value) || !value.every((item) => typeof item === "string")
                : !value ||
                  typeof value !== "object" ||
                  Array.isArray(value) ||
                  !Object.values(value).every((item) => typeof item === "string")
            )
              throw new Error();
            return value;
          } catch {
            hubFieldError(
              field,
              array
                ? '请输入字符串数组，例如 ["--port", "3000"]'
                : "请输入名称与内容均为文本的对象",
            );
            throw new Error("invalid");
          }
        };
        const headerValues = stdio ? undefined : headers.read();
        const input = hubServerInputSchema.safeParse({
          name: name.value,
          type: type.value,
          ...(stdio
            ? {
                ...(command.value.trim() ? { command: command.value.trim() } : {}),
                ...(args.value.trim() ? { args: parse(args, true) } : {}),
                ...(env.value.trim() ? { env: parse(env) } : {}),
              }
            : {
                ...(url.value.trim() ? { url: url.value.trim() } : {}),
                ...(headerValues ? { headers: headerValues } : {}),
              }),
        });
        if (!input.success) {
          for (const issue of input.error.issues) {
            const field =
              issue.path[0] === "name"
                ? name
                : issue.path[0] === "url"
                  ? url
                  : issue.path[0] === "command"
                    ? command
                    : issue.path[0] === "args"
                      ? args
                      : env;
            hubFieldError(
              field,
              field === name
                ? "请输入名称（最多 200 个字符）"
                : field === url
                  ? "请输入有效的 HTTP 或 HTTPS 地址"
                  : "请检查此项内容",
            );
          }
          throw new Error("invalid");
        }
        if (
          (!server || server.type !== type.value) &&
          !(stdio ? command.value.trim() : url.value.trim())
        ) {
          hubFieldError(stdio ? command : url, stdio ? "请输入启动命令" : "请输入服务器地址");
          throw new Error("invalid");
        }
        return client.request(host, {
          op: "serverSave",
          ...(server ? { originalName: server.name } : {}),
          input: input.data,
        });
      });
    },
    key(key?: HubKey) {
      const host = ui.hostId;
      const modal = ui.dialog(key ? "编辑密钥" : "创建密钥");
      const name = hubField(document, modal.content, "名称", key?.name ?? "");
      const enabled = hubSelect(document, "状态", [
        ["true", "启用"],
        ["false", "禁用"],
      ]);
      enabled.value = String(key?.enabled ?? true);
      const scope = hubSelect(document, "访问范围", [
        ["all", "全部服务器"],
        ["exclude", "除所选服务器外"],
        ["servers", "仅所选服务器"],
      ]);
      scope.value = key?.accessType ?? "all";
      for (const [title, input] of [
        ["状态", enabled],
        ["访问范围", scope],
      ] as const) {
        const label = hubElement(document, "label", "hub-field");
        label.append(hubElement(document, "span", "", title), input);
        modal.content.append(label);
      }
      const choices = hubElement(document, "fieldset", "hub-server-choices");
      choices.append(hubElement(document, "legend", "", "服务器"));
      const ids = [
        ...new Set([...servers().map((server) => server.name), ...(key?.servers ?? [])]),
      ];
      for (const id of ids) {
        const label = hubElement(document, "label");
        const input = hubElement(document, "input");
        input.type = "checkbox";
        input.value = id;
        input.checked = key?.servers.includes(id) ?? false;
        label.append(input, document.createTextNode(id));
        choices.append(label);
      }
      modal.content.append(choices);
      choices.hidden = scope.value === "all";
      scope.addEventListener("change", () => {
        choices.hidden = scope.value === "all";
      });
      save(modal, async () => {
        const parsed = hubKeyInputSchema.safeParse({
          name: name.value,
          enabled: enabled.value === "true",
          accessType: scope.value,
          servers: [...choices.querySelectorAll<HTMLInputElement>("input:checked")].map(
            (input) => input.value,
          ),
        });
        if (!parsed.success) {
          hubFieldError(name, name.value.trim() ? "请选择至少一个服务器" : "请输入密钥名称");
          throw new Error("invalid");
        }
        return client.request(host, {
          op: "keySave",
          ...(key ? { id: key.id } : {}),
          input: parsed.data,
        });
      });
    },
    async tools(server: HubServer) {
      const host = ui.hostId;
      const revision = ui.revision();
      const modal = ui.dialog(server.name, true);
      modal.content.textContent = "正在加载…";
      try {
        const result = await client.request(host, { op: "tools", name: server.name });
        if (!ui.valid(host, revision) || !modal.root.isConnected) return;
        modal.content.replaceChildren();
        for (const tool of result.tools) {
          const row = hubElement(document, "div", "hub-list-row");
          row.append(
            hubElement(document, "strong", "", tool.name),
            hubElement(document, "p", "hub-muted", tool.description),
          );
          modal.content.append(row);
        }
        if (!result.tools.length) modal.content.textContent = "暂无工具";
      } catch (error) {
        modal.content.textContent = hubErrorText(error);
      }
    },
  };
}
