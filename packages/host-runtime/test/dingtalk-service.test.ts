import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DingTalkConversation, DingTalkMessage } from "@codexhost/shared-contracts";

import type { DingTalkCli } from "../src/dingtalk-cli.js";
import { DingTalkService } from "../src/dingtalk-service.js";

const RECENT_BASE = Date.now() - 60 * 60_000;

function conversation(id: string, offset: number, unreadCount = 1): DingTalkConversation {
  return {
    conversationId: id,
    title: `会话 ${id}`,
    singleChat: false,
    unreadCount,
    lastMessageAt: RECENT_BASE + offset,
    muted: false,
  };
}

interface FakeState {
  unread: DingTalkConversation[];
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
  memberCalls: number;
  members: { openDingTalkId: string; name: string; title?: string }[];
  info: Record<string, DingTalkConversation>;
  onRecord?: (record: {
    messageId: string;
    conversationId: string;
    senderName: string;
    text: string;
    createdAt: number;
  }) => void;
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
    searchMessages: async () => ({ messages: state.messages, errorCode: null }),
    members: async () => {
      state.memberCalls += 1;
      return { members: state.members, errorCode: null };
    },
    send: async () => ({ ok: true, errorCode: null }),
    sendDirect: async () => ({ ok: true, errorCode: null }),
    sendCard: async () => ({ ok: true, bizId: "card-test", errorCode: null }),
    updateCard: async () => ({ ok: true, errorCode: null }),
    pendingApprovals: async () => ({ approvals: [], errorCode: null }),
    openEvents: async (input) => {
      state.onRecord = (record) =>
        input.onRecord({ kind: "group", atMe: false, atAll: false, ...record });
      return { stop: () => undefined };
    },
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
    messages: [],
    groups: [],
    people: [],
    messageCalls: 0,
    previewCalls: 0,
    memberCalls: 0,
    members: [],
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

describe("DingTalk connection status", () => {
  it("reports the identity used by the workbench status line", async () => {
    const env = await environment();
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(state()),
    });
    const status = await service.status();
    expect(status).toMatchObject({
      installed: true,
      authenticated: true,
      userName: "我",
      corpName: "测试公司",
      errorCode: null,
    });
    service.dispose();
  });
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
    const result = await service.conversations();
    expect(result.source).toBe("unread");
    expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual(["a", "b"]);
    expect(result.conversations[0]).toMatchObject({
      groupType: "INTERNAL_GROUP",
      memberCount: 18,
    });
    expect(result.refreshing).toBe(false);
    service.dispose();
  });

  it("only lists unread conversations from the last 48 hours", async () => {
    const env = await environment();
    const fake = state({
      unread: [
        conversation("fresh", 200),
        conversation("stale", -49 * 60 * 60_000),
        conversation("read", 100, 0),
      ],
    });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
    });
    const result = await service.conversations();
    expect(result.source).toBe("unread");
    expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual(["fresh"]);
    service.dispose();
  });

  it("returns an empty state when nothing is unread in 48 hours", async () => {
    const env = await environment();
    const fake = state({ unread: [conversation("stale", -49 * 60 * 60_000)] });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
    });
    const result = await service.conversations();
    expect(result.source).toBe("empty");
    expect(result.conversations).toHaveLength(0);
    service.dispose();
  });

  it("loads auth, unread and @me concurrently", async () => {
    const env = await environment();
    const fake = state({ unread: [conversation("a", 100)] });
    const cli = fakeCli(fake);
    let authStarted = false;
    let unreadStarted = false;
    let atMeStarted = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrive = (): void => {
      if (authStarted && unreadStarted && atMeStarted) release?.();
    };
    cli.authStatus = async () => {
      authStarted = true;
      arrive();
      await gate;
      return {
        installed: true,
        authenticated: true,
        userId: "me",
        userName: "我",
        corpName: "测试公司",
        errorCode: null,
      };
    };
    cli.unreadConversations = async () => {
      unreadStarted = true;
      arrive();
      await gate;
      return { conversations: fake.unread, errorCode: null };
    };
    cli.atMeHits = async () => {
      atMeStarted = true;
      arrive();
      await gate;
      return { hits: [], errorCode: null };
    };
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    const result = await Promise.race([
      service.conversations(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("requests ran sequentially")), 2_000),
      ),
    ]);
    expect(authStarted).toBe(true);
    expect(unreadStarted).toBe(true);
    expect(atMeStarted).toBe(true);
    expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual(["a"]);
    service.dispose();
  });

  it("never blocks the first list on the group directory", async () => {
    const env = await environment();
    const fake = state({ unread: [conversation("a", 100)] });
    const cli = fakeCli(fake);
    cli.groupDirectory = async () => new Promise(() => undefined);
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    const result = await Promise.race([
      service.conversations(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("group directory blocked the list")), 2_000),
      ),
    ]);
    expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual(["a"]);
    service.dispose();
  });

  it("hides a viewed conversation until a newer message arrives", async () => {
    const env = await environment();
    const row = conversation("a", 100);
    const fake = state({ unread: [row] });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
    });
    await service.markViewed("a", row.lastMessageAt ?? 0, false);
    const hidden = await service.conversations();
    expect(hidden.source).toBe("empty");
    expect(hidden.conversations).toHaveLength(0);

    fake.unread = [conversation("a", 200)];
    void service.conversations();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const shown = await service.conversations();
    expect(shown.source).toBe("unread");
    expect(shown.conversations[0]?.conversationId).toBe("a");
    service.dispose();
  });

  it("keeps an open conversation with a cleared badge until the page leaves", async () => {
    const env = await environment();
    const row = conversation("a", 100, 4);
    const fake = state({ unread: [row] });
    const changes: { conversationId: string | null }[] = [];
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
      onChange: (event) => changes.push(event),
    });
    await service.conversations();
    await service.markViewed("a", row.lastMessageAt ?? 0, true);
    const whileOpen = await service.conversations();
    expect(whileOpen.conversations).toHaveLength(1);
    expect(whileOpen.conversations[0]).toMatchObject({ conversationId: "a", unreadCount: 0 });
    expect(whileOpen.conversations[0]?.atMe).not.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changes.some((event) => event.conversationId === "a")).toBe(true);

    await service.markViewed("a", row.lastMessageAt ?? 0, false);
    const afterLeave = await service.conversations();
    expect(afterLeave.source).toBe("empty");
    expect(afterLeave.conversations).toHaveLength(0);
    service.dispose();
  });

  it("keeps a new message visible without a badge while the conversation is open", async () => {
    const env = await environment();
    const row = conversation("a", 100, 1);
    const fake = state({ unread: [row] });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
      now: () => row.lastMessageAt ?? 0,
    });
    await service.conversations();
    await service.markViewed("a", row.lastMessageAt ?? 0, true);
    await vi.waitFor(() => expect(fake.onRecord).toBeDefined());
    fake.onRecord?.({
      messageId: "m2",
      conversationId: "a",
      senderName: "林晓",
      text: "新消息",
      createdAt: (row.lastMessageAt ?? 0) + 1_000,
    });
    const result = await service.conversations();
    expect(result.conversations[0]).toMatchObject({
      conversationId: "a",
      unreadCount: 0,
      preview: "新消息",
    });
    service.dispose();
  });

  it("reads members once for simultaneous picker requests", async () => {
    const env = await environment();
    const fake = state({
      members: [{ openDingTalkId: "open-1", name: "王鹏远", title: "普通成员" }],
    });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
    });
    const [first, second] = await Promise.all([
      service.members("cidA=="),
      service.members("cidA=="),
    ]);
    expect(first).toMatchObject({ available: true, members: fake.members });
    expect(second).toEqual(first);
    expect(fake.memberCalls).toBe(1);
    service.dispose();
  });

  it("reads the newest message preview on every request", async () => {
    const env = await environment();
    const received: DingTalkMessage = {
      messageId: "m1",
      conversationId: "a",
      senderName: "林晓",
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
    expect(first.preview).toBe("林晓：预算表我改完第二版了。");
    expect(second.preview).toBe(first.preview);
    expect(fake.messageCalls).toBe(2);
    service.dispose();
  });

  it("de-duplicates identical concurrent message reads", async () => {
    const env = await environment();
    const received: DingTalkMessage = {
      messageId: "m1",
      conversationId: "a",
      senderName: "林晓",
      createdAt: 100,
      text: "收到",
      unsupported: false,
      mine: false,
    };
    const fake = state({ messages: [received] });
    const cli = fakeCli(fake);
    cli.messages = async () => {
      fake.messageCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { messages: fake.messages, hasMore: false, nextCursor: null, errorCode: null };
    };
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    const [first, second] = await Promise.all([
      service.messages({ conversationId: "a", limit: 30 }),
      service.messages({ conversationId: "a", limit: 30 }),
    ]);
    expect(fake.messageCalls).toBe(1);
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
    service.dispose();
  });
});

