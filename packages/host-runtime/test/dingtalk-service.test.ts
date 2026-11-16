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
  groups: DingTalkConversation[];
  people: {
    name: string;
    title: string;
    userId: string;
    openDingTalkId: string;
  }[];
  messageCalls: number;
  previewCalls: number;
  info: Record<string, DingTalkConversation>;
  recentDelay?: Promise<void>;
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
    searchGroups: async () => ({ conversations: state.groups, errorCode: null }),
    searchPeople: async () => ({ people: state.people, errorCode: null }),
    groupDirectory: async () => ({ directory: new Map(), errorCode: null }),
    atMeHits: async () => ({ hits: [], errorCode: null }),
    conversationInfo: async (id) => state.info[id] ?? null,
    conversationInfoForUser: async (openDingTalkId) => {
      const person = state.people.find((row) => row.openDingTalkId === openDingTalkId);
      return person
        ? {
            conversationId: `dm-${person.userId}`,
            title: person.name,
            singleChat: true,
            unreadCount: 0,
            lastMessageAt: null,
            muted: false,
            memberCount: 2,
          }
        : null;
    },
    messages: async () => {
      state.messageCalls += 1;
      return {
        messages: state.messages,
        hasMore: false,
        nextCursor: null,
        errorCode: null,
      };
    },
    searchMessages: async (input) => {
      if (input.senderIds?.includes("me")) {
        if (state.recentDelay) await state.recentDelay;
        return { messages: state.sent, errorCode: null };
      }
      return { messages: state.messages, errorCode: null };
    },
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

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    unread: [],
    sent: [],
    messages: [],
    groups: [],
    people: [],
    messageCalls: 0,
    previewCalls: 0,
    info: {},
    ...overrides,
  };
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })),
  );
});

describe("DingTalk conversation views", () => {
  it("shows unread conversations and merges group metadata", async () => {
    const env = await environment();
    const fake = state({
      unread: [conversation("a", 200, 2), conversation("b", 100, 1)],
      groups: [],
    });
    const cli = fakeCli(fake);
    cli.groupDirectory = async () => ({
      directory: new Map([
        ["a", { title: "会话 a", groupType: "INTERNAL_GROUP", memberCount: 18 }],
      ]),
      errorCode: null,
    });
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    const result = await service.conversations({ view: "unread" });
    expect(result.source).toBe("unread");
    expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual(["a", "b"]);
    expect(result.conversations[0]).toMatchObject({
      groupType: "INTERNAL_GROUP",
      memberCount: 18,
    });
    expect(result.refreshing).toBe(false);
    service.dispose();
  });

  it("lists the 10 most recent conversations I sent messages in", async () => {
    const env = await environment();
    const sent = Array.from({ length: 14 }, (_unused, index) =>
      message(`m${index}`, `c${index % 12}`, 1_000 - index),
    );
    const fake = state({ sent });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
    });
    fake.info = Object.fromEntries(
      Array.from({ length: 12 }, (_unused, index) => [
        `c${index}`,
        { ...conversation(`c${index}`, 1_000 - index), title: `会话 c${index}` },
      ]),
    );
    const result = await service.conversations({ view: "recent" });
    expect(result.source).toBe("recent");
    expect(result.conversations).toHaveLength(10);
    expect(new Set(result.conversations.map(({ conversationId }) => conversationId)).size).toBe(10);
    expect(result.conversations[0]?.conversationId).toBe("c0");
    expect(result.conversations[0]?.preview).toMatch(/^我：/u);
    service.dispose();
  });

  it("keeps the unread and recent caches separate", async () => {
    const env = await environment();
    const fake = state({
      unread: [conversation("a", 100)],
      sent: [message("m1", "b", 90)],
      info: { b: { ...conversation("b", 90), title: "会话 b" } },
    });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
    });
    const unread = await service.conversations({ view: "unread" });
    const recent = await service.conversations({ view: "recent" });
    expect(unread.conversations.map(({ conversationId }) => conversationId)).toEqual(["a"]);
    expect(recent.conversations.map(({ conversationId }) => conversationId)).toEqual(["b"]);
    service.dispose();
  });

  it("serves the cached recent view while a slow refresh runs", async () => {
    const env = await environment();
    const fake = state({
      sent: [message("m1", "c1", 100)],
      info: { c1: { ...conversation("c1", 100), title: "会话 c1" } },
    });
    let now = 1_000_000;
    let release;
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
      now: () => now,
    });
    await service.conversations({ view: "recent" });
    fake.recentDelay = new Promise((resolve) => {
      release = resolve;
    });
    now += 5 * 60_000;
    const started = Date.now();
    const result = await service.conversations({ view: "recent" });
    expect(Date.now() - started).toBeLessThan(100);
    expect(result.conversations).toHaveLength(1);
    release?.();
    service.dispose();
  });

  it("hides a viewed conversation until a newer message arrives", async () => {
    const env = await environment();
    const fake = state({ unread: [conversation("a", 100)] });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
    });
    await service.markViewed("a", 100);
    const hidden = await service.conversations({ view: "unread" });
    expect(hidden.source).toBe("empty");
    expect(hidden.conversations).toHaveLength(0);

    fake.unread = [conversation("a", 200)];
    void service.conversations({ view: "unread", refresh: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const shown = await service.conversations({ view: "unread" });
    expect(shown.source).toBe("unread");
    expect(shown.conversations[0]?.conversationId).toBe("a");
    service.dispose();
  });

  it("caches the newest message preview per conversation", async () => {
    const env = await environment();
    const received: DingTalkMessage = {
      messageId: "m1",
      conversationId: "a",
      senderName: "吴菁",
      createdAt: 100,
      text: "预算表我改完第二版了。",
      unsupported: false,
      mine: false,
    };
    const fake = state({ messages: [received] });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
    });
    const first = await service.preview("a");
    const second = await service.preview("a");
    expect(first.preview).toBe("吴菁：预算表我改完第二版了。");
    expect(second.preview).toBe(first.preview);
    expect(fake.messageCalls).toBe(1);
    service.dispose();
  });
});

