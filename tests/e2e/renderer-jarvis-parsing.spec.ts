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
      const calls = { projects: [], previews: [], parses: [] };
      globalThis.jarvisCalls = calls;
      const deferred = (bucket, params, signal) => new Promise(resolve => {
        const call = { params, aborted: false, resolve };
        signal?.addEventListener("abort", () => {
          call.aborted = true;
          resolve({ available: false, errorCode: "cancelled", projects: [], complete: false, userId: null, conditions: [], bugs: [], total: 0, capped: false });
        }, { once: true });
        bucket.push(call);
      });
      installRendererJarvisMention(document, {
        isComposerEditor: element => element === editor,
        readHostId: () => "local",
        readLocale: () => "zh-CN",
        anchorForEditor: () => card,
        listProjects: (_hostId, params, signal) => deferred(calls.projects, params, signal),
        previewProjectBugTitle: (_hostId, params, signal) => deferred(calls.previews, params, signal),
        searchProjectBugs: (_hostId, params, signal) => deferred(calls.parses, params, signal),
      });
      const result = (bugs, conditions = []) => ({ available: true, errorCode: null, conditions, bugs, total: bugs.length, capped: false });
      const bugs = (titles) => titles.map((title, index) => ({ id: 9101 + index, projectId: 9001, title }));
      const last = bucket => bucket[bucket.length - 1];
      globalThis.finishProject = (index, projects) => calls.projects[index].resolve({ available: true, errorCode: null, projects: projects.map((name, i) => ({ id: 9001 + i, name })), complete: true, userId: 10058 });
      globalThis.finishPreview = (index, titles) => calls.previews[index].resolve(result(bugs(titles)));
      globalThis.finishLastPreview = (titles) => last(calls.previews).resolve(result(bugs(titles)));
      globalThis.finishParse = (index, titles, conditions) => calls.parses[index].resolve(result(bugs(titles), conditions));
      globalThis.finishLastParse = (titles, conditions) => last(calls.parses).resolve(result(bugs(titles), conditions));
      globalThis.failLastParse = () => last(calls.parses).resolve({ available: false, errorCode: "timeout", conditions: [], bugs: [], total: 0, capped: false });
      editor.focus();
      const range = document.createRange();
      range.setStart(editor.firstChild, 1);
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "jarvis-two-step-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
  loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "text" },
});

async function openPanel(page: Page): Promise<void> {
  await page.locator("[data-codexhost-jarvis-entry-row]").click();
  await expect(page.locator("[data-codexhost-jarvis-step]")).toBeVisible();
}

async function seedCache(page: Page, projects: string[], lastProjectName?: string): Promise<void> {
  await page.evaluate(
    ({ projects, lastProjectName }) => {
      const userId = 10058;
      localStorage.setItem(
        "codexhost.jarvis.projects.v1.local",
        JSON.stringify({
          userId,
          savedAt: Date.now(),
          projects: projects.map((name, index) => ({ id: 9001 + index, name })),
        }),
      );
      if (lastProjectName) {
        localStorage.setItem(
          `codexhost.jarvis.last-project.v1.local.${userId}`,
          JSON.stringify({
            savedAt: Date.now(),
            project: { id: 9001 + projects.indexOf(lastProjectName), name: lastProjectName },
          }),
        );
      }
    },
    { projects, lastProjectName },
  );
}

const calls = (page: Page, bucket: "projects" | "previews" | "parses") =>
  page.evaluate((name) => Reflect.get(globalThis, "jarvisCalls")[name], bucket);

test.beforeEach(async ({ page }) => {
  await page.setContent("<!doctype html><html><body></body></html>");
  // `about:blank` denies the real Storage; the controller only needs the API.
  await page.evaluate(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, String(value)),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
        key: () => null,
        length: 0,
      },
    });
  });
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
});

test("paints cached projects immediately and revalidates in the background", async ({ page }) => {
  await seedCache(page, ["示例后台 · 迭代 B", "示例商城 · 迭代 A"]);
  await openPanel(page);
  await expect(page.locator("[data-codexhost-jarvis-step='project']")).toBeVisible();
  await expect(page.locator("[data-codexhost-jarvis-project]")).toHaveCount(2);
  await expect(page.locator("[data-codexhost-jarvis-skeleton]")).toHaveCount(0);
  await expect.poll(() => calls(page, "projects").then((value) => value.length)).toBe(1);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "jarvisCalls").projects[0].params),
  ).toEqual({});
});

