import { describe, expect, it } from "vitest";

import type { DingTalkConversation, DingTalkMessage } from "@codexhost/shared-contracts";

import { DingTalkLiveStore } from "../src/dingtalk-live-store.js";

function row(conversationId: string, lastMessageAt: number, unreadCount = 1): DingTalkConversation {
  return {
    conversationId,
    title: `会话 ${conversationId}`,
    singleChat: false,
    unreadCount,
    lastMessageAt,
    muted: false,
  };
}

function message(
  messageId: string,
  conversationId: string,
  createdAt: number,
  text = "收到，我看一下",
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

describe("DingTalk live state", () => {
  it("bumps the row, its preview and its position on a Stream event", () => {
    const store = new DingTalkLiveStore();
    store.applyConversations([row("a", 100), row("b", 200)], { now: 1_000 });
    expect(store.rows().map(({ conversationId }) => conversationId)).toEqual(["b", "a"]);

    const changed = store.applyEvent({
      message: message("m1", "a", 300),
      preview: "林晓：收到，我看一下",
      title: "会话 a",
      singleChat: false,
      atMe: true,
      now: 2_000,
    });
    expect(changed).toBe(true);
    expect(store.rows()[0]).toMatchObject({
      conversationId: "a",
      unreadCount: 2,
      lastMessageAt: 300,
      preview: "林晓：收到，我看一下",
      atMe: true,
    });
  });

  it("does not invent a group row without a title, but does create a direct chat", () => {
    const store = new DingTalkLiveStore();
    expect(
      store.applyEvent({
        message: message("m1", "unknown", 100),
        preview: "林晓：收到",
        title: "",
        singleChat: false,
        atMe: false,
        now: 1_000,
      }),
    ).toBe(false);
    expect(store.rows()).toHaveLength(0);

    store.applyEvent({
      message: { ...message("m2", "dm-1", 200), senderName: "潘建开" },
      preview: "潘建开：在吗",
      title: "潘建开",
      singleChat: true,
      atMe: false,
      now: 1_000,
    });
    expect(store.rows()[0]).toMatchObject({
      conversationId: "dm-1",
      title: "潘建开",
      singleChat: true,
      unreadCount: 1,
    });
  });

  it("keeps events only for conversations whose transcript was opened once", () => {
    const store = new DingTalkLiveStore();
    store.applyConversations([row("a", 100), row("b", 100)], { now: 1_000 });
    store.applyMessages({
      conversationId: "a",
      messages: [message("m2", "a", 200), message("m1", "a", 100)],
      hasMore: true,
      nextCursor: 100,
      preview: "林晓：收到，我看一下",
      now: 2_000,
    });
    store.applyEvent({
      message: message("m3", "a", 300),
      preview: "林晓：收到，我看一下",
      title: "",
      singleChat: false,
      atMe: false,
      now: 3_000,
    });
    store.applyEvent({
      message: message("m9", "b", 300),
      preview: "林晓：收到",
      title: "",
      singleChat: false,
      atMe: false,
      now: 3_000,
    });

    expect(store.messages("a", 30, 3_000)?.messages.map(({ messageId }) => messageId)).toEqual([
      "m3",
      "m2",
      "m1",
    ]);
    expect(store.messages("b", 30, 3_000)).toBeNull();
  });

  it("derives an older-page cursor from the stored window without a gap", () => {
    const store = new DingTalkLiveStore();
    const messages = Array.from({ length: 50 }, (_, index) =>
      message(`m${50 - index}`, "a", 1_000 - index),
    );
    store.applyMessages({
      conversationId: "a",
      messages,
      hasMore: false,
      nextCursor: null,
      preview: null,
      now: 1_000,
    });
    const page = store.messages("a", 30, 2_000);
    expect(page?.messages).toHaveLength(30);
    expect(page?.hasMore).toBe(true);
    expect(page?.nextCursor).toBe(page?.messages.at(-1)?.createdAt);

    store.applyMessages({
      conversationId: "b",
      messages: messages.slice(0, 20),
      hasMore: true,
      nextCursor: 500,
      preview: null,
      now: 3_000,
    });
    expect(store.messages("b", 30, 4_000)).toMatchObject({ hasMore: true, nextCursor: 500 });

    store.applyMessages({
      conversationId: "c",
      messages: messages.slice(0, 20),
      hasMore: false,
      nextCursor: null,
      preview: null,
      now: 5_000,
    });
    expect(store.messages("c", 30, 6_000)).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("drops a message the live page no longer contains, but keeps concurrent events", () => {
    const store = new DingTalkLiveStore();
    store.applyMessages({
      conversationId: "a",
      messages: [message("m3", "a", 300), message("m2", "a", 200), message("m1", "a", 100)],
      hasMore: false,
      nextCursor: null,
      preview: null,
      now: 1_000,
    });
    store.applyEvent({
      message: message("m4", "a", 400),
      preview: "林晓：收到",
      title: "",
      singleChat: false,
      atMe: false,
      now: 1_100,
    });
    // dws no longer returns m2 (recalled); m4 arrived after the read started.
    store.applyMessages({
      conversationId: "a",
      messages: [message("m3", "a", 300), message("m1", "a", 100)],
      hasMore: false,
      nextCursor: null,
      preview: null,
      now: 1_200,
    });
    expect(store.messages("a", 30, 2_000)?.messages.map(({ messageId }) => messageId)).toEqual([
      "m4",
      "m3",
      "m1",
    ]);
  });

  it("keeps transcripts for 20 conversations and evicts the least recently viewed", () => {
    const store = new DingTalkLiveStore();
    for (let index = 0; index < 20; index += 1) {
      store.applyMessages({
        conversationId: `c${index}`,
        messages: [message(`m-c${index}`, `c${index}`, 100)],
        hasMore: false,
        nextCursor: null,
        preview: "林晓：收到",
        now: 1_000 + index,
      });
    }
    store.touch("c0", 2_000);
    store.applyMessages({
      conversationId: "c20",
      messages: [message("m-c20", "c20", 100)],
      hasMore: false,
      nextCursor: null,
      preview: "林晓：收到",
      now: 3_000,
    });

    const stats = store.stats();
    expect(stats.messageConversations).toBe(20);
    expect(store.messages("c0", 30, 4_000)).not.toBeNull();
    expect(store.messages("c1", 30, 4_000)).toBeNull();
    expect(store.rows()).toHaveLength(21);
  });

  it("drops payloads until the serialized store fits its byte cap", () => {
    const store = new DingTalkLiveStore({ maxBytes: 24_000 });
    const text = "预算表我改完第二版了，你看一下。".repeat(20);
    const rows = Array.from({ length: 10 }, (_, index) => row(`c${index}`, 100 + index));
    store.applyConversations(rows, { now: 1_000 });
    for (let index = 0; index < 10; index += 1) {
      store.applyMessages({
        conversationId: `c${index}`,
        messages: Array.from({ length: 10 }, (_, offset) =>
          message(`m${index}-${offset}`, `c${index}`, 100 + offset, text),
        ),
        hasMore: false,
        nextCursor: null,
        preview: "林晓：预算表我改完第二版了",
        now: 1_000 + index,
      });
    }

    const stats = store.stats();
    expect(stats.storeBytes).toBeLessThanOrEqual(24_000);
    expect(stats.peakStoreBytes).toBeLessThanOrEqual(24_000);
    expect(stats.peakStoreBytes).toBeGreaterThanOrEqual(stats.storeBytes);
    expect(store.rows().length).toBe(10);
    expect(stats.messageConversations).toBeLessThan(10);
    expect(store.messages("c9", 30, 5_000)).not.toBeNull();
  });

  it("keeps group metadata learned from details across a live list read", () => {
    const store = new DingTalkLiveStore();
    store.applyConversations([row("a", 100)], { now: 1_000 });
    store.applyDetails([
      { ...row("a", 100), groupType: "INTERNAL_GROUP", memberCount: 18, atMe: true },
    ]);
    store.applyConversations([row("a", 200, 3)], { now: 2_000 });
    expect(store.rows()[0]).toMatchObject({
      unreadCount: 3,
      lastMessageAt: 200,
      groupType: "INTERNAL_GROUP",
      memberCount: 18,
      atMe: true,
    });
  });

  it("clears rows, transcripts and members on clear", () => {
    const store = new DingTalkLiveStore();
    store.applyConversations([row("a", 100)], { now: 1_000 });
    store.applyMessages({
      conversationId: "a",
      messages: [message("m1", "a", 100)],
      hasMore: false,
      nextCursor: null,
      preview: null,
      now: 1_000,
    });
    store.applyMembers("a", [{ openDingTalkId: "open-1", name: "王鹏远" }], 1_000);
    store.clear();
    expect(store.hasList()).toBe(false);
    expect(store.rows()).toHaveLength(0);
    expect(store.messages("a", 30, 2_000)).toBeNull();
    expect(store.members("a", 2_000)).toBeNull();
    expect(store.stats()).toMatchObject({ storeBytes: 0, conversations: 0, messages: 0 });
  });
});
