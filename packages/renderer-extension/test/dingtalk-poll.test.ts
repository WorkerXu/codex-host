import { describe, expect, it, vi } from "vitest";

import {
  DINGTALK_POLL_CONVERSATION_MS,
  DINGTALK_POLL_LIST_MS,
  startDingTalkPoll,
} from "../src/settings/dingtalk-poll.js";

function timers() {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  return {
    callbacks,
    setTimer: (run: () => void) => {
      const id = next++;
      callbacks.set(id, run);
      return id;
    },
    clearTimer: (id: number) => {
      callbacks.delete(id);
    },
    tick(id: number) {
      callbacks.get(id)?.();
    },
  };
}

describe("DingTalk visible-page polling", () => {
  it("polls the open conversation and the list on their own intervals", async () => {
    const timer = timers();
    const conversation = vi.fn();
    const list = vi.fn();
    const poll = startDingTalkPoll({
      isVisible: () => true,
      pollConversation: conversation,
      pollList: list,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    expect(timer.callbacks.size).toBe(2);
    const [conversationTimer, listTimer] = [...timer.callbacks.keys()] as [number, number];
    timer.tick(conversationTimer);
    timer.tick(listTimer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conversation).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
    expect(DINGTALK_POLL_CONVERSATION_MS).toBe(10_000);
    expect(DINGTALK_POLL_LIST_MS).toBe(30_000);
    poll.stop();
    expect(timer.callbacks.size).toBe(0);
  });

  it("never polls a hidden page and does not overlap a slow read", async () => {
    const timer = timers();
    let visible = false;
    let release: (() => void) | undefined;
    const conversation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const poll = startDingTalkPoll({
      isVisible: () => visible,
      pollConversation: conversation,
      pollList: () => undefined,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    const [conversationTimer] = [...timer.callbacks.keys()] as [number];
    timer.tick(conversationTimer);
    expect(conversation).not.toHaveBeenCalled();
    visible = true;
    timer.tick(conversationTimer);
    timer.tick(conversationTimer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conversation).toHaveBeenCalledOnce();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    timer.tick(conversationTimer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conversation).toHaveBeenCalledTimes(2);
    poll.stop();
    visible = false;
    timer.tick(conversationTimer);
    expect(conversation).toHaveBeenCalledTimes(2);
  });
});
