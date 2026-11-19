interface PreviewHarness {
  mount(id: "memory" | "mcp-servers"): {
    query<T extends Element>(selector: string): T | null;
    queryAll<T extends Element>(selector: string): T[];
  };
  click(element: Element): Promise<void>;
  type(element: Element, text: string): Promise<void>;
  key(element: Element, key: string): Promise<void>;
  hover(element: Element): Promise<void>;
  waitFor<T>(read: () => T | null | undefined): Promise<T>;
}
export const hubScenarioNames = [
  "hub-connection-empty",
  "hub-connection-connect",
  "hub-connection-test-error",
  "hub-connection-scoped-error",
  "hub-connection-saved",
  "hub-connection-menu",
  "hub-connection-replace",
  "hub-connection-disconnect",
  "hub-connection-disconnected",
  "hub-auth-error",
  "hub-servers",
  "hub-search",
  "hub-filter",
  "hub-add",
  "hub-add-stdio",
  "hub-edit",
  "hub-tools",
  "hub-server-delete",
  "hub-server-disable",
  "hub-key-create",
  "hub-key-edit",
  "hub-key-delete",
  "hub-key-regenerate",
  "hub-key-reveal",
  "hub-auth-disable",
  "hub-error",
  "hub-memory",
  "hub-memory-search",
  "hub-memory-source",
  "hub-memory-page",
  "hub-memory-detail",
  "hub-memory-empty",
  "hub-hover",
  "hub-focus",
  "hub-server-menu",
  "hub-key-menu",
  "hub-protocol-menu",
  "hub-source-menu",
  "hub-scope-menu",
  "hub-key-exclude",
  "hub-add-error",
  "hub-header-rows",
  "hub-auth-header",
  "hub-memory-hover",
  "hub-memory-focus",
];
export function hubAdminScenarios(harness: PreviewHarness): Record<string, () => Promise<void>> {
  const { click, type, key, hover, waitFor } = harness;
  return Object.fromEntries(
    hubScenarioNames.map((name) => [
      name,
      async () => {
        const memory = name.startsWith("hub-memory") || name === "hub-source-menu";
        const { query, queryAll } = harness.mount(memory ? "memory" : "mcp-servers");
        const required = (selector: string): Element => {
          const result = query(selector);
          if (!result) throw new Error(`Missing ${selector}`);
          return result;
        };
        const button = (text: string, scope = ".hub-page") => {
          const result = queryAll<HTMLButtonElement>(`${scope} button`).find(
            (item) => item.textContent === text,
          );
          if (!result) throw new Error(`Missing button ${text}`);
          return result;
        };
        const choose = async (label: string, text: string) => {
          await click(required(`.hub-select[aria-label="${label}"]`));
          await waitFor(() => query(".hub-select-menu:popover-open"));
          await click(button(text, ".hub-select-menu"));
        };
        const action = async (scope: ".hub-server" | ".hub-key", text?: string) => {
          await click(required(`${scope} button[aria-haspopup="menu"]`));
          await waitFor(() => query(".agent-menu"));
          if (text) await click(button(text, ".agent-menu"));
        };
        if (name === "hub-error" || name === "hub-auth-error") {
          await waitFor(
            () => query(".hub-connection-state h3")?.textContent === "密钥无效或权限不足",
          );
          return;
        }
        if (
          [
            "hub-connection-empty",
            "hub-connection-connect",
            "hub-connection-test-error",
            "hub-connection-scoped-error",
            "hub-connection-saved",
          ].includes(name)
        ) {
          await waitFor(() => query(".hub-connection-state"));
          if (name !== "hub-connection-empty") {
            await click(button("连接"));
            await type(
              required('.hub-dialog input[type="password"]'),
              "mcphub_preview_fake_key_5678",
            );
            if (
              name === "hub-connection-test-error" ||
              name === "hub-connection-scoped-error" ||
              name === "hub-connection-saved"
            ) {
              await click(button("测试并保存", ".hub-dialog"));
              await waitFor(() =>
                name === "hub-connection-test-error"
                  ? query(".hub-dialog .hub-status")?.textContent === "密钥不正确"
                  : name === "hub-connection-scoped-error"
                    ? Boolean(query(".hub-dialog .hub-status")?.textContent)
                    : query(".hub-server"),
              );
            }
          }
          return;
        }
        await waitFor(() => query(memory ? ".hub-memory-row" : ".hub-server"));
        if (
          [
            "hub-connection-menu",
            "hub-connection-replace",
            "hub-connection-disconnect",
            "hub-connection-disconnected",
          ].includes(name)
        ) {
          await click(required('[aria-label="MCPHub 连接设置"]'));
          await waitFor(() => query(".agent-menu"));
          if (name !== "hub-connection-menu") {
            await click(
              button(name === "hub-connection-replace" ? "更换密钥" : "断开", ".agent-menu"),
            );
            if (name === "hub-connection-replace")
              await type(
                required('.hub-dialog input[type="password"]'),
                "mcphub_preview_fake_replacement_6789",
              );
            if (name === "hub-connection-disconnected") {
              await click(button("确认", ".hub-dialog"));
              await waitFor(() => query(".hub-connection-state"));
            }
          }
        }
        if (name === "hub-search") await type(required('.hub-page input[type="search"]'), "文档");
        if (name === "hub-filter") await click(button("离线"));
        if (
          [
            "hub-add",
            "hub-add-stdio",
            "hub-protocol-menu",
            "hub-add-error",
            "hub-header-rows",
          ].includes(name)
        ) {
          await click(button("添加服务器"));
          if (name !== "hub-add-error") await type(required(".hub-dialog input"), "项目知识库");
          if (name === "hub-add-stdio") await choose("协议", "stdio");
          if (name === "hub-protocol-menu") await click(required('.hub-select[aria-label="协议"]'));
          if (name === "hub-add-error") {
            await click(button("保存", ".hub-dialog"));
            await waitFor(() => query(".hub-field-error:not(:empty)"));
          }
          if (name === "hub-header-rows") {
            await type(required('.hub-header-row input[aria-label="请求头名称"]'), "X-Workspace");
            await type(required('.hub-header-row input[aria-label="请求头内容"]'), "project-docs");
            await click(button("添加一行", ".hub-dialog"));
          }
        }
        if (name === "hub-edit") await action(".hub-server", "编辑");
        if (name === "hub-tools") {
          await click(required(".hub-server-title"));
          await waitFor(() => query(".hub-dialog .hub-list-row"));
        }
        if (name === "hub-server-delete") await action(".hub-server", "删除");
        if (name === "hub-server-disable")
          await click(required('.hub-server button[role="switch"]'));
        if (["hub-key-create", "hub-scope-menu", "hub-key-exclude"].includes(name)) {
          await click(button("创建密钥"));
          await type(required(".hub-dialog input"), "测试连接");
          if (name === "hub-scope-menu")
            await click(required('.hub-select[aria-label="访问范围"]'));
          else
            await choose(
              "访问范围",
              name === "hub-key-exclude" ? "除所选服务器外" : "仅所选服务器",
            );
          if (name === "hub-key-exclude") await click(required(".hub-server-choices input"));
        }
        if (name === "hub-key-edit") await action(".hub-key", "编辑");
        if (name === "hub-key-delete") await action(".hub-key", "删除");
        if (["hub-key-regenerate", "hub-key-reveal"].includes(name)) {
          await action(".hub-key", "重新生成");
          if (name === "hub-key-reveal") {
            await click(button("确认", ".hub-dialog"));
            await waitFor(() => query(".hub-dialog textarea[readonly]"));
          }
        }
        if (name === "hub-auth-disable")
          await click(required('.hub-setting-row button[role="switch"]'));
        if (name === "hub-auth-header") await click(required('[aria-label="编辑认证请求头"]'));
        if (["hub-memory-search", "hub-memory-empty"].includes(name)) {
          const input = required('.hub-page input[type="search"]');
          await type(input, name.endsWith("empty") ? "不存在的内容" : "构建");
          await key(input, "Enter");
        }
        if (name === "hub-memory-source") await choose("来源", "Codex");
        if (name === "hub-memory-page") {
          const next = await waitFor(() =>
            queryAll<HTMLButtonElement>(".hub-pagination button").find(
              (item) => item.textContent === "下一页",
            ),
          );
          await click(next);
        }
        if (name === "hub-memory-detail") {
          await click(required(".hub-memory-title"));
          await waitFor(() => query(".hub-memory-text"));
        }
        if (name === "hub-hover") await hover(required('[aria-label="刷新"]'));
        if (name === "hub-focus") {
          await key(required('.hub-page input[type="search"]'), "Tab");
        }
        if (name === "hub-memory-hover") await hover(required(".hub-memory-title"));
        if (name === "hub-memory-focus")
          await key(required('.hub-page input[type="search"]'), "Tab");
        if (name === "hub-server-menu") await action(".hub-server");
        if (name === "hub-key-menu") await action(".hub-key");
        if (name === "hub-source-menu") await click(required('.hub-select[aria-label="来源"]'));
      },
    ]),
  );
}
