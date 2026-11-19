import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createMcpAdminPage } from "./packages/renderer-extension/src/settings/mcp-admin-page.ts";

      globalThis.setupMcpPage = (config = {}) => {
        const ops = [];
        const servers = (config.servers ?? []).map((server) => ({
          version: "1.0.0",
          status: "online",
          type: "streamable-http",
          tools: 1,
          prompts: 0,
          resources: 0,
          calls: null,
          ...server,
        }));
        const keys = (config.keys ?? []).map((key) => ({
          id: key.id ?? "key-" + key.name,
          name: key.name,
          masked: "••••••••",
          enabled: true,
          accessType: "all",
          servers: [],
          groups: [],
          kind: "system",
          ...key,
        }));
        let configured = config.configured !== false;
        const client = {
          hosts: async () => [{ hostId: "local", displayName: "本机" }],
          async request(_host, input) {
            ops.push(input.op);
            switch (input.op) {
              case "mcpOverview":
                return {
                  configured,
                  last4: configured ? "1234" : null,
                  servers: configured ? structuredClone(servers) : null,
                  keys: configured
                    ? { enabled: true, headerName: "Authorization", keys: structuredClone(keys) }
                    : null,
                };
              case "keys":
                return { enabled: true, headerName: "Authorization", keys: structuredClone(keys) };
              case "serverToggle": {
                const server = servers.find((item) => item.name === input.name);
                if (server) server.status = input.enabled ? "online" : "disabled";
                return { ok: true };
              }
              case "serverDelete": {
                const index = servers.findIndex((item) => item.name === input.name);
                if (index >= 0) servers.splice(index, 1);
                return { ok: true };
              }
              case "keyDelete": {
                const index = keys.findIndex((item) => item.id === input.id);
                if (index >= 0) keys.splice(index, 1);
                return { ok: true };
              }
              case "mcpConnection":
                return { configured, last4: configured ? "1234" : null };
              default:
                return { ok: true };
            }
          },
        };
        const page = createMcpAdminPage({ createClient: () => client });
        const controller = new AbortController();
        const content = document.createElement("div");
        document.body.append(content);
        const dispose = page.mount({
          content,
          signal: controller.signal,
          async runLatest(operation, handlers) {
            try {
              handlers.success(await operation(controller.signal));
            } catch (error) {
              handlers.failure(error);
            }
          },
        });
        globalThis.mcpFixture = {
          ops,
          servers,
          keys,
          dispose() {
            controller.abort();
            dispose?.();
            content.remove();
          },
        };
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "mcp-page-tabs-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("MCP page tabs fixture bundle missing");

type FixtureConfig = {
  configured?: boolean;
  servers?: { name: string; status?: string; type?: string }[];
  keys?: { name: string; id?: string }[];
};
const serverNames = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `服务器${String(index + 1).padStart(2, "0")}`,
  }));

async function setup(page: Page, config: FixtureConfig = {}) {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.route("http://localhost/mcp-tabs", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("http://localhost/mcp-tabs");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((value) => Reflect.get(globalThis, "setupMcpPage")(value), config);
}
const tab = (page: Page, index: number) => page.locator('.hub-page-tabs [role="tab"]').nth(index);
const pager = (page: Page) => page.locator(".hub-pagination");
const keysOpCount = (page: Page) =>
  page.evaluate(
    () =>
      (Reflect.get(globalThis, "mcpFixture").ops as string[]).filter((op) => op === "keys").length,
  );

test("shows exactly twelve servers without a pager and a second page for thirteen", async ({
  page,
}) => {
  await setup(page, { servers: serverNames(12) });
  await expect(page.locator(".hub-server")).toHaveCount(12);
  await expect(pager(page)).toHaveCount(0);
  await expect(tab(page, 0)).toHaveAttribute("aria-label", "服务器 12");
  await expect(tab(page, 0)).toHaveAttribute("aria-selected", "true");

  await page.evaluate(() => Reflect.get(globalThis, "mcpFixture").dispose());
  await page.evaluate(() =>
    Reflect.get(
      globalThis,
      "setupMcpPage",
    )({
      servers: Array.from({ length: 13 }, (_, index) => ({
        name: `服务器${String(index + 1).padStart(2, "0")}`,
      })),
    }),
  );
  await expect(page.locator(".hub-server")).toHaveCount(12);
  await expect(pager(page)).toContainText("第 1 / 2 页");
  await pager(page).getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".hub-server")).toHaveCount(1);
  await expect(pager(page)).toContainText("第 2 / 2 页");
  await expect(pager(page).getByRole("button", { name: "下一页" })).toBeDisabled();
});

