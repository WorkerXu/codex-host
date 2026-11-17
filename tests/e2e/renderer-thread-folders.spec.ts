import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { readFileSync } from "node:fs";

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
  loader: { ".css": "text", ".html": "text" },
  write: false,
});
const fixtureBundle = outputFiles[0]?.text;
const desktopCss = process.env.CODEX_DESKTOP_CSS
  ? readFileSync(process.env.CODEX_DESKTOP_CSS, "utf8")
  : "";
const bundle =
  `(() => {const style = document.createElement("style");style.textContent = ${JSON.stringify(desktopCss)};document.head.append(style);})();` +
  fixtureBundle;
if (!fixtureBundle) throw new Error("Folder control fixture bundle is missing");

test("multi-select and main folder immediately update an existing conversation; Escape returns focus", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: bundle });
  const trigger = page.getByRole("button", { name: "工作文件夹 · codexhost", exact: true });
  await trigger.click();
  await page
    .getByRole("menuitemcheckbox", { name: "/Users/lin/Projects/shared-ui", exact: true })
    .click();
  const main = page.getByRole("button", { name: "设为主要", exact: true });
  await expect(main).toBeEnabled();
  await main.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitemcheckbox").first()).toHaveAttribute(
    "aria-label",
    "/Users/lin/Projects/shared-ui",
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("status")).toHaveAttribute(
    "title",
    "/Users/lin/Projects/shared-ui\n/Users/lin/Projects/codexhost",
  );
  const chipBounds = await page
    .getByRole("button", { name: "工作文件夹 · shared-ui +1", exact: true })
    .boundingBox();
  const menuBounds = await page.getByRole("dialog").boundingBox();
  expect(
    chipBounds &&
      menuBounds &&
      Math.abs(chipBounds.x - menuBounds.x) < 1 &&
      menuBounds.y + menuBounds.height < chipBounds.y,
  ).toBeTruthy();
  await page.keyboard.press("End");
  await expect(page.getByRole("button", { name: "添加文件夹…", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByRole("menuitemcheckbox").first()).toBeFocused();
  await expect(page.getByRole("status")).toContainText(
    "工作文件夹已改为 shared-ui（主要）、codexhost",
  );
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
    page.getByRole("menuitemcheckbox", {
      name: "/home/ubuntu/Projects/sandbox/frontend",
      exact: true,
    }),
  ).toHaveAttribute("aria-checked", "true");
  const bounds = await page.getByRole("dialog").boundingBox();
  expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 720).toBeTruthy();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "工作文件夹 · codexhost +1", exact: true }),
  ).toBeVisible();
});

test("the last folder stays selected and limited adapters explain their main-folder behavior", async ({
  page,
}) => {
  await page.goto("about:blank#thread-folders-limited");
  await page.addScriptTag({ content: bundle });
  const trigger = page.getByRole("button", { name: "工作文件夹 · codexhost", exact: true });
  await expect(trigger).toHaveAttribute("title", /仅使用主要文件夹/u);
  await trigger.click();
  const last = page.getByRole("menuitemcheckbox", {
    name: "/Users/lin/Projects/codexhost",
    exact: true,
  });
  await expect(last).toBeDisabled();
  await expect(last).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: "应用", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
  await page.mouse.click(10, 10);
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("a rejected immediate save preserves the previous selection and shows a localized error", async ({
  page,
}) => {
  await page.goto("about:blank#thread-folders-save-error");
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "工作文件夹 · codexhost", exact: true }).click();
  const extra = page.getByRole("menuitemcheckbox", {
    name: "/Users/lin/Projects/shared-ui",
    exact: true,
  });
  await extra.click();
  await expect(extra).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("alert")).toHaveText("未能保存工作文件夹，请重试");
  await expect(
    page.getByRole("button", { name: "工作文件夹 · codexhost", exact: true }),
  ).toBeEnabled();
  await expect(extra).toBeFocused();
});

test("loading can be dismissed, failures are localized, and an empty catalog offers adding a folder", async ({
  page,
}) => {
  for (const state of ["loading", "error", "empty"]) {
    await page.goto(`about:blank#thread-folders-${state}`);
    await page.setContent("<!doctype html><body></body>");
    await page.addScriptTag({ content: bundle });
    await page.getByRole("button", { name: /^工作文件夹/u }).click();
    if (state === "loading") {
      await expect(
        page.getByRole("status", { name: "" }).filter({ hasText: "正在读取文件夹" }),
      ).toBeVisible();
    } else if (state === "error") {
      await expect(page.getByRole("alert")).toHaveText("无法读取工作文件夹，请检查连接后重试");
    } else {
      await expect(page.getByRole("button", { name: "添加文件夹…", exact: true })).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("button", { name: /^工作文件夹/u })).toBeEnabled();
  }
});
