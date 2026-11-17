import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  createDingTalkCli,
  parseAtMeHits,
  parseConversationInfo,
  parseDwsEventLine,
  parseDwsTime,
  parseGroupDirectory,
  parseGroupSearch,
  parseMessagesPage,
  parsePersonSearch,
  parseUnreadConversations,
  parseMembers,
  runDwsJson,
  runDwsRaw,
  sanitizeDingTalkText,
} from "../src/dingtalk-cli.js";

function childWith(stdout: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", exitCode);
  });
  return child;
}

describe("dws CLI output", () => {
  it("deduplicates message rows by messageId without collapsing equal text", () => {
    const row = {
      messageId: "m1",
      conversationId: "cid",
      sender: "甲",
      text: "same",
      createTime: 1000,
    };
    const page = parseMessagesPage({ messages: [row, row, { ...row, messageId: "m2" }] }, null);
    expect(page.messages.map((message) => message.messageId)).toEqual(["m1", "m2"]);
  });
  it("parses unread conversations and muted state", () => {
    const conversations = parseUnreadConversations({
      success: true,
      result: {
        conversations: [
          {
            openConversationId: "cidA==",
            title: "线上群",
            singleChat: false,
            unreadPoint: 3,
            lastMsgCreateAt: 1_791_000_000_000,
            notificationOff: 1,
          },
        ],
      },
    });
    expect(conversations).toEqual([
      {
        conversationId: "cidA==",
        title: "线上群",
        singleChat: false,
        unreadCount: 3,
        lastMessageAt: 1_791_000_000_000,
        muted: true,
      },
    ]);
  });

  it("parses group search rows", () => {
    expect(
      parseGroupSearch({
        result: {
          groups: [
            {
              openConversationId: "cidA==",
              title: "【示例Sprint】 进度",
              groupType: "INTERNAL_GROUP",
              memberCount: 15,
              createAt: "2026-05-06 08:34:54",
            },
          ],
        },
      }),
    ).toEqual([
      {
        conversationId: "cidA==",
        title: "【示例Sprint】 进度",
        singleChat: false,
        unreadCount: 0,
        lastMessageAt: parseDwsTime("2026-05-06 08:34:54"),
        muted: false,
        groupType: "INTERNAL_GROUP",
        memberCount: 15,
      },
    ]);
  });

  it("parses people returned by contact search", () => {
    expect(
      parsePersonSearch({
        result: [
          {
            name: "林晓",
            title: "产品经理",
            userId: "u1",
            openDingTalkId: "open-1",
          },
        ],
      }),
    ).toEqual([{ name: "林晓", title: "产品经理", userId: "u1", openDingTalkId: "open-1" }]);
  });

  it("parses and de-duplicates group members", () => {
    expect(
      parseMembers({
        users: [
          {
            memberEmpName: "王鹏远",
            memberNick: "王鹏远",
            memberRoleDesc: "普通成员",
            openDingtalkId: "open-1",
          },
          { name: "李书月", role: "群主", openDingtalkId: "open-2" },
          { name: "重复", openDingtalkId: "open-1" },
        ],
        bots: [],
      }),
    ).toEqual([
      { openDingTalkId: "open-1", name: "王鹏远", title: "普通成员" },
      { openDingTalkId: "open-2", name: "李书月", title: "群主" },
    ]);
  });

  it("parses the group directory and at-me hits", () => {
    const directory = parseGroupDirectory({
      result: {
        groups: [
          {
            openConversationId: "cidA==",
            title: "线上群",
            groupType: "INTERNAL_GROUP",
            memberCount: 18,
          },
        ],
      },
    });
    expect(directory.get("cidA==")).toEqual({
      title: "线上群",
      groupType: "INTERNAL_GROUP",
      memberCount: 18,
    });
    expect(
      parseAtMeHits({
        items: [{ conversationId: "cidA==", time: "2026-11-16 11:02:58" }],
      }),
    ).toEqual([{ conversationId: "cidA==", createdAt: parseDwsTime("2026-11-16 11:02:58") }]);
  });

  it("parses conversation info with the member count", () => {
    expect(
      parseConversationInfo({
        result: {
          conversationInfo: {
            openConversationId: "cidB==",
            title: "财务",
            singleChat: true,
            memberCount: 2,
          },
        },
      }),
    ).toMatchObject({
      conversationId: "cidB==",
      title: "财务",
      singleChat: true,
      memberCount: 2,
    });
  });

  it("parses real message fields: quote, reactions, resources, bot and cards", () => {
    const page = parseMessagesPage(
      {
        hasMore: true,
        nextPage: { nextCursor: 1_700_000_000_000 },
        messages: [
          {
            messageId: "m1",
            conversationId: "cidA==",
            sender: "发布机器人",
            senderId: "bot-1",
            createTime: "2026-11-13 15:29:00",
            sendType: "bot",
            text: [
              "[图片消息](mediaId=@media-1)",
              "图片内容：",
              "<imageContent>",
              "11",
              "</imageContent>",
              "【云监控】发布检查",
              "",
              ">- 服务: saas",
              "",
              "[查看详情](https://example.com/detail)",
            ].join("\n"),
            resourceRefs: [
              {
                resourceId: "@media-1",
                resourceIdType: "mediaId",
                type: "mediaId",
                contentType: "image",
              },
            ],
            quotedMessage: {
              sender: "赵明",
              content: "预算表第二版",
              openMessageId: "m0",
              createTime: "2026-11-13 15:20:00",
            },
            reactions: {
              counts: [{ emoji: "OK", count: 3 }],
              details: [],
            },
            emotionReplyList: [{ emoji: "收到", replyUsers: ["u1"] }],
          },
          {
            messageId: "m2",
            conversationId: "cidA==",
            sender: "李四",
            createTime: "2026-11-13 15:30:00",
            text: "[文件] 报表.xlsx fileId: file-1",
            resourceRefs: [
              {
                resourceId: "file-1",
                resourceIdType: "fileId",
                type: "fileId",
                contentType: "file",
                name: "报表.xlsx",
              },
            ],
          },
        ],
      },
      null,
    );
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(1_700_000_000_000);
    expect(page.messages[1]?.unsupported).toBe(false);
    expect(page.messages[1]).toMatchObject({
      bot: true,
      cardTitle: "【云监控】发布检查",
      format: "markdown",
      quotedMessage: { senderName: "赵明", text: "预算表第二版" },
      reactions: [{ emoji: "OK", count: 3 }],
      resources: [{ kind: "image", resourceId: "@media-1", resourceIdType: "mediaId" }],
    });
    expect(page.messages[1]?.text).toContain(">- 服务: saas");
    expect(page.messages[1]?.text).not.toContain("mediaId");
    expect(page.messages[1]?.text).not.toContain("imageContent");
    expect(page.messages[0]).toMatchObject({
      text: "",
      unsupported: false,
      resources: [{ kind: "file", name: "报表.xlsx", resourceId: "file-1" }],
    });
  });

  it("removes media markers and raw ids everywhere", () => {
    expect(
      sanitizeDingTalkText(
        "[图片消息](mediaId=@abc) 图片内容：\n<imageContent> 11 </imageContent>\n【云监控】告警 <font color='#fff'>卡片样式</font>",
      ),
    ).toBe("【云监控】告警 卡片样式");
  });

  it("parses flattened event lines only", () => {
    expect(
      parseDwsEventLine(
        JSON.stringify({
          type: "user_im_message_receive_group_all",
          payload: {
            message_id: "m1",
            conversation_id: "cidA==",
            sender: "张三",
            sender_open_dingtalk_id: "open-1",
            content: "hi",
            create_time: "2026-11-13 15:30:00",
          },
        }),
      ),
    ).toEqual({
      messageId: "m1",
      conversationId: "cidA==",
      senderName: "张三",
      senderId: "open-1",
      text: "hi",
      createdAt: parseDwsTime("2026-11-13 15:30:00"),
      kind: "group",
      atMe: false,
      atAll: false,
    });
    expect(parseDwsEventLine("[event] ready")).toBeNull();
    expect(parseDwsEventLine('{"type":"reaction"}')).toBeNull();
  });

  it("parses Shanghai wall-clock times", () => {
    expect(parseDwsTime("2026-11-13 15:29:00")).toBe(Date.parse("2026-11-13T07:29:00Z"));
    expect(parseDwsTime(1_791_000_000_000)).toBe(1_791_000_000_000);
    expect(parseDwsTime("nope")).toBeNull();
  });
});

