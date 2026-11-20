import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createDefaultRendererSettingsPages } from "./packages/renderer-extension/src/settings/pages.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { installRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";
      globalThis.setupModelService = (failSave = false) => {
        let settings = {gemini:{configured:false,lastFour:null}};
        const calls = [];
        const client = {
          read: async () => structuredClone(settings),
          update: async value => {
            calls.push(value);
            if (failSave && value.key) throw new Error("unauthorized");
            if (value.key) settings[value.key.provider] = {configured:value.key.value !== null,lastFour:value.key.value?.slice(-4) ?? null};
            return structuredClone(settings);
          },
          test: async () => ({ok:true,latencyMs:123,errorCode:null}),
        };
        const messages = rendererSettingsMessages("zh-CN");
        const workbench = { modelService: client, jarvis: { createClient: () => null } };
        const pages = createDefaultRendererSettingsPages(messages, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workbench);
        const shell = installRendererSettingsShell(pages, messages);
        shell.openSettings(undefined,"appearance");
        globalThis.modelFixture = {calls,shell};
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "model-service-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
async function setup(page: Page, failSave = false) {
  await page.route("http://localhost/model-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("http://localhost/model-test");
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
  await page.evaluate((value) => Reflect.get(globalThis, "setupModelService")(value), failSave);
  await expect(
    page.getByRole("button", { name: "添加 Gemini API Key", exact: true }),
  ).toBeEnabled();
}
const gemini = (page: Page) => page.locator('[data-provider="gemini"]');
async function addKey(page: Page) {
  await gemini(page).getByRole("button", { name: "添加 Gemini API Key", exact: true }).click();
  await gemini(page)
    .getByRole("textbox", { name: "Gemini API Key", exact: true })
    .pressSequentially("fake-private-key-1234");
  await gemini(page).getByRole("button", { name: "保存", exact: true }).click();
}

test("keys use collapsed rows, save directly updates state, cancellation drops edits and clearing resets the row", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByRole("button", { name: "Jarvis", exact: true })).toBeVisible();
  await expect(
    page.locator('[data-page-id="session-import"], [data-page-id="harness-schedules"]'),
  ).toHaveCount(0);
  const section = page.getByRole("region", { name: "模型服务", exact: true });
  await expect(section.locator("input:visible")).toHaveCount(0);
  await expect(page.locator('[data-provider="openai"]')).toHaveCount(0);
  await expect(section).not.toContainText("OpenAI");
  await expect(section.getByRole("button", { name: "保存", exact: true })).toBeHidden();
  await expect(gemini(page)).toContainText("未配置");
  await addKey(page);
  await expect(gemini(page)).toContainText("已配置 ···1234");
  await expect(gemini(page).locator("input")).toBeHidden();
  await expect(gemini(page).locator("input")).toHaveValue("");
  await expect(section).not.toContainText("已保存");
  await gemini(page).getByRole("button", { name: "测试", exact: true }).click();
  await expect(gemini(page)).toContainText("已配置 ···1234 · 连接成功 123 毫秒");
  const change = gemini(page).getByRole("button", { name: "更换 Gemini API Key", exact: true });
  await change.click();
  const input = gemini(page).getByRole("textbox", { name: "Gemini API Key", exact: true });
  await input.pressSequentially("fake-unsaved-key-5678");
  await gemini(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(gemini(page).locator("input")).toHaveValue("");
  await expect(input).toBeHidden();
  await expect(change).toBeFocused();
  await gemini(page).getByRole("button", { name: "清除", exact: true }).click();
  await expect(gemini(page)).toContainText("未配置");
  await expect(
    gemini(page).getByRole("button", { name: "添加 Gemini API Key", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(globalThis, "modelFixture").calls)).toEqual([
    { key: { provider: "gemini", value: "fake-private-key-1234" } },
    { key: { provider: "gemini", value: null } },
  ]);
});

test("Escape cancels key editing and the parser model is static text", async ({ page }) => {
  await setup(page);
  await gemini(page).getByRole("button", { name: "添加 Gemini API Key", exact: true }).click();
  await gemini(page).getByRole("textbox", { name: "Gemini API Key", exact: true }).press("Escape");
  await expect(gemini(page).locator("input")).toBeHidden();
  const model = page.locator("#model-service-provider");
  await expect(model).toHaveText("Gemini · gemini-3.5-flash-lite");
  await expect(model).toHaveClass(/text-settings-muted/u);
  expect(await model.evaluate((element) => element.tagName)).toBe("SPAN");
  await expect(model.locator("svg")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "解析模型", exact: true })).toHaveCount(0);
  await model.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await model.evaluate((element) => element.matches(":focus"))).toBe(false);
  expect(await page.evaluate(() => Reflect.get(globalThis, "modelFixture").calls)).toEqual([]);
});

test("save failures remain editable with Chinese copy and clear on cancel", async ({ page }) => {
  await setup(page, true);
  await addKey(page);
  const input = gemini(page).getByRole("textbox", { name: "Gemini API Key", exact: true });
  await expect(input).toBeVisible();
  await expect(gemini(page).getByRole("status")).toHaveText("Gemini Key 无效");
  await gemini(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(gemini(page).getByRole("status")).toHaveText("未配置");
  await expect(gemini(page).locator("input")).toHaveValue("");
});
