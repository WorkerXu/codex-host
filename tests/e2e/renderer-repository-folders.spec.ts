import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const executablePath = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (executablePath) test.use({ launchOptions: { executablePath } });
const { outputFiles } = await build({
  stdin: {
    contents: `
  import {mountThreadFoldersPreview} from "./tools/ui-preview/src/thread-folders.ts";
  import {createRepositoryPreviewClient} from "./tools/ui-preview/src/code-repositories.ts";
  import {createAppearanceSettingsPage} from "./packages/renderer-extension/src/settings/appearance-page.ts";
  import {rendererSettingsMessages} from "./packages/renderer-extension/src/settings/localization.ts";
  import {installRendererSettingsShell} from "./packages/renderer-extension/src/settings/shell.ts";
  globalThis.mountRepositoryFixture = (settings) => {
    if(settings){const messages=rendererSettingsMessages("zh-CN");const shell=installRendererSettingsShell([createAppearanceSettingsPage(messages,undefined,null,createRepositoryPreviewClient("unconfigured"))],messages);shell.openSettings(undefined,"appearance");}
    else mountThreadFoldersPreview(document.body,location.hash.slice(1)||"thread-folders-local");
  };`,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".html": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
const css = process.env.CODEX_DESKTOP_CSS
  ? readFileSync(process.env.CODEX_DESKTOP_CSS, "utf8")
  : "";
async function setup(
  page: Page,
  state = "ready",
  remote = false,
  theme = "light",
  settings = false,
  picker = "selected",
) {
  await page.route("http://localhost/repository-test**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body></body></html>`,
    }),
  );
  await page.goto(
    `http://localhost/repository-test?repository=${state}&picker=${picker}#thread-folders-${remote ? "remote" : "local"}`,
  );
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
  await page.evaluate(
    (value) => Reflect.get(globalThis, "mountRepositoryFixture")(value),
    settings,
  );
  if (settings) return;
  await page.getByRole("button", { name: "工作文件夹 · codexhost", exact: true }).click();
  await page.getByRole("button", { name: "从仓库添加…", exact: true }).click();
}

for (const theme of ["light", "dark"]) {
  test(`repository tabs, server-side search and keyboard navigation (${theme})`, async ({
    page,
  }) => {
    await setup(page, "ready", false, theme);
    const dialog = page.getByRole("dialog", { name: "从仓库添加工作文件夹" });
    await expect(dialog).toBeVisible();
    const search = dialog.getByRole("searchbox", { name: "搜索我的仓库" });
    await search.pressSequentially("shared");
    await expect(page.locator("body")).toHaveAttribute(
      "data-repository-query",
      JSON.stringify({ provider: "github", search: "shared" }),
    );
    await expect(
      dialog.getByRole("button", { name: "WorkerXu/shared-ui", exact: true }),
    ).toBeVisible();
    await search.press("ArrowDown");
    await expect(
      dialog.getByRole("button", { name: "WorkerXu/shared-ui", exact: true }),
    ).toBeFocused();
    await dialog.getByRole("tab", { name: "GitLab", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "研发中心 / 基础平台/platform-console", exact: true }),
    ).toBeVisible();
    await expect(search).toHaveValue("");
    await dialog.getByRole("tab", { name: "GitLab", exact: true }).press("ArrowLeft");
    await expect(dialog.getByRole("tab", { name: "GitHub", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}

test("clones to the local default, uses the native target picker and adds only on completion", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "WorkerXu/codex-host", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-repository-native-picker", "directory");
  await expect(page.getByRole("dialog")).toContainText("/Users/lin/Downloads");
  await page.getByRole("button", { name: "更改位置…", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-repository-native-picker", "directory");
  await page.getByRole("button", { name: "克隆并添加", exact: true }).click();
  await expect(page.locator(".codexhost-repo-progress")).toContainText("列出克隆传输完成");
  await expect(page.locator("body")).not.toHaveAttribute("data-folder-selection");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-folder-selection",
    JSON.stringify(["/Users/lin/Projects/codexhost", "/Users/lin/Downloads/codex-host"]),
  );
});

for (const state of ["cloning", "transferring"]) {
  test(`active ${state} keeps keyboard focus and asks before closing`, async ({ page }) => {
    await setup(page, state, true);
    await page.getByRole("button", { name: "WorkerXu/codex-host", exact: true }).click();
    await page.getByRole("button", { name: "克隆并添加", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(
      state === "cloning" ? "正在克隆…" : "正在传输…",
    );
    const current = page.locator('.codexhost-repo-progress [aria-current="step"]');
    await expect(current).toHaveText(state === "cloning" ? "克隆" : "传输");
    await expect(page.locator('.codexhost-repo-progress [data-state="done"]')).toHaveCount(
      state === "cloning" ? 1 : 2,
    );
    const close = page.getByRole("button", { name: "关闭", exact: true });
    await expect(close.locator("svg")).toHaveCount(1);
    await close.focus();
    // A job refresh must not replace the close control or restart its focus state.
    await page.waitForTimeout(1100);
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toContainText("克隆或传输会继续");
    await expect(page.getByRole("button", { name: "继续查看", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(current).toHaveText(state === "cloning" ? "克隆" : "传输");
    await close.click();
    await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveAttribute("data-folder-selection");
  });
}

test("continuing to watch preserves automatic addition when a job completes", async ({ page }) => {
  await setup(page, "ready", true);
  await page.getByRole("button", { name: "WorkerXu/codex-host", exact: true }).click();
  await page.getByRole("button", { name: "克隆并添加", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "继续查看", exact: true }).click();
  await expect(page.getByRole("heading", { name: "工作文件夹已添加", exact: true })).toBeVisible();
  await expect(page.locator('.codexhost-repo-progress [data-state="done"]')).toHaveCount(4);
  await expect(page.locator(".codexhost-repo-progress [aria-current]")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-folder-selection", /codex-host/);
});

test("remote targets reuse the directory subview and bypass the Mac folder picker", async ({
  page,
}) => {
  await setup(page, "ready", true);
  await page.getByRole("button", { name: "WorkerXu/codex-host", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("/home/ubuntu/projects");
  await page.getByRole("button", { name: "更改位置…", exact: true }).click();
  const input = page.getByRole("textbox", { name: "远程文件夹路径", exact: true });
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "/home/ubuntu/projects/workspace", exact: true }).click();
  await expect(input).toHaveValue("/home/ubuntu/projects/workspace");
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("/home/ubuntu/projects/workspace");
  await expect(page.locator("body")).not.toHaveAttribute("data-repository-native-picker");
  await page.getByRole("button", { name: "克隆并添加", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-folder-selection",
    JSON.stringify([
      "/home/ubuntu/Projects/codexhost",
      "/home/ubuntu/projects/workspace/codex-host",
    ]),
  );
});

test("local target cancellation preserves Downloads and an unavailable picker falls back to browsing", async ({
  page,
}) => {
  for (const picker of ["cancel", "unavailable"]) {
    await setup(page, "ready", false, "light", false, picker);
    await page.getByRole("button", { name: "WorkerXu/codex-host", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-repository-native-picker",
      "directory",
    );
    if (picker === "cancel") {
      await expect(page.getByRole("textbox", { name: "文件夹路径", exact: true })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toContainText("/Users/lin/Downloads");
    } else {
      const input = page.getByRole("textbox", { name: "文件夹路径", exact: true });
      await expect(input).toHaveValue("/Users/lin/Downloads");
      await input.press("Escape");
      await expect(input).toHaveCount(0);
      await expect(page.getByRole("button", { name: "克隆并添加", exact: true })).toBeVisible();
    }
    await expect(page.locator("body")).not.toHaveAttribute("data-folder-selection");
  }
});

test("existing directories require an explicit choice and are never overwritten", async ({
  page,
}) => {
  await setup(page, "conflict");
  await page.getByRole("button", { name: "WorkerXu/codex-host", exact: true }).click();
  await page.getByRole("button", { name: "克隆并添加", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("不会克隆或覆盖");
  await expect(page.locator("body")).not.toHaveAttribute("data-folder-selection");
  await page.getByRole("button", { name: "使用已有文件夹", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-folder-selection",
    /Downloads\/codex-host/,
  );
});

test("list loading, empty, permission and clone failure states are localized", async ({ page }) => {
  for (const state of ["loading", "empty", "error", "unconfigured", "clone-error"]) {
    await setup(page, state);
    if (state === "loading") await expect(page.getByRole("status")).toContainText("正在列出仓库");
    if (state === "empty") await expect(page.getByRole("status")).toContainText("暂无可添加的仓库");
    if (state === "error") await expect(page.getByRole("alert")).toContainText("连接失败");
    if (state === "unconfigured") {
      await page.getByRole("tab", { name: "GitLab", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("GitLab 访问令牌");
    }
    if (state === "clone-error") {
      await page.getByRole("button", { name: "WorkerXu/codex-host", exact: true }).click();
      await page.getByRole("button", { name: "克隆并添加", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("仓库没有权限");
      await expect(page.locator("body")).not.toHaveAttribute("data-folder-selection");
    }
  }
});

test("repository settings mask credentials, test, replace, cancel and clear them", async ({
  page,
}) => {
  await setup(page, "ready", false, "light", true);
  const section = page.getByRole("region", { name: "代码仓库", exact: true });
  await expect(section).toContainText("已登录 · WorkerXu");
  await section.getByRole("button", { name: "添加 GitLab 访问令牌", exact: true }).click();
  const input = section.getByRole("textbox", {
    name: "GitLab 访问令牌",
    exact: true,
    includeHidden: true,
  });
  await input.pressSequentially("preview-only-1234");
  await expect(input).toHaveAttribute("type", "password");
  await section.getByRole("button", { name: "保存", exact: true }).click();
  await expect(section).toContainText("已配置 ···1234");
  await expect(input).toHaveValue("");
  await section.getByRole("button", { name: "测试", exact: true }).click();
  await expect(section).toContainText("连接成功");
  const edit = section.getByRole("button", { name: "更换 GitLab 访问令牌", exact: true });
  await edit.click();
  await input.pressSequentially("unsaved-preview");
  await input.press("Escape");
  await expect(input).toBeHidden();
  await expect(input).toHaveValue("");
  await section.getByRole("button", { name: "清除", exact: true }).click();
  await expect(section).toContainText("未配置");
});