describe("DingTalk keyword search", () => {
  it("merges local list matches with groups, people and messages", async () => {
    const env = await environment();
    const searches: unknown[] = [];
    const fake = state({
      unread: [{ ...conversation("local", 100), title: "示例本地群" }],
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
          name: "林晓",
          title: "产品经理",
          userId: "u1",
          openDingTalkId: "open-1",
        },
      ],
      messages: [
        {
          messageId: "m1",
          conversationId: "message-conv",
          senderName: "赵明",
          createdAt: 90,
          text: "示例的预算表在这里",
          unsupported: false,
          mine: false,
        },
      ],
      info: {
        "message-conv": {
          ...conversation("message-conv", 90),
          title: "示例消息群",
        },
      },
    });
    const cli = fakeCli(fake);
    cli.searchMessages = async (input) => {
      searches.push(input);
      return { messages: fake.messages, errorCode: null };
    };
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    const result = await service.search({ query: "示例" });
    expect(searches).toEqual([{ query: "示例", days: 30, limit: 30 }]);
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
  it("notifies every Desktop session that shares the service", async () => {
    const env = await environment();
    const row = conversation("a", 100);
    const fake = state({ unread: [row] });
    const first: { conversationId: string | null }[] = [];
    const second: { conversationId: string | null }[] = [];
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
    });
    service.addNotifier((event) => first.push(event));
    const unsubscribe = service.addNotifier((event) => second.push(event));
    await service.conversations();
    await vi.waitFor(() => expect(fake.onRecord).toBeDefined());
    fake.onRecord?.({
      messageId: "m2",
      conversationId: "a",
      senderName: "林晓",
      text: "新消息",
      createdAt: (row.lastMessageAt ?? 0) + 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(first.some((event) => event.conversationId === "a")).toBe(true);
    expect(second.some((event) => event.conversationId === "a")).toBe(true);
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 30));
    first.length = 0;
    second.length = 0;
    fake.onRecord?.({
      messageId: "m3",
      conversationId: "a",
      senderName: "林晓",
      text: "新消息 2",
      createdAt: (row.lastMessageAt ?? 0) + 2_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
    service.dispose();
  });

  it("does not push a conversation notification for a pull refresh", async () => {
    const env = await environment();
    const changes: { conversationId: string | null }[] = [];
    const fake = state({ unread: [conversation("a", 100)] });
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli: fakeCli(fake),
      onChange: (event) => changes.push(event),
    });
    await service.conversations();
    await service.conversations();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changes.filter((event) => event.conversationId !== null)).toHaveLength(0);
    service.dispose();
  });
});