describe("DingTalk keyword search", () => {
  it("merges local list matches with groups, people and messages", async () => {
    const env = await environment();
    const searches: unknown[] = [];
    const fake = state({
      unread: [{ ...conversation("local", 100), title: "示例货本地群" }],
      groups: [
        {
          conversationId: "remote-group",
          title: "【示例Sprint】 进度",
          singleChat: false,
          unreadCount: 0,
          lastMessageAt: 90,
          muted: false,
          groupType: "INTERNAL_GROUP",
          memberCount: 15,
        },
      ],
      people: [
        {
          name: "吴菁",
          title: "产品经理",
          userId: "u1",
          openDingTalkId: "open-1",
        },
      ],
      messages: [
        {
          messageId: "m1",
          conversationId: "message-conv",
          senderName: "李端",
          createdAt: 90,
          text: "示例货的预算表在这里",
          unsupported: false,
          mine: false,
        },
      ],
      info: {
        "message-conv": {
          ...conversation("message-conv", 90),
          title: "示例货消息群",
        },
      },
    });
    const cli = fakeCli(fake);
    cli.searchMessages = async (input) => {
      searches.push(input);
      return { messages: fake.messages, errorCode: null };
    };
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    const result = await service.search({ query: "示例货" });
    expect(searches).toEqual([{ query: "示例货", days: 30, limit: 30 }]);
    expect(result.available).toBe(true);
    expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual([
      "local",
      "remote-group",
      "dm-u1",
      "message-conv",
    ]);
    expect(result.conversations[1]).toMatchObject({
      groupType: "INTERNAL_GROUP",
      memberCount: 15,
    });
    expect(result.conversations[2]?.subtitle).toBe("产品经理");
    expect(result.messages).toHaveLength(1);
    service.dispose();
  });
});

describe("DingTalk change notifications", () => {
  it("does not push a notification for a pull refresh", async () => {
    const env = await environment();
    const changes: unknown[] = [];
    const fake = state({ unread: [conversation("a", 100)] });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
      onChange: (event) => changes.push(event),
    });
    await service.conversations({ view: "unread" });
    await service.conversations({ view: "unread", refresh: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changes).toHaveLength(0);
    service.dispose();
  });
});
