import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createDingTalkSettingsPage } from "./packages/renderer-extension/src/settings/dingtalk-page.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";

      const base = 1_760_000_000_000;
      const group = {
        conversationId: "cidA",
        title: "项目群",
        singleChat: false,
        unreadCount: 1,
        lastMessageAt: base + 5_000,
        muted: false,
        memberCount: 8,
      };
      const direct = {
        conversationId: "cidB",
        title: "林晓",
        singleChat: true,
        unreadCount: 1,
        lastMessageAt: base + 4_000,
        muted: false,
      };
      const message = (id, text, offset, mine = false, conversationId = "cidA") => ({
        messageId: id,
        conversationId,
        senderName: mine ? "我" : "林晓",
        senderId: "open-lin",
        createdAt: base + offset,
        text,
        unsupported: false,
        mine,
      });
      let transcript = [
        message("m1", "预算表我改完第二版了，你看一下。", 1_000),
        message("m2", "收到，我晚点看", 2_000, true),
        message("m3", "上线时间还没定", 3_000),
      ];
      let failScore = false;
      let failRun = false;
      let scores = [0.82, 0.21, 0.64];
      let lastScoreCalls = 0;
      let runs = [];
      const dispatched = new Map();
      let disposePage = null;

      const client = {
        available: () => true,
        beginSession() {},
        endSession() {},
        status: async () => ({
          installed: true, authenticated: true, userName: "我", userId: "me",
          corpName: "测试公司", defaultHost: "local", defaultHostId: null, errorCode: null,
        }),
        conversations: async () => ({
          available: true, source: "unread",
          conversations: [{ ...group }, { ...direct }],
          cachedAt: Date.now(), refreshing: false, errorCode: null,
        }),
        details: async (rows) => rows,
        preview: async () => ({ available: true, preview: null, cachedAt: null, errorCode: null }),
        messages: async (params) => ({
          available: true, conversation: params.conversationId === "cidB" ? { ...direct } : { ...group },
          messages: transcript.filter((row) => row.conversationId === params.conversationId).map((row) => ({ ...row })),
          hasMore: false, nextCursor: null, cachedAt: Date.now(), refreshing: false, errorCode: null,
        }),
        prefetch: async () => ({ started: 1 }),
        members: async () => ({ available: true, members: [], errorCode: null }),
        resource: async () => ({ available: false, dataUrl: null, mimeType: null, sizeBytes: null, errorCode: "unsupported_media" }),
        send: async () => ({ ok: true, messageId: null, sentAt: Date.now(), errorCode: null }),
        search: async () => ({ available: true, conversations: [], messages: [], errorCode: null }),
        resolve: async () => ({ available: true, conversation: null, messages: [], errorCode: null }),
        markViewed: async () => undefined,
        timing: async () => undefined,
        subscribe: () => () => undefined,
      };

      const dispatch = {
        available: () => true,
        score: async (conversationId, messageId) => {
          lastScoreCalls += 1;
          return {
            failed: failScore,
            agents: [
              {
                agent: { fileName: "reviewer.toml", name: "评审助手", description: "代码评审与上线检查", ready: true },
                score: failScore ? null : scores[0],
              },
              {
                agent: { fileName: "writer.toml", name: "写作助手", description: "整理说明和文档", ready: true },
                score: failScore ? null : scores[1],
              },
              {
                agent: { fileName: "bare.toml", name: "未配置助手", description: "还没选择分区", ready: false },
                score: failScore ? null : scores[2],
              },
            ],
          };
        },
        run: async (conversationId, messageId, agents) => {
          if (failRun) throw new Error("fixture failure");
          runs.push({ conversationId, messageId, agents });
          transcript = transcript.map((message) => message.messageId === messageId ? {
            ...message, dispatchedAgents: agents.map((fileName, index) => ({
              fileName, name: fileName === "reviewer.toml" ? "评审助手" : fileName, threadId: "thread-" + index,
            })),
          } : message);
          return {
            results: agents.map((fileName, index) => ({
              fileName,
              name: fileName === "reviewer.toml" ? "评审助手" : fileName,
              threadId: "thread-" + index,
              error: null,
            })),
          };
        },
      };

      globalThis.openDingTalk = () => {
        disposePage?.();
        const messages = rendererSettingsMessages("zh-CN");
        const page = createDingTalkSettingsPage(messages, {
          createClient: () => client,
          createDispatchClient: () => dispatch,
          readLocale: () => "zh-CN",
          embed: async () => true,
          openThread: (threadId) => { dispatched.set(threadId, true); },
        });
        const content = document.getElementById("content");
        const controller = new AbortController();
        disposePage = page.mount({
          content,
          signal: controller.signal,
          runLatest: async (operation) => { await operation(controller.signal); },
        });
      };
      globalThis.setFailScore = (value) => { failScore = value; };
      globalThis.setScores = (value) => { scores = value; };
      globalThis.setFailRun = (value) => { failRun = value; };
      globalThis.scoreCalls = () => lastScoreCalls;
      globalThis.runCalls = () => runs;
      globalThis.openedThread = (id) => dispatched.has(id);
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  logLevel: "silent",
});

