import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createDingTalkSettingsPage } from "./packages/renderer-extension/src/settings/dingtalk-page.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";

      const base = 1_760_000_000_000;
      const conversation = {
        conversationId: "cidA",
        title: "项目群",
        singleChat: false,
        unreadCount: 2,
        lastMessageAt: base + 5_000,
        muted: false,
        memberCount: 8,
      };
      const other = {
        conversationId: "cidB",
        title: "另一个群",
        singleChat: false,
        unreadCount: 1,
        lastMessageAt: base + 4_000,
        muted: false,
        memberCount: 4,
      };
      const message = (id, text, offset, mine = false) => ({
        messageId: id,
        conversationId: "cidA",
        senderName: mine ? "我" : "林晓",
        createdAt: base + offset,
        text,
        unsupported: false,
        mine,
      });
      const snapshot = [
        message("m1", "预算表我改完第二版了，你看一下。", 1_000),
        message("m2", "收到，我晚点看", 2_000, true),
        message("m3", "上线时间还没定", 3_000),
        message("m4", "我同步给测试了", 4_000, true),
        message("m5", "好的", 5_000),
      ];

      const calls = { conversations: 0, messages: 0, members: 0, prefetch: 0 };
      let subscriber = null;
      let transcript = [...snapshot].reverse();
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const client = {
        available: () => true,
        beginSession() {},
        endSession() {},
        status: async () => ({
          installed: true,
          authenticated: true,
          userName: "我",
          userId: "me",
          corpName: "测试公司",
          defaultHost: "local",
          defaultHostId: null,
          errorCode: null,
        }),
        conversations: async () => {
          calls.conversations += 1;
          return {
            available: true,
            source: "unread",
            conversations: [{ ...conversation }, { ...other }],
            cachedAt: Date.now(),
            refreshing: false,
            errorCode: null,
          };
        },
        details: async (rows) => rows,
        preview: async () => ({ available: true, preview: null, cachedAt: null, errorCode: null }),
        messages: async (params) => {
          calls.messages += 1;
          if (params.before !== undefined) {
            return {
              available: true,
              conversation: null,
              messages: [],
              hasMore: false,
              nextCursor: null,
              cachedAt: Date.now(),
              refreshing: false,
              errorCode: null,
            };
          }
          if (calls.messages === 1) await wait(30);
          return {
            available: true,
            conversation: null,
            messages: transcript.map((row) => ({ ...row })),
            hasMore: false,
            nextCursor: null,
            cachedAt: Date.now(),
            refreshing: calls.messages === 1,
            errorCode: null,
          };
        },
        prefetch: async (ids) => {
          calls.prefetch += 1;
          return { started: ids.length };
        },
        members: async () => {
          calls.members += 1;
          return { available: true, members: [{ openDingTalkId: "open-1", name: "王鹏远" }], errorCode: null };
        },
        resource: async () => ({ available: false, dataUrl: null, mimeType: null, sizeBytes: null, errorCode: "unsupported_media" }),
        send: async () => ({ ok: true, messageId: null, sentAt: Date.now(), errorCode: null }),
        search: async () => ({ available: true, conversations: [], messages: [], errorCode: null }),
        resolve: async () => ({ available: true, conversation: null, messages: [], errorCode: null }),
        markViewed: async () => undefined,
        subscribe(listener) {
          subscriber = listener;
          return () => { subscriber = null; };
        },
      };

      globalThis.openDingTalk = () => {
        const messages = rendererSettingsMessages("zh-CN");
        const page = createDingTalkSettingsPage(messages, {
          createClient: () => client,
          readLocale: () => "zh-CN",
          embed: async () => true,
        });
        const content = document.getElementById("content");
        const controller = new AbortController();
        page.mount({
          content,
          signal: controller.signal,
          runLatest: async (operation) => { await operation(controller.signal); },
        });
        return calls;
      };

      globalThis.pushChanged = () => {
        if (subscriber) subscriber(null);
      };

      globalThis.appendMessage = () => {
        transcript = [message("m6", "新消息到了", 6_000), ...transcript];
      };
      globalThis.callCounts = () => calls;
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
  .dingtalk-workbench { display: flex; height: 800px; }
  .dingtalk-sidebar { width: 320px; border-right: 1px solid #ddd; overflow: hidden; }
  .dingtalk-main { flex: 1; display: flex; flex-direction: column; }
  .dingtalk-message-pane { flex: 1; overflow: hidden; position: relative; }
  .dingtalk-message-list { height: 120px; overflow-y: auto; }
  .dingtalk-composer-area { padding: 8px; }
  .dingtalk-search-panel { display: none; }
  .dingtalk-main-notice { display: none; }
  .dingtalk-message { padding: 6px 8px; min-height: 80px; }
  .dingtalk-main-state { display: none; }
</style></head><body><div id="content"></div></body></html>`;

async function setup(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route("http://localhost/dingtalk-live", (route) =>
    route.fulfill({ contentType: "text/html", body: shell }),
  );
  await page.goto("http://localhost/dingtalk-live");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const seen: boolean[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (
            node.matches(".dingtalk-message-skeleton") ||
            node.querySelector(".dingtalk-message-skeleton")
          ) {
            seen.push(true);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    Reflect.set(globalThis, "skeletonSeen", seen);
  });
  await page.evaluate(() => Reflect.get(globalThis, "openDingTalk")());
}

test("paints the memory snapshot without a skeleton and keeps draft and scroll on reconcile", async ({
  page,
}) => {
  await setup(page);

  const rows = page.locator("[data-message-id]");
  await expect(rows).toHaveCount(5);
  expect(await page.evaluate(() => Reflect.get(globalThis, "skeletonSeen").length)).toBe(0);
  expect(await page.evaluate(() => Reflect.get(globalThis, "callCounts")())).toMatchObject({
    members: 1,
    prefetch: 1,
  });

  const input = page.locator(".dingtalk-composer-input");
  await input.fill("先别发，我再改改");
  const list = page.locator(".dingtalk-message-list");
  // The first paint scrolls to the bottom on the next frame; settle it before
  // moving the user away from the newest message.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);

  await page.evaluate(() => {
    Reflect.get(globalThis, "appendMessage")();
    Reflect.get(globalThis, "pushChanged")();
  });

  await expect(rows).toHaveCount(6);
  await expect(input).toHaveValue("先别发，我再改改");
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.locator(".dingtalk-new-messages")).toBeVisible();
});

test("hover starts a fresh read at 150 ms and leaving cancels it", async ({ page }) => {
  await setup(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const row = page.locator('[data-conversation-id="cidB"]');
  const count = () => page.evaluate(() => Reflect.get(globalThis, "callCounts")().prefetch);
  const initial = await count();
  await row.hover();
  await page.clock.fastForward(149);
  expect(await count()).toBe(initial);
  await page.clock.fastForward(1);
  await expect.poll(count).toBe(initial + 1);
  await page.mouse.move(1190, 790);
  await row.hover();
  await page.clock.fastForward(100);
  await page.mouse.move(1190, 790);
  await page.clock.fastForward(100);
  expect(await count()).toBe(initial + 1);
});
