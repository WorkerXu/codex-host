import { describe, expect, it } from "vitest";

import type { DingTalkMessage } from "@codexhost/shared-contracts";

import {
  conversationMention,
  dingtalkInitial,
  formatDingTalkTime,
  messagePreview,
} from "../src/settings/dingtalk-page-model.js";

function message(overrides: Partial<DingTalkMessage> = {}): DingTalkMessage {
  return {
    messageId: "m1",
    conversationId: "cid",
    senderName: "张三",
    createdAt: 0,
    text: "hello",
    unsupported: false,
    mine: false,
    ...overrides,
  };
}

describe("DingTalk page model", () => {
  it("formats today, this year and older times", () => {
    const now = new Date(2026, 10, 13, 18, 0, 0).getTime();
    expect(formatDingTalkTime(new Date(2026, 10, 13, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatDingTalkTime(new Date(2026, 10, 2, 9, 5).getTime(), now)).toBe("11-02");
    expect(formatDingTalkTime(new Date(2025, 10, 2, 9, 5).getTime(), now)).toBe("2025-11-02");
    expect(formatDingTalkTime(null, now)).toBe("");
  });

  it("uses a readable avatar initial", () => {
    expect(dingtalkInitial(" 财务打款群 ")).toBe("财");
    expect(dingtalkInitial("")).toBe("钉");
  });

  it("builds conversation and message mentions", () => {
    const conversation = {
      conversationId: "cidA==",
      title: "线上群",
      singleChat: false,
      unreadCount: 1,
      lastMessageAt: 1,
      muted: false,
    };
    expect(conversationMention(conversation, "cidA==")).toMatchObject({
      kind: "conversation",
      label: "线上群",
    });
    expect(conversationMention(conversation, "cidA==", ["m1", "m2"])).toEqual({
      kind: "messages",
      conversationId: "cidA==",
      messageIds: ["m1", "m2"],
      label: "线上群（2 条消息）",
    });
  });

  it("summarises unsupported messages without leaking bodies", () => {
    expect(messagePreview(message({ unsupported: true }))).toBe("非文本消息，请在手机上查看");
    expect(messagePreview(message({ text: "a\n b" }))).toBe("a b");
  });
});
