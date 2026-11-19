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
      const message = (id, text, offset) => ({
        messageId: id,
        conversationId: "cidA",
        senderName: "林晓",
        createdAt: base + offset,
        text,
        unsupported: false,
        mine: false,
      });
      const snapshot = [
        message("m1", "预算表我改完第二版了", 1_000),
        message("m2", "收到，我晚点看", 2_000),
        message("m3", "上线时间还没定", 3_000),
        message("m4", "我同步给测试了", 4_000),
        message("m5", "好的", 5_000),
      ];
      const older = [
        message("old1", "昨天的结论在这里", -1_000),
        message("old2", "再往前一条", -2_000),
      ];

      const calls = { conversations: 0, messages: 0, before: 0, preview: 0, members: 0, prefetch: 0 };
      let subscriber = null;
      let transcript = [...snapshot].reverse();

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
            // The live unread list carries no last-message preview.
            conversations: [{ ...conversation }, { ...other }],
            cachedAt: Date.now(),
            refreshing: false,
            errorCode: null,
          };
        },
        details: async (rows) => rows,
        preview: async () => {
          calls.preview += 1;
          return { available: true, preview: "林晓：最新一条", cachedAt: null, errorCode: null };
        },
        messages: async (params) => {
          calls.messages += 1;
          if (params.before !== undefined) {
            calls.before += 1;
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
          return {
            available: true,
            conversation: null,
            messages: transcript.map((row) => ({ ...row })),
            hasMore: true,
            nextCursor: base + 500,
            cachedAt: Date.now(),
            refreshing: false,
            errorCode: null,
          };
        },
        prefetch: async (ids) => {
          calls.prefetch += 1;
          return { started: ids.length };
        },
        members: async () => {
          calls.members += 1;
          return { available: true, members: [], errorCode: null };
        },
        resource: async () => ({ available: false, dataUrl: null, mimeType: null, sizeBytes: null, errorCode: "unsupported_media" }),
        send: async () => ({ ok: true, messageId: null, sentAt: Date.now(), errorCode: null }),
        search: async () => ({ available: true, conversations: [], messages: [] }),
        resolve: async () => ({ available: false, conversation: null, messages: [], errorCode: null }),
        markViewed: async () => undefined,
        timing: async () => undefined,
        subscribe: (listener) => {
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
      globalThis.appendOlder = () => {
        transcript = [...transcript, ...older];
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
  .dingtalk-message { padding: 6px 8px; min-height: 80px; }
  .dingtalk-main-state { display: none; }
</style></head><body><div id="content"></div></body></html>`;

async function setup(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route("http://localhost/dingtalk-transcript", (route) =>
    route.fulfill({ contentType: "text/html", body: shell }),
  );
  await page.goto("http://localhost/dingtalk-transcript");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(globalThis, "openDingTalk")());
}

async function messageIds(page: Page): Promise<string[]> {
  return await page
    .locator(".dingtalk-message-list [data-message-id]")
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.messageId ?? ""));
}

test("inserts a catch-up page by time so older history never follows the newest message", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator("[data-message-id]")).toHaveCount(5);
  expect(await messageIds(page)).toEqual(["m1", "m2", "m3", "m4", "m5"]);

  await page.evaluate(() => {
    Reflect.get(globalThis, "appendOlder")();
    Reflect.get(globalThis, "pushChanged")();
  });

  await expect(page.locator("[data-message-id]")).toHaveCount(7);
  expect(await messageIds(page)).toEqual(["old2", "old1", "m1", "m2", "m3", "m4", "m5"]);
  const geometry = await page.locator(".dingtalk-message-list").evaluate((element) => ({
    top: element.scrollTop,
    bottom: element.scrollHeight - element.scrollTop - element.clientHeight,
  }));
  expect(geometry.bottom).toBeLessThanOrEqual(1);
});

test("waits for a user scroll before reading older history", async ({ page }) => {
  await setup(page);
  await expect(page.locator("[data-message-id]")).toHaveCount(5);
  const count = () => page.evaluate(() => Reflect.get(globalThis, "callCounts")().before);
  expect(await count()).toBe(0);

  // A rebuild or a lazy image moves scrollTop; that is not the user.
  await page.locator(".dingtalk-message-list").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  expect(await count()).toBe(0);

  await page.locator(".dingtalk-message-list").evaluate((element) => {
    element.scrollTop = 80;
  });
  const list = page.locator(".dingtalk-message-list");
  await list.hover();
  await page.mouse.wheel(0, -800);
  await expect.poll(count).toBeGreaterThan(0);
});

test("keeps a preview when the live list read omits it", async ({ page }) => {
  await setup(page);
  const preview = page.locator('[data-conversation-id="cidB"] .dingtalk-conversation-preview');
  await expect(preview).toHaveText("林晓：最新一条");
  const previewCalls = await page.evaluate(() => Reflect.get(globalThis, "callCounts")().preview);

  await page.evaluate(() => {
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const element = document.querySelector(
        '[data-conversation-id="cidB"] .dingtalk-conversation-preview',
      );
      if (element) seen.push(element.textContent ?? "");
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    Reflect.set(globalThis, "previewSamples", seen);
  });

  for (let index = 0; index < 3; index += 1) {
    await page.evaluate(() => Reflect.get(globalThis, "pushChanged")());
    await page.waitForTimeout(150);
  }

  await expect(preview).toHaveText("林晓：最新一条");
  expect(
    await page.evaluate(() =>
      (Reflect.get(globalThis, "previewSamples") as string[]).every((text) => text.length > 0),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => Reflect.get(globalThis, "callCounts")().preview)).toBe(
    previewCalls,
  );
});
