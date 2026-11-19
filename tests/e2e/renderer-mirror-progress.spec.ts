import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import {
        createProjectMirrorProgress,
        projectMirrorProgressText,
      } from "./packages/renderer-extension/src/renderer-project-mirror-progress.ts";

      globalThis.setupMirrorProgress = (input) => {
        document.body.replaceChildren();
        const shell = document.createElement("div");
        shell.style.cssText = "position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:center;padding:16px 24px 24px";
        const composer = document.createElement("div");
        composer.id = "composer";
        composer.style.cssText =
          "width:620px;height:112px;border-radius:16px;border:1px solid var(--color-border);" +
          "background:var(--color-surface);box-shadow:0 8px 24px rgba(0,0,0,0.12);" +
          "font:400 13px/18px system-ui;color:var(--color-text-tertiary);padding:16px 18px;box-sizing:border-box";
        composer.textContent = "要求后续操作";
        shell.append(composer);
        document.body.append(shell);
        const text = projectMirrorProgressText({ machineLabel: input.machineLabel, local: false });
        globalThis.mirrorProgress = createProjectMirrorProgress({
          document,
          anchor: composer,
          text,
          successMs: 60000,
          errorMs: 60000,
        });
        return globalThis.mirrorProgress.element.getBoundingClientRect().toJSON();
      };
      globalThis.advanceMirrorProgress = (stage) => globalThis.mirrorProgress.step(stage);
      globalThis.finishMirrorProgress = () => globalThis.mirrorProgress.done();
      globalThis.failMirrorProgress = (message) => globalThis.mirrorProgress.fail(message);
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-mirror-progress-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  platform: "browser",
  target: "es2024",
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Mirror progress E2E bundle was not generated");

const LIGHT = `
  :root {
    --color-surface: #ffffff;
    --color-surface-elevated-secondary: #ffffff;
    --color-text: #1a1a1a;
    --color-text-tertiary: #8b8b8b;
    --color-border: rgba(0, 0, 0, 0.12);
    --color-chart-green: #17a34a;
    --color-chart-red: #e5484d;
    --max-app-overlay-z-index: 2147480000;
    --toast-z-index: calc(2147480000 - 1);
    background: #f7f7f8;
    color: #1a1a1a;
  }
`;
const DARK = `
  :root {
    --color-surface: #262626;
    --color-surface-elevated-secondary: #262626;
    --color-text: #f2f2f2;
    --color-text-tertiary: #9b9b9b;
    --color-border: rgba(255, 255, 255, 0.14);
    --color-chart-green: #3fb950;
    --color-chart-red: #f85149;
    --max-app-overlay-z-index: 2147480000;
    --toast-z-index: calc(2147480000 - 1);
    background: #1b1b1b;
    color: #f2f2f2;
  }
`;

const pageHtml = (theme: string): string =>
  `<!doctype html><html><head><style>${theme} body { margin: 0; font: 400 13px/18px system-ui, sans-serif; }</style></head><body></body></html>`;

const setup = async (page: Page, theme: string, machineLabel: string): Promise<void> => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.setContent(pageHtml(theme));
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate((label) => {
    const setup = Reflect.get(globalThis, "setupMirrorProgress");
    if (typeof setup !== "function") throw new Error("Mirror progress setup is unavailable");
    setup({ machineLabel: label });
  }, machineLabel);
};

test("prepares, then shows the trust hint only while creating, and ends upright", async ({
  page,
}) => {
  await setup(page, LIGHT, "甲骨文新加坡");
  const card = page.locator("[data-codexhost-project-mirror-progress]");
  await expect(card).toBeVisible();
  await expect(card).toContainText("正在 甲骨文新加坡 上准备项目…");
  await expect(card).not.toContainText("信任这个文件夹");

  const zIndex = await card.evaluate((element) => Number(getComputedStyle(element).zIndex));
  expect(zIndex).toBeLessThan(2_147_480_000);

  const [cardBox, composerBox] = await Promise.all([
    card.boundingBox(),
    page.locator("#composer").boundingBox(),
  ]);
  if (!cardBox || !composerBox) throw new Error("Mirror progress geometry is unavailable");
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(composerBox.y - 8);
  expect(cardBox.x).toBeGreaterThanOrEqual(8);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(1_280 - 8);

  await page.evaluate(() => Reflect.get(globalThis, "advanceMirrorProgress")("create"));
  await expect(card).toContainText("正在 甲骨文新加坡 上创建项目…");
  await expect(card).toContainText("接下来 Desktop 会请你确认信任这个文件夹");
  await page.screenshot({ path: test.info().outputPath("mirror-progress-light-creating.png") });

  await page.evaluate(() => Reflect.get(globalThis, "advanceMirrorProgress")("section"));
  await expect(card).toContainText("加入分区…");
  await expect(card).not.toContainText("信任这个文件夹");
  await page.evaluate(() => Reflect.get(globalThis, "advanceMirrorProgress")("open"));
  await expect(card).toContainText("打开新对话…");
  await page.evaluate(() => Reflect.get(globalThis, "finishMirrorProgress")());
  await expect(card).toContainText("已在新对话中打开");

  const mark = card.locator(":scope > span").first();
  await expect(mark).toHaveText("✓");
  expect(await mark.evaluate((element) => element.getAnimations().length)).toBe(0);
  expect(await mark.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
  await page.screenshot({ path: test.info().outputPath("mirror-progress-light-done.png") });
});

test("keeps the creating and error states readable in dark mode", async ({ page }) => {
  await setup(page, DARK, "甲骨文新加坡");
  const card = page.locator("[data-codexhost-project-mirror-progress]");
  await expect(card).toBeVisible();
  await expect(card).toContainText("正在 甲骨文新加坡 上准备项目…");
  await page.evaluate(() => Reflect.get(globalThis, "advanceMirrorProgress")("create"));
  await expect(card).toContainText("正在 甲骨文新加坡 上创建项目…");
  await page.screenshot({ path: test.info().outputPath("mirror-progress-dark-creating.png") });

  await page.evaluate(() =>
    Reflect.get(globalThis, "failMirrorProgress")("项目已创建，但未能自动加入同一分区"),
  );
  await expect(card).toContainText("项目已创建，但未能自动加入同一分区");
  const color = await card.evaluate((element) => getComputedStyle(element).color);
  expect(color).toBe("rgb(242, 242, 242)");
  const mark = card.locator(":scope > span").first();
  await expect(mark).toHaveText("!");
  expect(await mark.evaluate((element) => element.getAnimations().length)).toBe(0);
  expect(await mark.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
  await page.screenshot({ path: test.info().outputPath("mirror-progress-dark-error.png") });
});
