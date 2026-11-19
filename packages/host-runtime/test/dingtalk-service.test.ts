import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DingTalkConversation, DingTalkMessage } from "@codexhost/shared-contracts";

import type { DingTalkCli, DwsEventRecord } from "../src/dingtalk-cli.js";
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
  members: { openDingTalkId: string; name: string }[];
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
    vi.useFakeTimers();
    try {
      const result = await service.conversations();
      expect(result.source).toBe("unread");
      expect(result.conversations.map(({ conversationId }) => conversationId)).toEqual(["a", "b"]);
      expect(result.conversations[0]?.groupType).toBeUndefined();
      expect((await service.details(result.conversations)).conversations[0]).toMatchObject({
        groupType: "INTERNAL_GROUP",
        memberCount: 18,
      });
      expect(result.refreshing).toBe(false);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
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

  it("returns the unread list while authentication and @me are still pending", async () => {
    const env = await environment();
    const fake = state({ unread: [conversation("a", 100)] });
    const cli = fakeCli(fake);
    cli.authStatus = async () => new Promise(() => {});
    cli.atMeHits = async () => new Promise(() => {});
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    void service.status();
    const result = await service.conversations();
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

  it("returns messages before optional direct-chat metadata or directory enrichment", async () => {
    const env = await environment();
    const direct = { ...conversation("direct", 100), title: "潘建开", singleChat: true };
    const fake = state({
      unread: [direct],
      messages: [
        {
          messageId: "m1",
          conversationId: "direct",
          senderName: "潘建开",
          createdAt: RECENT_BASE,
          text: "hi",
          unsupported: false,
          mine: false,
        },
      ],
    });
    const cli = fakeCli(fake);
    const info = vi
      .spyOn(cli, "conversationInfo")
      .mockImplementation(async () => new Promise(() => {}));
    const people = vi
      .spyOn(cli, "searchPeople")
      .mockImplementation(async () => new Promise(() => {}));
    cli.atMeHits = async () => new Promise(() => {});
    cli.groupDirectory = async () => new Promise(() => {});
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    await service.conversations();
    const result = await service.messages({
      conversationId: "direct",
      limit: 30,
      includeConversation: false,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.conversation).toBeNull();
    expect(info).not.toHaveBeenCalled();
    expect(people).not.toHaveBeenCalled();
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
    });
    service.dispose();
  });

  it("reads members once for simultaneous picker requests", async () => {
    const env = await environment();
    const fake = state({
      members: [{ openDingTalkId: "open-1", name: "王鹏远" }],
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
  it("keeps a contact before twenty matching groups and resolves the contact by open ID", async () => {
    const env = await environment();
    const fake = state({
      groups: Array.from({ length: 20 }, (_, i) => ({
        ...conversation(`group-${i}`, i),
        title: "罗浩项目群",
      })),
      people: [
        { name: "罗浩", title: "高级前端开发工程师", userId: "luo", openDingTalkId: "open-luo" },
      ],
    });
    const cli = fakeCli(fake);
    const resolve = vi.spyOn(cli, "conversationInfoForUser");
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    const result = await service.search({ query: "罗浩" });
    expect(result.conversations).toHaveLength(20);
    expect(result.conversations[0]).toMatchObject({
      conversationId: "dm-luo",
      singleChat: true,
      title: "罗浩",
    });
    expect(resolve).toHaveBeenCalledWith("open-luo");
    expect(
      (await service.messages({ conversationId: "dm-luo", includeConversation: false })).errorCode,
    ).toBeNull();
    service.dispose();
  });
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
      "dm-u1",
      "local",
      "remote-group",
      "message-conv",
    ]);
    expect(result.conversations[2]).toMatchObject({
      groupType: "INTERNAL_GROUP",
      memberCount: 15,
    });
    expect(result.conversations[0]).not.toHaveProperty("subtitle");
    expect(result.messages).toHaveLength(1);
    service.dispose();
  });
});

