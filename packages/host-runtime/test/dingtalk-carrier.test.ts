import { describe, expect, it } from "vitest";

import {
  dingtalkConversationPath,
  dingtalkMessagePath,
  formatDingTalkMentionLink,
  hasDingTalkCarrier,
  stripDingTalkMentions,
} from "@codexhost/shared-contracts";

describe("DingTalk carriers", () => {
  it("encodes conversation ids that contain /, + and =", () => {
    const conversationId = "cid-test/slash+plus==";
    const path = dingtalkConversationPath(conversationId);
    expect(path).toBe(`dingtalk://conversation/${encodeURIComponent(conversationId)}`);
    const link = formatDingTalkMentionLink({
      kind: "conversation",
      conversationId,
      label: "财务群",
    });
    expect(link).toBe(`[@财务群](${path})`);
    expect(stripDingTalkMentions(link)).toEqual({
      text: "@财务群",
      mentions: [{ kind: "conversation", conversationId, label: "财务群" }],
    });
  });

  it("keeps multiple message ids and merges repeated carriers", () => {
    const conversationId = "cid-test-alpha==";
    const first = formatDingTalkMentionLink({
      kind: "messages",
      conversationId,
      messageIds: ["msgA==", "msgB=="],
      label: "线上群（2 条消息）",
    });
    const second = `[群](dingtalk://message/${encodeURIComponent(conversationId)}/${encodeURIComponent("msgC==")})`;
    const result = stripDingTalkMentions(`${first} 和 ${second}`);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]).toEqual({
      kind: "messages",
      conversationId,
      messageIds: ["msgA==", "msgB==", "msgC=="],
      label: "线上群（2 条消息）",
    });
    expect(result.text).toBe("@线上群（2 条消息） 和 @群");
  });

  it("accepts raw ids and the last slash as the message separator", () => {
    const text = "[x](dingtalk://message/cid/with/slash/msg1,msg2)";
    const result = stripDingTalkMentions(text);
    expect(result.mentions).toEqual([
      {
        kind: "messages",
        conversationId: "cid/with/slash",
        messageIds: ["msg1", "msg2"],
        label: "x",
      },
    ]);
  });

  it("ignores invalid or unrelated links", () => {
    expect(hasDingTalkCarrier("plain text")).toBe(false);
    expect(hasDingTalkCarrier("[x](dingtalk://message/only-cid)")).toBe(false);
    expect(stripDingTalkMentions("[x](https://example.com)").text).toBe("[x](https://example.com)");
  });

  it("builds a message path with encoded ids", () => {
    expect(dingtalkMessagePath("cid/a", ["m 1", "m/2"])).toBe(
      `dingtalk://message/${encodeURIComponent("cid/a")}/${encodeURIComponent("m 1")},${encodeURIComponent("m/2")}`,
    );
  });
});
