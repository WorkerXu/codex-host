import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererJarvisMention } from "./packages/renderer-extension/src/renderer-jarvis-mention.ts";
      import { nativeAtMenu } from "./tools/ui-preview/src/native-at-menu.ts";
      const card = document.createElement("div");
      card.style.cssText = "position:absolute;left:80px;bottom:80px;width:680px";
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      editor.textContent = "@";
      editor.style.cssText = "height:60px;padding:12px";
      const menu = nativeAtMenu();
      menu.style.cssText = "position:absolute;bottom:100%;width:100%;height:220px";
      card.append(editor, menu);
      document.body.append(card);
      globalThis.jarvisRequests = [];
      installRendererJarvisMention(document, {
        isComposerEditor: element => element === editor,
        readHostId: () => "local",
        readLocale: () => "zh-CN",
        anchorForEditor: () => card,
        search: (_hostId, params, signal) => new Promise(resolve => {
          const request = {query:params.query,aborted:signal.aborted,resolve};
          signal.addEventListener("abort", () => { request.aborted = true; }, {once:true});
          globalThis.jarvisRequests.push(request);
        }),
      });
      globalThis.finishJarvisRequest = (index, title) => globalThis.jarvisRequests[index].resolve({
        available:true,errorCode:null,conditions:[],bugs:[{id:index+1,projectId:9001,title}],total:1,capped:false,
      });
      editor.focus();
      const range = document.createRange();
      range.setStart(editor.firstChild, 1);
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "jarvis-parsing-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
  loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "text" },
});

async function setup(page: Page) {
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
  await page.locator("[data-codexhost-jarvis-entry-row]").click();
  const input = page.getByRole("textbox");
  await expect(input).toBeFocused();
  return input;
}

test("typing cancels immediately and late results cannot replace the new query, even during debounce", async ({
  page,
}) => {
  const input = await setup(page);
  await input.pressSequentially("我还没处理的，标题有发货的");
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "jarvisRequests").length))
    .toBe(2);
  await expect(page.getByRole("status")).toHaveText("正在解析…");
  await input.press("ControlOrMeta+a");
  await input.pressSequentially("退款");
  expect(await page.evaluate(() => Reflect.get(globalThis, "jarvisRequests")[1].aborted)).toBe(
    true,
  );
  await page.evaluate(() => Reflect.get(globalThis, "finishJarvisRequest")(1, "过期的发货结果"));
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "jarvisRequests").length))
    .toBe(3);
  await page.evaluate(() => Reflect.get(globalThis, "finishJarvisRequest")(2, "新的退款结果"));
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(1);
  await expect(page.locator("[data-codexhost-jarvis-mode]")).toContainText("新的退款结果");
  await expect(page.locator("[data-codexhost-jarvis-mode]")).not.toContainText("过期的发货结果");
  await expect(input).toHaveValue("退款");
  await expect(input).toBeFocused();
});

test("leaving Jarvis mode cancels the active parser request", async ({ page }) => {
  const input = await setup(page);
  await expect(page.getByRole("status")).toHaveText("正在解析…");
  await input.press("Escape");
  await expect(page.locator("[data-codexhost-jarvis-mode]")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(globalThis, "jarvisRequests")[0].aborted)).toBe(
    true,
  );
});