test("typing cancels the superseded project search and shows the new rows", async ({ page }) => {
  await openPanel(page);
  await expect.poll(() => calls(page, "projects").then((value) => value.length)).toBe(1);
  const input = page.locator("[data-codexhost-jarvis-step='project'] input");
  await input.pressSequentially("发货");
  await expect.poll(() => calls(page, "projects").then((value) => value.length)).toBe(2);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "jarvisCalls").projects[0].aborted),
  ).toBe(true);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "jarvisCalls").projects[1].params),
  ).toEqual({ query: "发货" });
  await page.evaluate(() => Reflect.get(globalThis, "finishProject")(1, ["发货系统优化"]));
  await expect(page.locator("[data-codexhost-jarvis-project]")).toHaveCount(1);
  await expect(page.locator("[data-codexhost-jarvis-step='project']")).toContainText(
    "发货系统优化",
  );
  await expect(page.locator("[data-jarvis-summary]")).toHaveText("");
});

test("choosing a project keeps only that project and previews titles", async ({ page }) => {
  await seedCache(page, ["示例后台 · 迭代 B"]);
  await openPanel(page);
  await page.locator("[data-codexhost-jarvis-project]").click();
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).toBeVisible();
  await expect(page.locator("[data-jarvis-project-chip]")).toContainText("示例后台 · 迭代 B");
  await expect.poll(() => calls(page, "previews").then((value) => value.length)).toBe(1);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "jarvisCalls").previews[0].params),
  ).toEqual({ projectId: 9001, title: "" });
  await page.evaluate(() => Reflect.get(globalThis, "finishPreview")(0, ["示例：发货失败"]));
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(1);
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).toContainText("示例：发货失败");
  expect((await calls(page, "projects")).length).toBe(1);
});

test("typing auto-runs the parse and a pending search never reads 无结果", async ({ page }) => {
  await page.clock.install();
  await seedCache(page, ["示例后台 · 迭代 B"]);
  await openPanel(page);
  await page.locator("[data-codexhost-jarvis-project]").click();
  await page.evaluate(() => Reflect.get(globalThis, "finishPreview")(0, ["标题命中"]));
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(1);

  const input = page.locator("[data-codexhost-jarvis-step='bug'] input");
  await input.pressSequentially("没处理的");
  await page.clock.runFor(320);
  expect((await calls(page, "previews")).length).toBe(2);

  // No Enter: 800 ms after the last keystroke the parse starts on its own and
  // aborts the still-pending title preview.
  await page.clock.runFor(520);
  expect((await calls(page, "parses")).length).toBe(1);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "jarvisCalls").previews[1].aborted),
  ).toBe(true);
  await expect(page.locator("[data-jarvis-summary]")).toHaveText("正在识别条件…");

  // A late empty title preview must not replace the pending parse with 无结果.
  await page.evaluate(() => Reflect.get(globalThis, "finishLastPreview")([]));
  await page.clock.runFor(20);
  await expect(page.locator("[data-jarvis-summary]")).toHaveText("正在识别条件…");
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).not.toContainText("无结果");
  await expect(page.locator("[data-jarvis-message]")).toHaveCount(0);

  await page.evaluate(() =>
    Reflect.get(globalThis, "finishLastParse")(
      ["条件命中"],
      [
        { key: "scope:assigned", kind: "scope", label: "指派给我" },
        { key: "status:1", kind: "status", label: "未解决" },
        { key: "order:newest", kind: "order", label: "最新" },
      ],
    ),
  );
  await expect(page.locator("[data-jarvis-chip]")).toHaveCount(3);
  await expect(page.locator("[data-jarvis-summary]")).toHaveText("共 1 条");
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(1);
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).toContainText("条件命中");
});

test("typing during a pending parse cancels the superseded request", async ({ page }) => {
  await page.clock.install();
  await seedCache(page, ["示例后台 · 迭代 B"]);
  await openPanel(page);
  await page.locator("[data-codexhost-jarvis-project]").click();
  await page.evaluate(() => Reflect.get(globalThis, "finishPreview")(0, ["标题命中"]));
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(1);

  const input = page.locator("[data-codexhost-jarvis-step='bug'] input");
  await input.pressSequentially("没处理");
  await page.clock.runFor(840);
  expect((await calls(page, "parses")).length).toBe(1);

  await input.pressSequentially("的");
  expect(await page.evaluate(() => Reflect.get(globalThis, "jarvisCalls").parses[0].aborted)).toBe(
    true,
  );
  await page.clock.runFor(840);
  expect((await calls(page, "parses")).length).toBe(2);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "jarvisCalls").parses[1].params),
  ).toMatchObject({ projectId: 9001, query: "没处理的" });
});

