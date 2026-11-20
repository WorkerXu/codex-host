import { describe, expect, it } from "vitest";

import { parseDingTalkHref } from "../src/renderer-dingtalk-links.js";

describe("DingTalk reply links", () => {
  it("parses a conversation link", () => {
    expect(parseDingTalkHref("dingtalk://conversation/cid-test-alpha%3D%3D")).toEqual({
      conversationId: "cid-test-alpha==",
      messageIds: [],
    });
  });

  it("parses message links whose conversation id contains a slash", () => {
    const href = `dingtalk://message/${encodeURIComponent("cid/with+slash==")}/${encodeURIComponent(
      "msgA==",
    )},${encodeURIComponent("msgB==")}`;
    expect(parseDingTalkHref(href)).toEqual({
      conversationId: "cid/with+slash==",
      messageIds: ["msgA==", "msgB=="],
    });
  });

  it("rejects unrelated links", () => {
    expect(parseDingTalkHref("https://example.com")).toBeNull();
    expect(parseDingTalkHref("dingtalk://")).toBeNull();
    expect(parseDingTalkHref("dingtalk://channel/x")).toBeNull();
  });
});
