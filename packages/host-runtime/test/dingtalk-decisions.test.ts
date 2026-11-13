import { describe, expect, it } from "vitest";

import type { DingTalkConversation } from "@codexhost/shared-contracts";

import {
  buildDingTalkDecideRequest,
  buildDingTalkScoreRequest,
  dingtalkMessageKeyword,
  parseDingTalkDecideAnswers,
  parseDingTalkScoreResponse,
} from "../src/dingtalk-decisions.js";

function conversation(id: string, title: string): DingTalkConversation {
  return {
    conversationId: id,
    title,
    singleChat: false,
    unreadCount: 2,
    lastMessageAt: 1_791_000_000_000,
    muted: false,
    preview: "最近的回复",
  };
}

describe("DingTalk search decisions", () => {
  it("asks for a route, sender scope, @-scope and time range", () => {
    const request = buildDingTalkDecideRequest("最新给我发消息的", [
      conversation("a", "财务打款群"),
    ]);
    expect(Object.keys(request.questions)).toEqual(["route", "from_me", "at_me", "range"]);
    expect(request.input).toContain("财务打款群");
    expect(request.questions.route).toMatchObject({ type: "choice" });
  });

  it("parses model answers conservatively", () => {
    expect(
      parseDingTalkDecideAnswers({
        answers: {
          route: { choice: "messages" },
          from_me: { noul: 0.9 },
          at_me: { noul: 0.1 },
          range: { choice: "7" },
        },
      }),
    ).toEqual({ route: "messages", fromMe: true, atMe: false, days: 7 });
    expect(
      parseDingTalkDecideAnswers({
        answers: { route: { choice: "bogus" }, range: { choice: "365" } },
      }),
    ).toEqual({ route: "none", fromMe: false, atMe: false, days: 30 });
  });

  it("builds one score question per candidate", () => {
    const request = buildDingTalkScoreRequest("找财务群", [
      conversation("a", "财务打款群"),
      conversation("b", "监控群"),
    ]);
    expect(Object.keys(request.questions)).toEqual(["rel_0", "rel_1"]);
    expect(
      parseDingTalkScoreResponse({ answers: { rel_0: { score: 2 }, rel_1: { score: 0 } } }, 2),
    ).toEqual([2, 0]);
  });

  it("removes instruction words for keyword search", () => {
    expect(dingtalkMessageKeyword("帮我搜索聊天记录里关于支付的消息")).toBe("支付");
    expect(dingtalkMessageKeyword("给")).toBe("给");
    expect(dingtalkMessageKeyword("  ")).toBe("");
  });
});
