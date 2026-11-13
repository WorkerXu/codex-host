import { describe, expect, it } from "vitest";

import type { DingTalkMessage } from "@codexhost/shared-contracts";

import {
  avatarTone,
  conversationMention,
  dingtalkInitial,
  formatDingTalkDateLabel,
  formatDingTalkTime,
  highlightSegments,
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
  it("formats row times and date separators", () => {
    const now = new Date(2026, 10, 13, 18, 0, 0).getTime();
    expect(formatDingTalkTime(new Date(2026, 10, 13, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatDingTalkTime(new Date(2026, 10, 12, 9, 5).getTime(), now)).toBe("昨天");
    expect(formatDingTalkTime(new Date(2026, 10, 2, 9, 5).getTime(), now)).toBe("11-02");
    expect(formatDingTalkTime(new Date(2025, 10, 2, 9, 5).getTime(), now)).toBe("25-11-02");
    expect(formatDingTalkTime(null, now)).toBe("");
    expect(formatDingTalkDateLabel(new Date(2026, 10, 13, 9, 5).getTime(), now)).toBe("今天");
    expect(formatDingTalkDateLabel(new Date(2026, 10, 12, 9, 5).getTime(), now)).toBe("昨天");
    expect(formatDingTalkDateLabel(new Date(2026, 10, 5, 9, 5).getTime(), now)).toBe("11月5日");
  });

  it("keeps avatar tones and search highlights deterministic", () => {
    expect(avatarTone("cid-alpha")).toBe(avatarTone("cid-alpha"));
    expect(highlightSegments("季度预算审批单", "预算")).toEqual([
      { text: "季度", match: false },
      { text: "预算", match: true },
      { text: "审批单", match: false },
    ]);
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