describe("dws process invocation", () => {
  it("reports not installed when no executable exists", async () => {
    const raw = await runDwsRaw(["auth", "status"], {
      environment: { HOME: "/nonexistent-codexhost-home", PATH: "" } as NodeJS.ProcessEnv,
    });
    expect(raw.exitCode).toBeNull();
    expect(raw.stderr).toContain("not installed");
  });

  it("passes an argument array and returns parsed JSON", async () => {
    const spawnImpl = vi.fn(() =>
      childWith(
        JSON.stringify({ success: true, errorCode: 0, authenticated: true, user_id: "u1" }),
      ),
    );
    const result = await runDwsJson(["auth", "status", "--readonly"], {
      executable: "/fake/dws",
      spawnImpl: spawnImpl as never,
    });
    expect(result.errorCode).toBeNull();
    expect(result.value).toMatchObject({ authenticated: true });
    expect(spawnImpl).toHaveBeenCalledWith(
      "/fake/dws",
      ["auth", "status", "--readonly", "--format", "json"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("reports a spawn error as a CLI failure, not a timeout", async () => {
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => true);
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    });
    const result = await runDwsJson(["auth", "status"], {
      executable: "/fake/dws",
      spawnImpl: spawnImpl as never,
    });
    expect(result.errorCode).toBe("cli_failed");
    expect(result.timedOut).toBe(false);
  });

  it("turns a hanging command into a timeout", async () => {
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => true);
      return child;
    });
    const raw = await runDwsRaw(["chat", "message", "list"], {
      executable: "/fake/dws",
      spawnImpl: spawnImpl as never,
      timeoutMs: 10,
    });
    expect(raw.timedOut).toBe(true);
    expect(raw.exitCode).toBeNull();
  });

  it("reads group members with the documented command", async () => {
    const calls: string[][] = [];
    const cli = createDingTalkCli({
      runImpl: async (args) => {
        calls.push([...args]);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          value: {
            users: [{ name: "王鹏远", openDingtalkId: "open-1", role: "普通成员" }],
          },
          errorCode: null,
          errorMessage: null,
        };
      },
    });
    expect(await cli.members("cidA==")).toMatchObject({
      members: [{ name: "王鹏远", openDingTalkId: "open-1" }],
      errorCode: null,
    });
    expect(calls[0]).toEqual([
      "chat",
      "+chat-members-list",
      "--conversation-id",
      "cidA==",
      "--member-types",
      "user",
      "--page-limit",
      "20",
    ]);
  });

  it("passes @ targets only when the caller selected them", async () => {
    const calls: string[][] = [];
    const cli = createDingTalkCli({
      runImpl: async (args) => {
        calls.push([...args]);
        return {
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          timedOut: false,
          truncated: false,
          value: {},
          errorCode: null,
          errorMessage: null,
        };
      },
    });
    await cli.send("cidA==", "<@open-1> <@all> 请看", {
      atOpenDingTalkIds: ["open-1"],
      atAll: true,
    });
    expect(calls[0]).toEqual([
      "chat",
      "message",
      "send",
      "--conversation-id",
      "cidA==",
      "--content",
      "<@open-1> <@all> 请看",
      "--yes",
      "--at-open-dingtalk-ids",
      "open-1",
      "--at-all",
    ]);
  });
});

