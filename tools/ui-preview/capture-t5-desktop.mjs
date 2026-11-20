import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";

import { desktopTheme } from "./desktop-theme.mjs";

const [themeFile, outputPath] = process.argv.slice(2);
if (!themeFile || !outputPath)
  throw new Error(
    "Usage: node tools/ui-preview/capture-t5-desktop.mjs <Desktop CSS> <output directory>",
  );

const output = path.resolve(outputPath);
const desktopCss = await readFile(themeFile, "utf8");
if (!desktopTheme(desktopCss).colorSchemes)
  throw new Error("Desktop CSS must include light and dark theme variables");
const { outputFiles } = await build({
  entryPoints: [path.join(import.meta.dirname, "src/t5-desktop.ts")],
  bundle: true,
  write: false,
  platform: "browser",
  target: "es2024",
  format: "iife",
  loader: { ".html": "text", ".css": "text", ".svg": "dataurl", ".png": "dataurl" },
});
const script = outputFiles[0].text.replaceAll(/<\/script/giu, "<\\/script");

const shellCss = `
body { margin: 0; color: var(--color-text); background: var(--color-surface); }
.preview-composer {
  position: fixed; left: max(8px, calc(50% - 252px)); bottom: 36px;
  width: min(504px, calc(100vw - 16px)); padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 20px; background: var(--color-surface-elevated-secondary);
}
.preview-composer [contenteditable] { min-height: 32px; outline: none; }
.preview-toolbar { display: flex; justify-content: flex-end; height: 30px; }
[data-feature=sections] aside { background: var(--color-background-sidebar, var(--color-surface)); }
`;

const features = ["sections", "mirror", "dispatch"];
const states = ["light", "dark", "hover", "focus"];
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const feature of features) {
    for (const state of states) {
      const appearance = state === "dark" ? "dark" : "light";
      const viewport = {
        width: feature === "sections" ? 348 : 564,
        height: feature === "sections" ? 420 : 460,
      };
      const context = await browser.newContext({ colorScheme: appearance, viewport });
      await context.route(/^https?:/u, (route) => route.abort());
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(`<!doctype html><html lang="zh-CN" data-theme="${appearance}" data-codex-window-type="electron" data-appearance-preset="codex">
<style>${desktopCss}</style><style>html { color-scheme: ${appearance}; } ${shellCss}</style>
<body data-feature="${feature}"><main></main><script>${script}</script></body></html>`);
        let target;
        let panel;
        if (feature === "sections") {
          panel = page.locator('[data-codexhost-merged-state="merged"]');
          await expect(panel).toBeVisible();
          target = panel.getByRole("button", { name: "显示项目分组", exact: true });
          await panel.locator('[class~="group/nav-section-title"]').hover();
        } else if (feature === "mirror") {
          const trigger = page.locator("[data-codexhost-agent-control] > button");
          await trigger.click();
          panel = page.getByRole("menu", { name: "Agent", exact: true });
          await panel.getByRole("menuitem", { name: "oracle-sg", exact: true }).click();
          await page.mouse.move(4, 4);
          target = panel.getByRole("menuitem", { name: "oracle-sg · Claude Code" });
        } else {
          await page.getByRole("textbox", { name: "消息" }).press("#");
          panel = page.getByRole("listbox");
          target = panel.getByRole("option", { name: "Claude Code", exact: true });
          await expect(panel.getByText("连接超时", { exact: true })).toBeVisible();
          await expect(panel.getByText("连接失败", { exact: true })).toBeVisible();
        }
        if (state === "hover") await target.hover();
        if (state === "focus") {
          if (feature === "dispatch") {
            await page.keyboard.press("ArrowDown");
            await expect(target).toHaveAttribute("aria-selected", "true");
          } else {
            if (feature === "mirror") await page.keyboard.press("End");
            else {
              await page.keyboard.press("Tab");
              await target.focus();
            }
            await expect(target).toBeFocused();
            expect(await target.evaluate((element) => element.matches(":focus-visible"))).toBe(
              true,
            );
          }
        }
        if (feature !== "sections") {
          const bounds = await panel.boundingBox();
          expect(bounds?.x).toBeGreaterThanOrEqual(0);
          expect(bounds?.y).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        }
        expect(errors).toEqual([]);
        await page.screenshot({
          path: path.join(output, `${feature}-${state}.png`),
          animations: "disabled",
        });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`12 screenshots in ${output}`);
