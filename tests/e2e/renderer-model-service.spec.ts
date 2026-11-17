import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createAppearanceSettingsPage } from "./packages/renderer-extension/src/settings/appearance-page.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { installRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";
      globalThis.setupModelService = (failSave = false) => {
        let settings = {provider:"openai",openai:{configured:false,lastFour:null},gemini:{configured:false,lastFour:null}};
        const calls = [];
        const client = {
          read: async () => structuredClone(settings),
          update: async value => {
            calls.push(value);
            if (failSave && value.key) throw new Error("unauthorized");
            if (value.provider) settings.provider = value.provider;
            if (value.key) settings[value.key.provider] = {configured:value.key.value !== null,lastFour:value.key.value?.slice(-4) ?? null};
            return structuredClone(settings);
          },
          test: async () => ({ok:true,latencyMs:123,errorCode:null}),
        };
        const shell = installRendererSettingsShell([createAppearanceSettingsPage(rendererSettingsMessages("zh-CN"), undefined, client)], rendererSettingsMessages("zh-CN"));
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
    page.getByRole("button", { name: "添加 OpenAI API Key", exact: true }),
  ).toBeEnabled();
}
const openai = (page: Page) => page.locator('[data-provider="openai"]');
async function addKey(page: Page) {
  await openai(page).getByRole("button", { name: "添加 OpenAI API Key", exact: true }).click();
  await openai(page)
    .getByRole("textbox", { name: "OpenAI API Key", exact: true })
    .pressSequentially("fake-private-key-1234");
  await openai(page).getByRole("button", { name: "保存", exact: true }).click();
}

test("keys use collapsed rows, save directly updates state, cancellation drops edits and clearing resets the row", async ({
  page,
}) => {
  await setup(page);
  const section = page.getByRole("region", { name: "模型服务", exact: true });
  await expect(section.locator("input:visible")).toHaveCount(0);
  await expect(section.getByRole("button", { name: "保存", exact: true })).toBeHidden();
  await expect(openai(page)).toContainText("未配置");
  await addKey(page);
  await expect(openai(page)).toContainText("已配置 ···1234");
  await expect(openai(page).locator("input")).toBeHidden();
  await expect(openai(page).locator("input")).toHaveValue("");
  await expect(section).not.toContainText("已保存");
  await openai(page).getByRole("button", { name: "测试", exact: true }).click();
  await expect(openai(page)).toContainText("已配置 ···1234 · 连接成功 123 毫秒");
  const change = openai(page).getByRole("button", { name: "更换 OpenAI API Key", exact: true });
  await change.click();
  const input = openai(page).getByRole("textbox", { name: "OpenAI API Key", exact: true });
  await input.pressSequentially("fake-unsaved-key-5678");
  await openai(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(openai(page).locator("input")).toHaveValue("");
  await expect(input).toBeHidden();
  await expect(change).toBeFocused();
  await openai(page).getByRole("button", { name: "清除", exact: true }).click();
  await expect(openai(page)).toContainText("未配置");
  await expect(
    openai(page).getByRole("button", { name: "添加 OpenAI API Key", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(globalThis, "modelFixture").calls)).toEqual([
    { key: { provider: "openai", value: "fake-private-key-1234" } },
    { key: { provider: "openai", value: null } },
  ]);
});

test("Escape cancels edits and closes the model menu before the settings shell", async ({
  page,
}) => {
  await setup(page);
  await openai(page).getByRole("button", { name: "添加 OpenAI API Key", exact: true }).click();
  await openai(page).getByRole("textbox", { name: "OpenAI API Key", exact: true }).press("Escape");
  await expect(openai(page).locator("input")).toBeHidden();
  const picker = page.getByRole("button", { name: "解析模型", exact: true });
  await picker.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "解析模型", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(1);
  await expect(menu).not.toContainText("Gemini");
  await expect(
    menu.getByRole("menuitemradio", { name: "OpenAI · gpt-4.1-mini", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveText("OpenAI · gpt-4.1-mini");
  await expect(menu).toBeHidden();
  await picker.click();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(picker).toBeVisible();
  await expect(picker).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(globalThis, "modelFixture").calls)).toEqual([]);
});

test("save failures remain editable with Chinese copy and clear on cancel", async ({ page }) => {
  await setup(page, true);
  await addKey(page);
  const input = openai(page).getByRole("textbox", { name: "OpenAI API Key", exact: true });
  await expect(input).toBeVisible();
  await expect(openai(page).getByRole("status")).toHaveText("OpenAI Key 无效");
  await openai(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(openai(page).getByRole("status")).toHaveText("未配置");
  await expect(openai(page).locator("input")).toHaveValue("");
});