it("normalizes a real flattened direct schema and a transport envelope", () => {
  const payload = {
    type: "user_im_message_receive_o2o_all",
    message_id: "m-direct",
    conversation_id: "cid-direct",
    sender: "林晓",
    sender_open_dingtalk_id: "open-lin",
    content: "接口如何实现？",
    event_time: 2000,
  };
  const expected = {
    messageId: "m-direct",
    conversationId: "cid-direct",
    senderName: "林晓",
    senderId: "open-lin",
    text: "接口如何实现？",
    createdAt: 2000,
    kind: "direct",
    atMe: false,
    atAll: false,
  };
  expect(parseDwsEventLine(JSON.stringify(payload))).toEqual(expected);
  expect(
    parseDwsEventLine(
      JSON.stringify({ type: "event", event_type: payload.type, data: JSON.stringify(payload) }),
    ),
  ).toEqual(expected);
  expect(
    parseDwsEventLine(JSON.stringify({ ...payload, type: "user_im_reaction_added" })),
  ).toBeNull();
});

it("accepts the real OA success envelope with numeric errorCode 0", async () => {
  const calls: readonly string[][] = [];
  const runImpl = vi.fn(async (args: readonly string[]) => {
    (calls as string[][]).push([...args]);
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      errorCode: null,
      errorMessage: null,
      value: {
        success: true,
        errorCode: 0,
        result: {
          values: [
            {
              taskId: "task-1",
              processInstanceId: "p-1",
              title: "采购",
              originatorName: "林晓",
              originatorId: "u-1",
              processCreateTime: "2026-11-17 10:00:00",
              formMassage: "服务器",
              url: "https://example.test/approval",
            },
          ],
        },
      },
    };
  });
  const cli = createDingTalkCli({ runImpl });
  expect((await cli.pendingApprovals(20)).approvals[0]).toMatchObject({
    taskId: "task-1",
    formMessage: "服务器",
  });
  expect(calls).toEqual([["oa", "approval", "list-pending", "--limit", "20", "--page", "1"]]);
});