test("resets to the first page when the search or status filter changes", async ({ page }) => {
  await setup(page, { servers: serverNames(13) });
  await expect(page.locator(".hub-server")).toHaveCount(12);
  await pager(page).getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".hub-server")).toHaveCount(1);

  await page.getByRole("searchbox", { name: "搜索服务器" }).fill("服务器");
  await expect(page.locator(".hub-server")).toHaveCount(12);
  await expect(pager(page)).toContainText("第 1 / 2 页");

  await pager(page).getByRole("button", { name: "下一页" }).click();
  await page.locator(".hub-tabs").getByRole("button", { name: "在线" }).click();
  await expect(page.locator(".hub-server")).toHaveCount(12);
  await expect(pager(page)).toContainText("第 1 / 2 页");
});

test("clamps to the previous page after deleting the last card on the last page", async ({
  page,
}) => {
  await setup(page, { servers: serverNames(13) });
  await pager(page).getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".hub-server")).toHaveCount(1);
  await page.locator(".hub-server button[aria-haspopup='menu']").click();
  await page.getByRole("menu").getByRole("menuitem", { name: "删除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
  await expect(page.locator(".hub-server")).toHaveCount(12);
  await expect(pager(page)).toHaveCount(0);
});

test("keeps the current page when a server switch is toggled", async ({ page }) => {
  const servers = [...serverNames(12), { name: "服务器13", status: "disabled" }];
  await setup(page, { servers });
  await pager(page).getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".hub-server")).toHaveCount(1);
  await page.locator(".hub-server button[role='switch']").click();
  await expect(page.locator(".hub-server button[role='switch']")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator(".hub-server")).toHaveCount(1);
  await expect(pager(page)).toContainText("第 2 / 2 页");
});

test("loads keys only when the 密钥 tab first opens", async ({ page }) => {
  await setup(page, {
    servers: serverNames(6),
    keys: [{ name: "工作助手" }, { name: "只读检索" }],
  });
  await expect(page.locator(".hub-server")).toHaveCount(6);
  await expect(page.locator(".hub-key")).toHaveCount(0);
  expect(await keysOpCount(page)).toBe(0);
  const serverPanel = page.locator('[aria-labelledby="hub-mcp-tab-servers"]');
  await expect(serverPanel.getByText("Bearer 认证")).toHaveCount(0);

  await tab(page, 1).click();
  await expect(page.locator(".hub-key")).toHaveCount(2);
  expect(await keysOpCount(page)).toBe(1);
  const keysPanel = page.locator('[aria-labelledby="hub-mcp-tab-keys"]');
  await expect(keysPanel.getByText("Bearer 认证")).toBeVisible();
  await expect(keysPanel.getByRole("button", { name: "创建密钥" })).toBeVisible();
});

test("remembers the selected tab for the rest of the session", async ({ page }) => {
  await setup(page, { servers: serverNames(2), keys: [{ name: "工作助手" }] });
  await tab(page, 1).click();
  await expect(page.locator(".hub-key")).toHaveCount(1);

  await page.evaluate(() => Reflect.get(globalThis, "mcpFixture").dispose());
  await page.evaluate(() =>
    Reflect.get(
      globalThis,
      "setupMcpPage",
    )({
      servers: [{ name: "服务器01" }],
      keys: [{ name: "工作助手" }],
    }),
  );
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".hub-key")).toHaveCount(1);
});

test("shows no tabs while MCPHub is not connected", async ({ page }) => {
  await setup(page, { configured: false });
  await expect(page.locator(".hub-connection-state")).toContainText("连接 MCPHub");
  await expect(page.locator(".hub-page-tabs")).toHaveCount(0);
});

test("moves between tabs with the arrow keys", async ({ page }) => {
  await setup(page, { servers: serverNames(1), keys: [{ name: "工作助手" }] });
  await expect(page.locator(".hub-server")).toHaveCount(1);
  await tab(page, 0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, 1)).toBeFocused();
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, 0)).toHaveAttribute("aria-selected", "false");
  await expect(page.locator(".hub-key")).toHaveCount(1);

  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, 0)).toBeFocused();
  await expect(tab(page, 0)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".hub-server")).toHaveCount(1);
});

test("paginates keys after twenty", async ({ page }) => {
  await setup(page, {
    servers: serverNames(1),
    keys: Array.from({ length: 21 }, (_, index) => ({ name: `密钥${index + 1}` })),
  });
  await tab(page, 1).click();
  await expect(page.locator(".hub-key")).toHaveCount(20);
  await expect(pager(page)).toContainText("第 1 / 2 页");
  await pager(page).getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".hub-key")).toHaveCount(1);
  await expect(pager(page)).toContainText("第 2 / 2 页");
});
