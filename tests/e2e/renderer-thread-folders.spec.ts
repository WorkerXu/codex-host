import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
    import {mountThreadFoldersPreview} from "./tools/ui-preview/src/thread-folders.ts";
    mountThreadFoldersPreview(document.body, location.hash.slice(1) || 'thread-folders-existing');
  `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text" },
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Folder control fixture bundle is missing");

test("multi-select and main folder apply to an existing conversation; Escape returns focus", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: bundle });
  const trigger = page.getByRole("button", { name: "工作文件夹 · codexhost", exact: true });
  await trigger.click();
  await page.getByRole("checkbox", { name: "/Users/lin/Projects/shared-ui", exact: true }).check();
  const main = page.getByRole("button", { name: "设为主要", exact: true });
  await main.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("checkbox").first()).toHaveAttribute(
    "aria-label",
    "/Users/lin/Projects/shared-ui",
  );
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "工作文件夹已改为 /Users/lin/Projects/shared-ui、/Users/lin/Projects/codexhost",
  );
  await page.getByRole("button", { name: "工作文件夹 · shared-ui +1", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "工作文件夹 · shared-ui +1", exact: true }),
  ).toBeFocused();
});

test("read-only remote directory completion accepts keyboard input and keeps the popover in the viewport", async ({
  page,
}) => {
  await page.goto("about:blank#thread-folders-remote");
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "工作文件夹 · codexhost", exact: true }).click();
  await page.getByRole("button", { name: "添加文件夹…", exact: true }).click();
  const input = page.getByRole("textbox", { name: "远程文件夹路径", exact: true });
  await input.fill("/home/ubuntu/Projects/");
  await page.getByRole("button", { name: "/home/ubuntu/Projects/sandbox", exact: true }).click();
  await input.fill("/home/ubuntu/Projects/sandbox/frontend");
  await input.press("Enter");
  await expect(
    page.getByRole("checkbox", { name: "/home/ubuntu/Projects/sandbox/frontend", exact: true }),
  ).toBeChecked();
  const bounds = await page.getByRole("dialog").boundingBox();
  expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 720).toBeTruthy();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "工作文件夹 · codexhost +1", exact: true }),
  ).toBeVisible();
});

test("an empty selection cannot apply and limited adapters explain their main-folder behavior", async ({
  page,
}) => {
  await page.goto("about:blank#thread-folders-limited");
  await page.addScriptTag({ content: bundle });
  const trigger = page.getByRole("button", { name: "工作文件夹 · codexhost", exact: true });
  await expect(trigger).toHaveAttribute("title", /仅使用主要文件夹/u);
  await trigger.click();
  await page
    .getByRole("checkbox", { name: "/Users/lin/Projects/codexhost", exact: true })
    .uncheck();
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeDisabled();
});
