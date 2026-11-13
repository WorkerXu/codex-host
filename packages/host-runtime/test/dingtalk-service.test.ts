import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DingTalkConversation, DingTalkMessage } from "@codexhost/shared-contracts";

import type { DingTalkCli } from "../src/dingtalk-cli.js";
import { DingTalkService } from "../src/dingtalk-service.js";

function conversation(id: string, lastMessageAt: number, unreadCount = 1): DingTalkConversation {
  return {
    conversationId: id,
    title: `会话 ${id}`,
    singleChat: false,
    unreadCount,
    lastMessageAt,
    muted: false,
  };
}

function message(id: string, conversationId: string, createdAt: number): DingTalkMessage {
  return {
    messageId: id,
    conversationId,
    senderName: "我",
    createdAt,
    text: "收到",
    unsupported: false,
    mine: true,
  };
}

interface FakeState {
  unread: DingTalkConversation[];
  sent: DingTalkMessage[];
  messages: DingTalkMessage[];
  messageCalls: number;
  info: Record<string, DingTalkConversation>;
}

function fakeCli(state: FakeState): DingTalkCli {
  return {
    executable: async () => "/fake/dws",
    authStatus: async () => ({
      installed: true,
      authenticated: true,
      userId: "me",
      userName: "我",
      corpName: "测试公司",
      errorCode: null,
    }),
    unreadConversations: async () => ({ conversations: state.unread, errorCode: null }),
    conversationInfo: async (id) => state.info[id] ?? null,
    messages: async () => {
      state.messageCalls += 1;
      return {
        messages: state.messages,
        hasMore: false,
        nextCursor: null,
        errorCode: null,
      };
    },
    searchMessages: async (input) => ({
      messages: input.senderIds?.includes("me") ? state.sent : [],
      errorCode: null,
    }),
    send: async () => ({ ok: true, errorCode: null }),
    openEvents: async () => null,
  };
}

const directories: string[] = [];

async function environment(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dingtalk-"));
  directories.push(directory);
  return { ...process.env, CODEXHOST_USER_DIR: directory, HOME: directory };
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })),
  );
});

describe("DingTalk conversation list rule", () => {
  it("shows unread conversations", async () => {
    const env = await environment();
    const state: FakeState = {
      unread: [conversation("a", 200, 2), conversation("b", 100, 1)],
      sent: [],
      messages: [],
      messageCalls: 0,
      info: {},
    };
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(state),
    });
    const result = await service.conversations();
    expect(result.source).toBe("unread");
    expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual(["a", "b"]);
    expect(result.refreshing).toBe(false);
    service.dispose();
  });

  it("falls back to the 10 conversations I most recently replied in", async () => {
    const env = await environment();
    const sent = Array.from({ length: 14 }, (_unused, index) =>
      message(`m${index}`, `c${index % 12}`, 1_000 - index),
    );
    const state: FakeState = {
      unread: [],
      sent,
      messages: [],
      messageCalls: 0,
      info: {},
    };
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(state),
    });
    const result = await service.conversations();
    expect(result.source).toBe("recent-replied");
    expect(result.conversations).toHaveLength(10);
    expect(new Set(result.conversations.map(({ conversationId }) => conversationId)).size).toBe(10);
    expect(result.conversations[0]?.conversationId).toBe("c0");
    service.dispose();
  });

  it("hides a viewed conversation until a newer message arrives", async () => {
    const env = await environment();
    const state: FakeState = {
      unread: [conversation("a", 100)],
      sent: [],
      messages: [],
      messageCalls: 0,
      info: {},
    };
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(state),
    });
    await service.markViewed("a", 100);
    const hidden = await service.conversations();
    expect(hidden.source).toBe("empty");
    expect(hidden.conversations).toHaveLength(0);

    state.unread = [conversation("a", 200)];
    void service.conversations(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const shown = await service.conversations();
    expect(shown.source).toBe("unread");
    expect(shown.conversations[0]?.conversationId).toBe("a");
    service.dispose();
  });

  it("reuses the cached message page for the latest window", async () => {
    const env = await environment();
    const state: FakeState = {
      unread: [],
      sent: [],
      messages: [message("m1", "a", 100)],
      messageCalls: 0,
      info: {},
    };
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(state),
    });
    const first = await service.messages({ conversationId: "a", limit: 40 });
    const second = await service.messages({ conversationId: "a", limit: 40 });
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
    expect(state.messageCalls).toBe(1);
    service.dispose();
  });

  it("does not block a conversation request on the slow recent-conversations shortcut", async () => {
    const env = await environment();
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      timedOut: false,
      truncated: false,
      value: {},
      errorCode: null,
      errorMessage: null,
    }));
    const state: FakeState = {
      unread: [conversation("a", 100)],
      sent: [],
      messages: [],
      messageCalls: 0,
      info: {},
    };
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(state),
      transport: {
        local: true,
        hostName: "local",
        configure: () => undefined,
        refresh: async () => ({
          name: "local",
          hostId: null,
          local: true,
          peer: null,
          configured: null,
          hosts: [],
        }),
        run,
        runRaw: run,
      },
    });
    await service.conversations();
    expect(run).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe("DingTalk search routing", () => {
  it("uses the decided message filters", async () => {
    const env = await environment();
    const searches: unknown[] = [];
    const state: FakeState = {
      unread: [conversation("a", 100)],
      sent: [],
      messages: [],
      messageCalls: 0,
      info: { a: { ...conversation("a", 100), title: "财务" } },
    };
    const cli = fakeCli(state);
    cli.searchMessages = async (input) => {
      searches.push(input);
      return { messages: [message("m1", "a", 100)], errorCode: null };
    };
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    const result = await service.search({
      query: "我发的支付",
      route: "messages",
      messageQuery: "支付",
      fromMe: true,
      days: 7,
    });
    expect(searches).toEqual([
      { query: "支付", senderIds: ["me"], atMe: false, days: 7, limit: 30 },
    ]);
    expect(result.route).toBe("messages");
    expect(result.messages).toHaveLength(1);
    service.dispose();
  });

  it("returns the conversations selected by the local decision", async () => {
    const env = await environment();
    const state: FakeState = {
      unread: [],
      sent: [],
      messages: [],
      messageCalls: 0,
      info: {
        a: { ...conversation("a", 100), title: "财务" },
        b: { ...conversation("b", 90), title: "监控" },
      },
    };
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(state),
      decisions: {
        decide: async () => ({
          available: true,
          route: "conversations",
          messageQuery: "",
          fromMe: false,
          atMe: false,
          days: 30,
          conversationIds: ["b", "a"],
          errorCode: null,
          keywords: "",
        }),
        score: async () => [],
        clear: () => undefined,
      },
    });
    const decision = await service.decide({
      query: "监控群",
      conversations: [
        {
          conversationId: "b",
          title: "监控",
          singleChat: false,
          lastMessageAt: 90,
        },
      ],
    });
    expect(decision.route).toBe("conversations");
    const result = await service.search({
      query: "监控群",
      route: "conversations",
      conversationIds: decision.conversationIds,
    });
    expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual(["b", "a"]);
    service.dispose();
  });
});

describe("DingTalk change notifications", () => {
  it("does not push a notification for a pull refresh", async () => {
    const env = await environment();
    const changes: unknown[] = [];
    const state: FakeState = {
      unread: [conversation("a", 100)],
      sent: [],
      messages: [],
      messageCalls: 0,
      info: {},
    };
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(state),
      onChange: (event) => changes.push(event),
    });
    await service.conversations();
    await service.conversations(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changes).toHaveLength(0);
    service.dispose();
  });
});
