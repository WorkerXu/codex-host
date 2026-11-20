import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";
import { desktopTheme } from "./desktop-theme.mjs";

const [themeFile, outputPath] = process.argv.slice(2);
if (!themeFile || !outputPath)
  throw new Error("Usage: node tools/ui-preview/capture-hubs.mjs <Desktop CSS> <output directory>");
const output = path.resolve(outputPath);
const theme = desktopTheme(await readFile(themeFile, "utf8"));
if (!theme.colorSchemes) throw new Error("Desktop CSS must include light and dark theme variables");
const { outputFiles } = await build({
  entryPoints: [path.join(import.meta.dirname, "src/hubs.ts")],
  bundle: true,
  write: false,
  platform: "browser",
  target: "es2024",
  format: "iife",
  loader: { ".css": "text", ".svg": "dataurl", ".png": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
});
const script = outputFiles[0].text.replaceAll(/<\/script/giu, "<\\/script");

const skillCard = (page) => page.locator(".skills-card").first();
const serverCard = (page) => page.locator(".hub-server").first();
const memoryRow = (page) => page.locator(".hub-memory-row").first();
const button = (page, name) => page.getByRole("button", { name, exact: true }).first();
const keyboardFocus = async (page, target) => {
  await target.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(target).toBeFocused();
};
const scenarios = {
  async skills(page) {
    await expect(skillCard(page)).toBeVisible();
  },
  async "skills-hover"(page) {
    await expect(skillCard(page)).toBeVisible();
    await page.locator("[data-skills-refresh]").hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
  },
  async "skills-focus"(page) {
    await expect(skillCard(page)).toBeVisible();
    await keyboardFocus(page, page.locator("[data-skills-refresh]"));
  },
  async "skills-link"(page) {
    await expect(skillCard(page)).toBeVisible();
    await page.getByRole("tab", { name: "按 Agent" }).click();
    await button(page, "一键链接").click();
    await expect(page.getByRole("dialog")).toBeVisible();
  },
  async "hub-servers"(page) {
    await expect(serverCard(page)).toBeVisible();
  },
  async "hub-server-menu"(page) {
    await serverCard(page).locator('[aria-haspopup="menu"]').click();
    await expect(page.getByRole("menu")).toBeVisible();
  },
  async "hub-mcp-tab-hover"(page) {
    await expect(serverCard(page)).toBeVisible();
    await page.getByRole("tab", { name: /^密钥/u }).hover();
  },
  async "hub-mcp-tab-focus"(page) {
    await expect(serverCard(page)).toBeVisible();
    await keyboardFocus(page, page.getByRole("tab", { name: /^服务器/u }));
  },
  async "hub-connection-test-error"(page) {
    await button(page, "连接").click();
    const input = page.locator('.hub-dialog input[type="password"]');
    await input.fill("mcphub_preview_fake_key_1234");
    await button(page, "测试并连接").click();
    await expect(page.getByText("密钥不正确")).toBeVisible();
    await expect(input).toHaveValue("");
  },
  async "hub-memory"(page) {
    await expect(memoryRow(page)).toBeVisible();
  },
  async "hub-memory-hover"(page) {
    await memoryRow(page).getByRole("button").hover();
  },
  async "hub-memory-focus"(page) {
    await keyboardFocus(page, memoryRow(page).getByRole("button"));
  },
  async "hub-memory-detail"(page) {
    await memoryRow(page).getByRole("button").click();
    await expect(page.getByRole("dialog")).toBeVisible();
  },
  async "hub-memory-loading"(page) {
    await expect(page.getByText("正在连接 India…")).toBeVisible();
  },
  async "hub-memory-error"(page) {
    await expect(page.getByText("连接失败，重试中")).toBeVisible();
  },
};

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const screenshots = [];
try {
  for (const appearance of ["light", "dark"]) {
    const context = await browser.newContext({
      colorScheme: appearance,
      viewport: { width: 1120, height: 780 },
    });
    // All rendered pages and data are local fixtures.
    await context.route(/^https?:/u, (route) => route.abort());
    try {
      for (const [scenario, perform] of Object.entries(scenarios)) {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const name = `${scenario}-${appearance}`;
        const html = `<!doctype html><html lang="zh-CN" data-theme="${appearance}" data-codex-window-type="electron" data-appearance-preset="codex">
<style>${theme.css}
html { color-scheme: ${appearance}; }
body { margin: 0; background: var(--app-color-background-surface); color: var(--color-text); }
</style><body data-scenario="${scenario}"><script>${script}</script></body></html>`;
        if (["skills", "hub-servers", "hub-memory"].includes(scenario))
          await writeFile(path.join(output, `${name}.html`), html);
        await page.setContent(html);
        await perform(page);
        expect(errors).toEqual([]);
        for (const overlay of await page.locator("dialog[open], .hub-menu").all()) {
          const bounds = await overlay.boundingBox();
          expect(bounds?.x).toBeGreaterThanOrEqual(0);
          expect(bounds?.y).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(1120);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(780);
        }
        const screenshot = `${name}.png`;
        await page.screenshot({ path: path.join(output, screenshot), animations: "disabled" });
        screenshots.push(screenshot);
        await page.close();
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  path.join(output, "report.json"),
  JSON.stringify({ desktopStylesheet: path.resolve(themeFile), screenshots }, null, 2),
);
console.log(`${screenshots.length} screenshots in ${output}`);