const bundle = outputFiles[0]?.text ?? "";

const shell = `<!doctype html><html><head><style>
  body { margin: 0; font: 14px system-ui; }
  #content { height: 800px; }
  .dingtalk-workbench { display: flex; height: 800px; position: relative; }
  .dingtalk-sidebar { width: 320px; border-right: 1px solid #ddd; overflow: hidden; }
  .dingtalk-main { flex: 1; display: flex; flex-direction: column; position: relative; }
  .dingtalk-message-pane { flex: 1; overflow: hidden; position: relative; }
  .dingtalk-message-list { height: 420px; overflow-y: auto; }
  .dingtalk-message { padding: 6px 8px; }
  .dingtalk-agent-panel { position: absolute; inset: 0; display: flex; }
  .dingtalk-agent-panel[hidden] { display: none; }
  .dingtalk-agent-panel-sheet { width: 420px; margin-left: auto; background: #fafafa; padding: 16px; }
  .dingtalk-agent-row { display: flex; gap: 8px; align-items: center; padding: 8px; }
  .dingtalk-agent-row[data-disabled="true"] { opacity: 0.55; }
  .dingtalk-agent-panel-footer { display: flex; gap: 8px; justify-content: flex-end; padding-top: 8px; }
  .dingtalk-agent-panel-confirm { padding: 8px; border: 1px dashed #c90; }
  .dingtalk-agent-panel-confirm[hidden] { display: none; }
  .dingtalk-message-menu { position: fixed; z-index: 60; background: #fff; border: 1px solid #ccc; }
  .dingtalk-message-menu-item { display: block; width: 100%; }
  .dingtalk-message-actions { display: flex; gap: 2px; }
</style></head><body><div id="content"></div></body></html>`;

async function setup(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route("http://localhost/dingtalk-dispatch", (route) =>
    route.fulfill({ contentType: "text/html", body: shell }),
  );
  await page.goto("http://localhost/dingtalk-dispatch");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(globalThis, "openDingTalk")());
  await expect(page.locator("[data-message-id]")).toHaveCount(3);
}

test("hover toolbar opens the agent panel with one scored list and dispatches one message", async ({
  page,
}) => {
  await setup(page);
  const row = page.locator('[data-message-id="m3"]');
  await row.hover();
  await row.getByRole("button", { name: "交给智能体" }).click();

  const panel = page.locator(".dingtalk-agent-panel-sheet");
  await expect(panel).toBeVisible();
  const rows = panel.locator(".dingtalk-agent-row");
  await expect(rows).toHaveCount(3);
  // High score first; the unready agent is not picked by default.
  await expect(rows.nth(0)).toContainText("评审助手");
  await expect(rows.nth(0)).toContainText("82%");
  await expect(rows.nth(0).locator("input")).toBeChecked();
  await expect(rows.nth(1)).toContainText("未配置助手");
  await expect(rows.nth(1)).toContainText("需要设置分区和工作项目");
  await expect(rows.nth(1).locator("input")).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(globalThis, "scoreCalls")())).toBe(1);

  await panel.getByRole("button", { name: "派发（1）" }).click();
  await expect(page.locator(".dingtalk-message-dispatched")).toContainText("已派发：");
  await expect(page.locator(".dingtalk-message-dispatched-agent")).toHaveText("评审助手");

  await page.locator(".dingtalk-message-dispatched-agent").click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "openedThread")("thread-0"))).toBe(true);
});

test("re-dispatching the same agent asks for confirmation", async ({ page }) => {
  await setup(page);
  const row = page.locator('[data-message-id="m3"]');
  await row.hover();
  await row.getByRole("button", { name: "交给智能体" }).click();
  await page.getByRole("button", { name: "派发（1）" }).click();
  await expect(page.locator(".dingtalk-message-dispatched-agent")).toHaveText("评审助手");

  await row.hover();
  await row.getByRole("button", { name: "交给智能体" }).click();
  await page.getByRole("button", { name: "派发（1）" }).click();
  await expect(page.locator(".dingtalk-agent-panel-confirm")).toContainText("已派发过，仍要派发？");
  const before = await page.evaluate(() => Reflect.get(globalThis, "runCalls")().length);
  await page.getByRole("button", { name: "仍要派发" }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "runCalls")().length))
    .toBe(before + 1);
});