describe("DingTalk change notifications", () => {
  it("shares one stream between workbench and dispatch and applies a replay only once", async () => {
    const env = await environment();
    const row = conversation("a", 100);
    const fake = state({ unread: [row] });
    const cli = fakeCli(fake);
    const open = vi.spyOn(cli, "openEvents");
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    const dispatch = vi.fn();
    service.subscribeEvents(dispatch);
    service.setListeningHold(true);
    await Promise.all([
      service.startListening(),
      service.conversations(),
      service.startListening(),
    ]);
    await vi.waitFor(() => expect(fake.onRecord).toBeDefined());
    expect(open).toHaveBeenCalledTimes(1);
    const event = {
      messageId: "repeat",
      conversationId: "a",
      senderName: "甲",
      text: "new",
      createdAt: RECENT_BASE + 1000,
    };
    for (let i = 0; i < 5; i += 1) fake.onRecord?.(event);
    expect(dispatch).toHaveBeenCalledTimes(1);
    cli.unreadConversations = async () => ({ conversations: [], errorCode: "offline" });
    // The live state is what the workbench already shows; a failed reconcile
    // must not blank the list.
    const stale = await service.conversations();
    expect(stale.refreshing).toBe(true);
    expect(stale.conversations.map(({ conversationId }) => conversationId)).toEqual(["a"]);
    service.dispose();
  });
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

it.each([
  [-100, false],
  [100, true],
  [200, true],
])("only tags @me within current DingTalk unread messages (%i)", async (offset, expected) => {
  const env = await environment();
  const fake = state({
    unread: [conversation("a", 200, 2)],
    messages: [100, 200].map((offset) => ({
      messageId: `m${offset}`,
      conversationId: "a",
      senderName: "对方",
      createdAt: RECENT_BASE + offset,
      text: "消息",
      unsupported: false,
      mine: false,
    })),
  });
  const cli = fakeCli(fake);
  cli.atMeHits = async () => ({
    hits: [{ conversationId: "a", messageId: "at", createdAt: RECENT_BASE + offset }],
    errorCode: null,
  });
  const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
  vi.useFakeTimers();
  try {
    const first = await service.conversations();
    expect((await service.details(first.conversations)).conversations[0]?.atMe).toBe(expected);
    await service.markViewed("a", RECENT_BASE + 200);
    expect((await service.details(fake.unread)).conversations[0]?.atMe).toBe(false);
  } finally {
    service.dispose();
    vi.useRealTimers();
  }
});

it("reconciles rows in the background and keeps them when a read fails", async () => {
  const env = await environment();
  const fake = state({ unread: [conversation("a", 100)] });
  const cli = fakeCli(fake);
  let members = 2;
  const directory = vi.spyOn(cli, "groupDirectory").mockImplementation(async () => ({
    directory: new Map([["a", { title: "A", memberCount: members, groupType: "INTERNAL_GROUP" }]]),
    errorCode: null,
  }));
  const unread = vi.spyOn(cli, "unreadConversations");
  const changes: { conversationId: string | null }[] = [];
  const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
  service.addNotifier((event) => changes.push(event));
  try {
    const first = await service.conversations();
    expect((await service.details(first.conversations)).conversations[0]?.memberCount).toBe(2);
    members = 7;
    fake.unread[0] = { ...conversation("a", 100), title: "新标题" };
    const second = await service.conversations();
    expect(second.refreshing).toBe(true);
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));
    const third = await service.conversations();
    expect(third.conversations[0]?.title).toBe("新标题");
    expect((await service.details(third.conversations)).conversations[0]?.memberCount).toBe(7);
    expect(directory).toHaveBeenCalledTimes(2);
    expect(unread.mock.calls.length).toBeGreaterThanOrEqual(2);
    unread.mockResolvedValue({ conversations: [], errorCode: "offline" });
    const offline = await service.conversations();
    expect(offline.refreshing).toBe(true);
    expect(offline.conversations.map(({ conversationId }) => conversationId)).toEqual(["a"]);
  } finally {
    service.dispose();
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function messageRow(
  messageId: string,
  conversationId: string,
  createdAt: number,
  text = "预算表我改完第二版了，你看一下。",
): DingTalkMessage {
  return {
    messageId,
    conversationId,
    senderName: "林晓",
    createdAt,
    text,
    unsupported: false,
    mine: false,
  };
}

describe("DingTalk live in-memory state", () => {
  it("answers the second list from memory while one live dws read runs", async () => {
    const env = await environment();
    const fake = state({ unread: [conversation("a", 200), conversation("b", 100)] });
    const cli = fakeCli(fake);
    const unread = cli.unreadConversations.bind(cli);
    let calls = 0;
    // Real dws `+unread-chats` is about 0.8–1.3 s; keep the shape, shorten the wait.
    cli.unreadConversations = async (count) => {
      calls += 1;
      await sleep(700);
      return await unread(count);
    };
    const changes: { conversationId: string | null }[] = [];
    const service = new DingTalkService({
      environment: env,
      isLocalHost: true,
      cli,
    });
    service.addNotifier((event) => changes.push(event));
    try {
      const coldStart = Date.now();
      const cold = await service.conversations();
      const coldMs = Date.now() - coldStart;
      expect(coldMs).toBeGreaterThanOrEqual(650);
      expect(cold.refreshing).toBe(false);
      expect(cold.cachedAt).not.toBeNull();

      fake.unread = [conversation("b", 400), conversation("a", 300)];
      const warmStart = Date.now();
      const warm = await service.conversations();
      const warmMs = Date.now() - warmStart;
      expect(warmMs).toBeLessThan(120);
      expect(warm).toMatchObject({ available: true, refreshing: true, source: "unread" });
      expect(warm.conversations.map(({ conversationId }) => conversationId)).toEqual(["a", "b"]);

      await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0), { timeout: 4_000 });
      const fresh = await service.conversations();
      expect(fresh.conversations.map(({ conversationId }) => conversationId)).toEqual(["b", "a"]);
      expect(calls).toBe(3);
    } finally {
      service.dispose();
    }
  });

  it("returns the stored transcript at once and folds the live read back in", async () => {
    const env = await environment();
    const first = messageRow("m1", "a", RECENT_BASE);
    const fake = state({ unread: [conversation("a", 200)], messages: [first] });
    const cli = fakeCli(fake);
    const read = cli.messages.bind(cli);
    let calls = 0;
    cli.messages = async (input) => {
      calls += 1;
      await sleep(600);
      return await read(input);
    };
    const changes: { conversationId: string | null }[] = [];
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    service.addNotifier((event) => changes.push(event));
    try {
      const cold = await service.messages({
        conversationId: "a",
        limit: 30,
        includeConversation: false,
      });
      expect(cold.refreshing).toBe(false);
      expect(cold.messages.map(({ messageId }) => messageId)).toEqual(["m1"]);

      fake.messages = [messageRow("m2", "a", RECENT_BASE + 60_000), first];
      const callsBefore = calls;
      const warmStart = Date.now();
      const warm = await service.messages({
        conversationId: "a",
        limit: 30,
        includeConversation: false,
      });
      const warmMs = Date.now() - warmStart;
      expect(warmMs).toBeLessThan(120);
      expect(warm.refreshing).toBe(true);
      expect(warm.messages.map(({ messageId }) => messageId)).toEqual(["m1"]);
      expect(calls).toBe(callsBefore + 1);

      await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0), { timeout: 4_000 });
      const reconciled = await service.messages({
        conversationId: "a",
        limit: 30,
        includeConversation: false,
      });
      expect(reconciled.messages.map(({ messageId }) => messageId)).toEqual(["m2", "m1"]);
    } finally {
      service.dispose();
    }
  });

  it("applies a flattened Stream event before the next read and notifies the page", async () => {
    const env = await environment();
    const first = messageRow("m1", "g1", RECENT_BASE);
    const fake = state({ unread: [conversation("g1", 200)], messages: [first] });
    const cli = fakeCli(fake);
    let deliver: ((record: DwsEventRecord) => void) | null = null;
    cli.openEvents = async (input) => {
      deliver = input.onRecord;
      return { stop: () => undefined };
    };
    const changes: { conversationId: string | null }[] = [];
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    service.addNotifier((event) => changes.push(event));
    try {
      await service.conversations();
      await service.messages({ conversationId: "g1", limit: 30, includeConversation: false });
      await service.startListening();
      await vi.waitFor(() => expect(deliver).not.toBeNull(), { timeout: 2_000 });
      const callsBefore = fake.messageCalls;
      deliver?.({
        messageId: "e1",
        conversationId: "g1",
        senderName: "林晓",
        text: "上线时间改到周五，请确认",
        createdAt: RECENT_BASE + 120_000,
        kind: "group",
        atMe: true,
        atAll: false,
        conversationTitle: "项目群",
      });
      await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0), { timeout: 2_000 });

      const list = await service.conversations();
      expect(list.conversations[0]).toMatchObject({
        conversationId: "g1",
        unreadCount: 2,
        preview: "林晓：上线时间改到周五，请确认",
        atMe: true,
      });
      const page = await service.messages({
        conversationId: "g1",
        limit: 30,
        includeConversation: false,
      });
      expect(page.messages.map(({ messageId }) => messageId)).toEqual(["e1", "m1"]);
      // The event arrived before the live read, so the read is the background one.
      expect(fake.messageCalls).toBe(callsBefore + 1);
    } finally {
      service.dispose();
    }
  });

  it("keeps message content out of the diagnostics and bounds the record", async () => {
    const env = await environment();
    const fake = state({ unread: [conversation("a", 200)], messages: [messageRow("m1", "a", 1)] });
    const cli = fakeCli(fake);
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    try {
      for (let index = 0; index < 70; index += 1) {
        await service.messages({ conversationId: "a", limit: 30, includeConversation: false });
      }
      const diagnostics = await service.diagnostics({ limit: 200 });
      expect(diagnostics.entries).toHaveLength(60);
      expect(diagnostics.entries[0]).toMatchObject({
        kind: "messages",
        conversationId: "a",
        memoryHit: true,
      });
      expect(diagnostics.entries[0]?.waitedMs).toBeLessThan(120);
      expect(JSON.stringify(diagnostics)).not.toContain("预算表");
      expect(diagnostics.storeBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
      expect(diagnostics.peakStoreBytes).toBeGreaterThan(0);
    } finally {
      service.dispose();
    }
  });

  it("drops the whole live state on logout", async () => {
    const env = await environment();
    const fake = state({ unread: [conversation("a", 200)], messages: [messageRow("m1", "a", 1)] });
    const cli = fakeCli(fake);
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    try {
      await service.conversations();
      await service.messages({ conversationId: "a", limit: 30, includeConversation: false });
      expect((await service.diagnostics()).storeBytes).toBeGreaterThan(0);

      cli.authStatus = async () => ({
        installed: true,
        authenticated: false,
        userId: null,
        userName: null,
        corpName: null,
        errorCode: "not_logged_in",
      });
      await service.status();
      const diagnostics = await service.diagnostics();
      expect(diagnostics.storeBytes).toBe(0);
      expect(diagnostics.conversations).toBe(0);
      expect(diagnostics.messageConversations).toBe(0);
    } finally {
      service.dispose();
    }
  });

  it("prefetches the rows the list shows, deduplicated per conversation", async () => {
    const env = await environment();
    const fake = state({
      unread: [conversation("a", 200), conversation("b", 100)],
      messages: [messageRow("m1", "a", RECENT_BASE)],
    });
    const cli = fakeCli(fake);
    const read = cli.messages.bind(cli);
    cli.messages = async (input) => {
      await sleep(30);
      return await read(input);
    };
    const service = new DingTalkService({ environment: env, isLocalHost: true, cli });
    try {
      await service.conversations();
      const before = fake.messageCalls;
      const started = await service.prefetch({ conversationIds: ["a", "b", "a"] });
      expect(started.started).toBe(2);
      const overlapping = await service.prefetch({ conversationIds: ["a", "b"] });
      expect(overlapping.started).toBe(0);
      await vi.waitFor(() => expect(fake.messageCalls).toBe(before + 2), { timeout: 2_000 });
      const diagnostics = await service.diagnostics();
      expect(diagnostics.messageConversations).toBe(2);
      expect(diagnostics.entries.some(({ kind }) => kind === "prefetch")).toBe(true);
    } finally {
      service.dispose();
    }
  });
});