it("normalizes a real @display-name mention for the background dispatcher and releases its subscriber", async () => {
  const env = await environment();
  const fake = state();
  const cli = fakeCli(fake);
  cli.authStatus = async () => ({
    installed: true,
    authenticated: true,
    userName: "许涛",
    userId: "self",
    corpName: null,
    errorCode: null,
  });
  const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
  const events: unknown[] = [];
  const unsubscribe = service.subscribeEvents((event) => events.push(event));
  try {
    await service.status();
    await service.startListening();
    await vi.waitFor(() => expect(fake.onRecord).toBeDefined());
    fake.onRecord?.({
      messageId: "m1",
      conversationId: "c1",
      senderName: "林晓",
      text: "@许涛(许涛) 安心买上线了吗",
      createdAt: Date.now(),
    });
    expect(events[0]).toMatchObject({ atMe: true });
    fake.onRecord?.({
      messageId: "m2",
      conversationId: "c1",
      senderName: "林晓",
      text: "@许涛涛 不是本人",
      createdAt: Date.now(),
    });
    expect(events[1]).toMatchObject({ atMe: false });
    unsubscribe();
    fake.onRecord?.({
      messageId: "m3",
      conversationId: "c1",
      senderName: "林晓",
      text: "@许涛 hello",
      createdAt: Date.now(),
    });
    expect(events).toHaveLength(2);
  } finally {
    service.dispose();
  }
});
