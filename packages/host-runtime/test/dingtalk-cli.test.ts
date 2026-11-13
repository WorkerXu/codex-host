import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  messageIsUnsupported,
  parseConversationInfo,
  parseDwsEventLine,
  parseDwsTime,
  parseMessagesPage,
  parseUnreadConversations,
  runDwsJson,
  runDwsRaw,
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

  it("parses conversation info", () => {
    expect(
      parseConversationInfo({
        result: {
          conversationInfo: { openConversationId: "cidB==", title: "财务", singleChat: true },
        },
      }),
    ).toMatchObject({ conversationId: "cidB==", title: "财务", singleChat: true });
  });

  it("parses message pages and marks non-text bodies", () => {
    const page = parseMessagesPage(
      {
        hasMore: true,
        nextPage: { nextCursor: 1_700_000_000_000 },
        messages: [
          {
            messageId: "m1",
            conversationId: "cidA==",
            sender: "张三",
            senderId: "u1",
            createTime: "2026-11-13 15:29:00",
            text: "hello",
          },
          {
            messageId: "m2",
            conversationId: "cidA==",
            sender: "李四",
            createTime: "2026-11-13 15:30:00",
            text: "[图片消息](mediaId=@x)",
          },
        ],
      },
      "u1",
    );
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(1_700_000_000_000);
    expect(page.messages.map((message) => message.messageId)).toEqual(["m2", "m1"]);
    expect(page.messages[1]).toMatchObject({ mine: true, unsupported: false });
    expect(page.messages[0]?.unsupported).toBe(true);
  });

  it("recognises unsupported message summaries", () => {
    expect(messageIsUnsupported("", false)).toBe(true);
    expect(messageIsUnsupported("[文件] 报表.xlsx fileId: x", true)).toBe(true);
    expect(messageIsUnsupported("收到", false)).toBe(false);
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
      childWith(JSON.stringify({ success: true, authenticated: true, user_id: "u1" })),
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
});
