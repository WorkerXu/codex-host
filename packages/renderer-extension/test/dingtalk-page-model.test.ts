import { describe, expect, it } from "vitest";

import type { DingTalkConversation, DingTalkMessage } from "@codexhost/shared-contracts";

import {
  avatarTone,
  conversationMention,
  dingtalkAvatarLabel,
  dingtalkInitial,
  formatDingTalkDateLabel,
  formatDingTalkFileSize,
  formatDingTalkTime,
  highlightSegments,
  messagePreview,
  mergeDingTalkConversationRow,
  mergeDingTalkMessages,
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
  it("reconciles an unidentified local echo once, before or after send acknowledgement", () => {
    const echo = {
      ...message({ messageId: "local-1", mine: true, createdAt: 2000 }),
      echoStartedAt: 2000,
      pending: true,
    };
    const remote = message({ messageId: "server-1", mine: true, createdAt: 2000 });
    expect(mergeDingTalkMessages([echo], [remote, remote])).toEqual([remote]);
    expect(mergeDingTalkMessages([{ ...echo, pending: false }], [remote])).toEqual([remote]);
    const distinct = { ...remote, messageId: "server-2" };
    expect(mergeDingTalkMessages([remote], [distinct])).toHaveLength(2);
    expect(mergeDingTalkMessages([echo], [{ ...remote, mine: false }])).toHaveLength(2);
    expect(mergeDingTalkMessages([echo], [{ ...remote, createdAt: 0 }])).toHaveLength(2);
    expect(
      mergeDingTalkMessages([echo, { ...echo, messageId: "local-2" }], [remote, distinct]),
    ).toEqual([remote, distinct]);
  });
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
    expect(avatarTone("cid-alpha")).toMatch(/^var\(--color-avatar-[a-z-]+\)$/u);
    expect(highlightSegments("季度预算审批单", "预算")).toEqual([
      { text: "季度", match: false },
      { text: "预算", match: true },
      { text: "审批单", match: false },
    ]);
  });

  it("uses native two-character avatar labels without punctuation", () => {
    expect(dingtalkInitial(" 财务打款群 ")).toBe("财务");
    expect(dingtalkInitial("")).toBe("钉");
    expect(dingtalkAvatarLabel("【示例Sprint】 进度")).toBe("示例");
    expect(dingtalkAvatarLabel("【线上系统问题反馈群】")).toBe("线上");
    expect(dingtalkAvatarLabel("  [设计评审]")).toBe("设计");
    expect(dingtalkAvatarLabel("林晓")).toBe("林晓");
    expect(dingtalkAvatarLabel("Lucy")).toBe("L");
    expect(dingtalkAvatarLabel("2026 Q4 华东区渠道生态合作伙伴联合增长计划讨论群")).toBe("华东");
    expect(dingtalkAvatarLabel("2027 年预算评审")).toBe("预算");
    expect(dingtalkAvatarLabel("王小明")).toBe("王小");
    expect(dingtalkAvatarLabel("【2027】 -- product review")).toBe("P");
    expect(dingtalkAvatarLabel("1234 !")).toBe("钉");
    expect(dingtalkAvatarLabel("【】[]")).toBe("钉");
  });

  it("formats file sizes", () => {
    expect(formatDingTalkFileSize(512)).toBe("512 B");
    expect(formatDingTalkFileSize(24_576)).toBe("24 KB");
    expect(formatDingTalkFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatDingTalkFileSize(null)).toBe("");
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

  it("keeps the newer preview when a list row is reconciled", () => {
    const previous: DingTalkConversation = {
      conversationId: "cid",
      title: "项目群",
      singleChat: false,
      unreadCount: 1,
      lastMessageAt: 300,
      muted: false,
      preview: "林晓：预算表我改完第二版了",
    };
    expect(
      mergeDingTalkConversationRow(previous, { ...previous, preview: undefined }),
    ).toMatchObject({ preview: "林晓：预算表我改完第二版了", lastMessageAt: 300 });
    expect(
      mergeDingTalkConversationRow(previous, {
        ...previous,
        lastMessageAt: 200,
        preview: "林晓：更早的一条",
      }),
    ).toMatchObject({ preview: "林晓：预算表我改完第二版了", lastMessageAt: 300 });
    expect(
      mergeDingTalkConversationRow(previous, {
        ...previous,
        lastMessageAt: 400,
        preview: "林晓：新的",
      }),
    ).toMatchObject({ preview: "林晓：新的", lastMessageAt: 400 });
  });

  it("summarises unsupported messages without leaking bodies", () => {
    expect(messagePreview(message({ unsupported: true }))).toBe("非文本消息，请在手机上查看");
    expect(messagePreview(message({ text: "a\n b" }))).toBe("a b");
  });
});
