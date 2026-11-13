import { describe, expect, it } from "vitest";

import { formatDingTalkMentionLink, type DingTalkResolveResult } from "@codexhost/shared-contracts";

import {
  dingtalkMentionContextBlock,
  expandDingTalkMentions,
} from "../src/dingtalk-mention-rewrite.js";

function resolved(
  conversationId: string,
  messages: { id: string; text: string; at: number }[],
): DingTalkResolveResult {
  return {
    available: true,
    conversation: {
      conversationId,
      title: "线上系统问题反馈群",
      singleChat: false,
      unreadCount: 1,
      lastMessageAt: 400,
      muted: false,
    },
    messages: messages.map(({ id, text, at }) => ({
      messageId: id,
      conversationId,
      senderName: "张三",
      createdAt: at,
      text,
      unsupported: false,
      mine: false,
    })),
    errorCode: null,
  };
}

describe("DingTalk mention expansion", () => {
  it("returns text untouched without a carrier", async () => {
    const result = await expandDingTalkMentions("hello", {
      resolve: async () => {
        throw new Error("must not run");
      },
    });
    expect(result).toEqual({ text: "hello", mentions: [] });
  });

  it("replaces a conversation carrier with a read-only context block", async () => {
    const link = formatDingTalkMentionLink({
      kind: "conversation",
      conversationId: "cidA==",
      label: "线上群",
    });
    const result = await expandDingTalkMentions(`看下 ${link}`, {
      resolve: async () => resolved("cidA==", [{ id: "m1", text: "第一条", at: 100 }]),
    });
    expect(result.text.startsWith("看下 @线上群\n\n[codexhost DingTalk]")).toBe(true);
    expect(result.text).toContain("群聊「线上系统问题反馈群」");
    expect(result.text).toContain("张三：第一条");
    expect(result.text).toContain("codexhost dingtalk dws");
    expect(result.text).toContain("--yes");
    expect(result.text).not.toContain("dingtalk://");
  });

  it("marks selected messages and keeps a failure note", async () => {
    const link = formatDingTalkMentionLink({
      kind: "messages",
      conversationId: "cidA==",
      messageIds: ["m1", "m2"],
      label: "两条消息",
    });
    const result = await expandDingTalkMentions(link, {
      resolve: async () =>
        resolved("cidA==", [
          { id: "m1", text: "第一条", at: 100 },
          { id: "m2", text: "第二条", at: 200 },
        ]),
    });
    expect(result.text.match(/\[选中\]/gu)).toHaveLength(2);

    const failed = await expandDingTalkMentions(link, {
      resolve: async () => {
        throw new Error("peer unavailable");
      },
    });
    expect(failed.text).toContain("读取失败：peer unavailable");
  });

  it("formats a block independently of the resolver", () => {
    const block = dingtalkMentionContextBlock([
      {
        mention: { kind: "conversation", conversationId: "cidA==", label: "群" },
        result: resolved("cidA==", [{ id: "m1", text: "x", at: 100 }]),
        error: null,
      },
    ]);
    expect(block).toContain("[codexhost DingTalk]");
    expect(block).toContain("cidA==");
  });
});
