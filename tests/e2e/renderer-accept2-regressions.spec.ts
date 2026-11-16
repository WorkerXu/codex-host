import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { openAgentMenu } from "./packages/renderer-extension/src/settings/agent-card-menu.ts";
      import {
        mountRendererAgentPicker,
        renderRendererAgentPicker,
      } from "./packages/renderer-extension/src/renderer-agent-picker.ts";

      globalThis.setupShadowMenu = () => {
        const host = document.createElement("div");
        document.body.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        const container = document.createElement("div");
        container.style.cssText = "position:relative;width:480px;height:360px";
        const anchor = document.createElement("button");
        anchor.type = "button";
        anchor.textContent = "⋯";
        anchor.style.cssText = "position:absolute;left:60px;top:60px;width:36px;height:32px";
        container.append(anchor);
        shadow.append(container);
        anchor.addEventListener("click", () => {
          openAgentMenu({
            document,
            view: window,
            container,
            anchor,
            label: "writer",
            items: [
              { label: "编辑", run: () => { globalThis.menuAction = "edit"; } },
              { label: "复制", run: () => { globalThis.menuAction = "copy"; } },
              { label: "删除", danger: true, run: () => { globalThis.menuAction = "delete"; } },
            ],
          });
        });
      };

      globalThis.setupFocusPicker = () => {
        const shell = document.createElement("div");
        shell.style.cssText = "position:fixed;inset:0;display:flex;align-items:flex-end;margin:0";
        const composer = document.createElement("div");
        composer.setAttribute("data-codex-composer-root", "true");
        composer.style.cssText = "display:flex;flex-direction:column;width:100%;box-sizing:border-box";
        const editor = document.createElement("div");
        editor.contentEditable = "true";
        editor.textContent = "hello";
        editor.style.cssText = "min-height:80px;padding:12px;outline:none";
        const toolbar = document.createElement("div");
        toolbar.style.cssText = "display:flex;justify-content:flex-end;padding:8px";
        composer.append(editor, toolbar);
        shell.append(composer);
        document.body.append(shell);

        const picker = mountRendererAgentPicker(
          "focus-composer",
          ["codex", "claude-code", "grok"],
          (agent) => { globalThis.selectedAgent = agent; },
          () => {},
        );
        toolbar.append(picker.root);
        renderRendererAgentPicker(
          picker,
          { agent: "codex", phase: "draft" },
          "ready",
          false,
          { "claude-code": "ready", grok: "ready" },
        );
        globalThis.focusPicker = picker;
        globalThis.composerEditor = editor;
        editor.focus();
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-accept2-regressions-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "text" },
  platform: "browser",
  target: "es2024",
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Accept2 regression bundle was not generated");

async function load(page: Page): Promise<void> {
  await page.setContent("<!doctype html><body style='margin:0'></body>");
  await page.addScriptTag({ content: browserBundle });
}

async function realClick(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Cannot find a box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

test("agent card menu items survive pointerdown retargeted through the settings shadow root", async ({
  page,
}) => {
  await load(page);
  await page.evaluate(() => Reflect.get(globalThis, "setupShadowMenu")());

  const host = page.locator("body > div").first();
  const anchorBox = await page.evaluate(() => {
    const host = document.querySelector("body > div");
    const anchor = host?.shadowRoot?.querySelector("button");
    const rect = anchor?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  });
  if (!anchorBox) throw new Error("Shadow anchor is missing");
  await page.mouse.move(anchorBox.x + anchorBox.width / 2, anchorBox.y + anchorBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const item = await page.evaluate(() => {
    const host = document.querySelector("body > div");
    const el = host?.shadowRoot?.querySelector<HTMLElement>(".agent-menu-item");
    const rect = el?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  });
  if (!item) throw new Error("Shadow menu did not open");
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  expect(await page.evaluate(() => Reflect.get(globalThis, "menuAction") ?? null)).toBe("edit");
  expect(
    await page.evaluate(
      () => document.querySelector("body > div")?.shadowRoot?.querySelector(".agent-menu") === null,
    ),
  ).toBe(true);
  await expect(host).toBeAttached();
});

test("Agent picker rows keep the Composer alive for the full pointer sequence", async ({
  page,
}) => {
  await load(page);
  await page.evaluate(() => Reflect.get(globalThis, "setupFocusPicker")());
  await realClick(
    page,
    '[data-codexhost-agent-control="focus-composer"] > button[aria-haspopup="menu"]',
  );
  const menu = page.locator("#focus-composer-agent-menu");
  await expect(menu).toBeVisible();

  // Simulate Desktop's Composer chrome: any pointerdown that reaches the
  // document while the menu is open tears the Composer toolbar down before
  // `click`. The row must stop the press at the target.
  await page.evaluate(() => {
    const picker = Reflect.get(globalThis, "focusPicker") as {
      root: HTMLElement;
      menu: HTMLElement;
    };
    const editor = Reflect.get(globalThis, "composerEditor") as HTMLElement;
    editor.focus();
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.defaultPrevented) return;
        if (!event.composedPath().includes(picker.menu)) return;
        Reflect.set(globalThis, "toolbarTornDown", true);
        picker.root.remove();
      },
      { capture: false },
    );
  });

  await realClick(page, '#focus-composer-agent-menu button[data-agent="claude-code"]');

  expect(await page.evaluate(() => Reflect.get(globalThis, "selectedAgent") ?? null)).toBe(
    "claude-code",
  );
  expect(await page.evaluate(() => Reflect.get(globalThis, "toolbarTornDown") ?? false)).toBe(
    false,
  );
});