test("Enter runs the parse before the debounce and shows removable chips", async ({ page }) => {
  await page.clock.install();
  await seedCache(page, ["示例后台 · 迭代 B"]);
  await openPanel(page);
  await page.locator("[data-codexhost-jarvis-project]").click();
  await page.evaluate(() => Reflect.get(globalThis, "finishPreview")(0, ["标题命中"]));
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(1);

  const input = page.locator("[data-codexhost-jarvis-step='bug'] input");
  await input.pressSequentially("未解决的发货");
  await page.clock.runFor(320);
  await page.evaluate(() => Reflect.get(globalThis, "finishLastPreview")(["标题命中"]));
  await input.press("Enter");
  expect((await calls(page, "parses")).length).toBe(1);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "jarvisCalls").parses[0].params),
  ).toMatchObject({ projectId: 9001, query: "未解决的发货" });
  await page.evaluate(() =>
    Reflect.get(globalThis, "finishLastParse")(
      ["条件命中"],
      [
        { key: "status:1", kind: "status", label: "未解决" },
        { key: "title", kind: "title", label: "标题含「发货」" },
      ],
    ),
  );
  await expect(page.locator("[data-jarvis-chip]")).toHaveCount(2);
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).toContainText("条件命中");
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).not.toContainText("标题命中");

  // Removing a chip re-parses with that condition omitted.
  await page.locator("[data-jarvis-chip='status:1']").click();
  expect((await calls(page, "parses")).length).toBe(2);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "jarvisCalls").parses[1].params),
  ).toMatchObject({ projectId: 9001, omit: ["status:1"] });
});

test("a timed-out parse says so, offers 重试, and keeps the title rows", async ({ page }) => {
  await page.clock.install();
  await seedCache(page, ["示例后台 · 迭代 B"]);
  await openPanel(page);
  await page.locator("[data-codexhost-jarvis-project]").click();
  await page.evaluate(() => Reflect.get(globalThis, "finishPreview")(0, ["标题结果"]));
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(1);

  const input = page.locator("[data-codexhost-jarvis-step='bug'] input");
  await input.pressSequentially("没处理的发货");
  await page.clock.runFor(320);
  await page.evaluate(() => Reflect.get(globalThis, "finishLastPreview")(["标题结果"]));
  await page.clock.runFor(520);
  expect((await calls(page, "parses")).length).toBe(1);
  await page.evaluate(() => Reflect.get(globalThis, "failLastParse")());

  const notice = page.locator("[data-jarvis-notice]");
  await expect(notice).toContainText("识别条件超时");
  await expect(notice.locator("[data-jarvis-action]")).toHaveText("重试");
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(1);
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).toContainText("标题结果");
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).not.toContainText("无结果");
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).not.toContainText("条件未识别");

  await notice.locator("[data-jarvis-action]").click();
  expect((await calls(page, "parses")).length).toBe(2);
  await expect(notice).toHaveCount(0);
  await expect(page.locator("[data-jarvis-summary]")).toHaveText("正在识别条件…");
});

test("an unchanged query is not parsed again", async ({ page }) => {
  await page.clock.install();
  await seedCache(page, ["示例后台 · 迭代 B"]);
  await openPanel(page);
  await page.locator("[data-codexhost-jarvis-project]").click();
  await page.evaluate(() => Reflect.get(globalThis, "finishPreview")(0, ["标题命中"]));
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(1);

  const input = page.locator("[data-codexhost-jarvis-step='bug'] input");
  await input.pressSequentially("没处理的");
  await page.clock.runFor(840);
  expect((await calls(page, "parses")).length).toBe(1);
  await page.evaluate(() =>
    Reflect.get(globalThis, "finishLastParse")(
      ["条件命中"],
      [{ key: "status:1", kind: "status", label: "未解决" }],
    ),
  );
  await expect(page.locator("[data-jarvis-chip]")).toHaveCount(1);

  await input.press("Enter");
  await page.clock.runFor(2_000);
  expect((await calls(page, "parses")).length).toBe(1);
});

test("starts in the bug step from the remembered project", async ({ page }) => {
  await seedCache(page, ["示例后台 · 迭代 B"], "示例后台 · 迭代 B");
  await openPanel(page);
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).toBeVisible();
  await expect(page.locator("[data-jarvis-project-chip]")).toContainText("示例后台 · 迭代 B");
  await expect.poll(() => calls(page, "previews").then((value) => value.length)).toBe(1);
  await page.evaluate(() => Reflect.get(globalThis, "finishPreview")(0, ["示例：发货失败"]));
  await expect(page.locator("[data-codexhost-jarvis-bug]")).toHaveCount(1);
});

test("the back control and the project chip both return to the project step", async ({ page }) => {
  await seedCache(page, ["示例后台 · 迭代 B", "示例商城 · 迭代 A"]);
  await openPanel(page);
  await page.locator("[data-codexhost-jarvis-project]").nth(1).click();
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).toBeVisible();
  await page.locator("[data-codexhost-jarvis-step='bug'] button[aria-label='返回']").click();
  await expect(page.locator("[data-codexhost-jarvis-step='project']")).toBeVisible();
  await expect(page.locator("[data-codexhost-jarvis-project]")).toHaveCount(2);
  await page.locator("[data-codexhost-jarvis-project]").nth(0).click();
  await expect(page.locator("[data-codexhost-jarvis-step='bug']")).toBeVisible();
  await page.locator("[data-jarvis-project-chip]").click();
  await expect(page.locator("[data-codexhost-jarvis-step='project']")).toBeVisible();
});