test("a failed score still lists agents by name and never blocks dispatch", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "setFailScore")(true));
  const row = page.locator('[data-message-id="m3"]');
  await row.hover();
  await row.getByRole("button", { name: "交给智能体" }).click();
  const panel = page.locator(".dingtalk-agent-panel-sheet");
  await expect(panel).toContainText("判断失败，可直接选择");
  const rows = panel.locator(".dingtalk-agent-row");
  // Name order under zh-CN collation; no score column and nothing preselected.
  await expect(rows.nth(0)).toContainText("评审助手");
  await expect(rows.nth(0)).toContainText("—");
  await expect(rows.nth(0).locator("input")).not.toBeChecked();
  await rows.nth(0).locator("input").check();
  await panel.getByRole("button", { name: "派发（1）" }).click();
  await expect(page.locator(".dingtalk-message-dispatched-agent")).toHaveText("评审助手");
});

test("right-click menu contains exactly agent, copy and reply; reply prefills the composer", async ({
  page,
}) => {
  await setup(page);
  const row = page.locator('[data-message-id="m3"]');
  await row.click({ button: "right" });
  const menu = page.locator(".dingtalk-message-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".dingtalk-message-menu-item")).toHaveText([
    "交给智能体",
    "复制",
    "回复",
  ]);
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "回复" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".dingtalk-composer-input")).toHaveValue("@林晓 ");
});

for (const score of [0.29, 0.3]) {
  test(`default selection at score ${score}`, async ({ page }) => {
    await setup(page);
    await page.evaluate((value) => Reflect.get(globalThis, "setScores")([value, 0.1, 0.2]), score);
    const row = page.locator('[data-message-id="m3"]');
    await row.hover();
    await row.getByRole("button", { name: "交给智能体" }).click();
    const check = page.locator('.dingtalk-agent-row[data-agent-file="reviewer.toml"] input');
    if (score < 0.3) await expect(check).not.toBeChecked();
    else await expect(check).toBeChecked();
  });
}

test("sorts before choosing the default even if the score response is unsorted", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "setScores")([0.82, 0.92, 0.64]));
  await page.locator('[data-message-id="m3"]').getByRole("button", { name: "交给智能体" }).click();
  const top = page.locator(".dingtalk-agent-row").first();
  await expect(top).toContainText("写作助手");
  await expect(top.locator("input")).toBeChecked();
});

test("dispatches two checked agents only for the selected message", async ({ page }) => {
  await setup(page);
  await page.locator('[data-message-id="m3"]').getByRole("button", { name: "交给智能体" }).click();
  await page.locator('.dingtalk-agent-row[data-agent-file="writer.toml"] input').check();
  await page.getByRole("button", { name: "派发（2）" }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "runCalls")()))
    .toEqual([
      { conversationId: "cidA", messageId: "m3", agents: ["reviewer.toml", "writer.toml"] },
    ]);
  await expect(
    page.locator('[data-message-id="m3"] .dingtalk-message-dispatched-agent'),
  ).toHaveCount(2);
  await expect(
    page.locator('[data-message-id="m1"] .dingtalk-message-dispatched-agent'),
  ).toHaveCount(0);
});

test("keeps checkboxes usable after a dispatch transport failure", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "setFailRun")(true));
  await page.locator('[data-message-id="m3"]').getByRole("button", { name: "交给智能体" }).click();
  await page.getByRole("button", { name: "派发（1）" }).click();
  const check = page.locator('.dingtalk-agent-row[data-agent-file="writer.toml"] input');
  await expect(check).toBeEnabled();
  await check.check();
  await expect(page.getByRole("button", { name: "派发（2）" })).toBeEnabled();
});

test("keeps dispatch marks and the duplicate confirmation after reopening the page", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-message-id="m3"]').getByRole("button", { name: "交给智能体" }).click();
  await page.getByRole("button", { name: "派发（1）" }).click();
  await expect(page.locator(".dingtalk-message-dispatched-agent")).toHaveCount(1);
  await page.evaluate(() => Reflect.get(globalThis, "openDingTalk")());
  await expect(page.locator(".dingtalk-message-dispatched-agent")).toHaveText("评审助手");
  await page.locator('[data-message-id="m3"]').getByRole("button", { name: "交给智能体" }).click();
  await page.getByRole("button", { name: "派发（1）" }).click();
  await expect(page.locator(".dingtalk-agent-panel-confirm")).toContainText("已派发过，仍要派发？");
  expect(await page.evaluate(() => Reflect.get(globalThis, "runCalls")().length)).toBe(1);
});
