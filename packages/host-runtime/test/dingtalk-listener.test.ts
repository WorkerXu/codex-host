import { describe, expect, it, vi } from "vitest";

import { DingTalkEventListener } from "../src/dingtalk-listener.js";

function fakeCli(local: boolean) {
  const stops: (() => void)[] = [];
  let exits: (() => void)[] = [];
  const openEvents = vi.fn(async (input: { onExit?(): void }) => {
    exits.push(input.onExit ?? (() => undefined));
    return { stop: vi.fn(() => stops.push(() => undefined)) };
  });
  return {
    cli: {
      authStatus: async () => ({
        installed: local,
        authenticated: local,
        userId: null,
        userName: null,
        corpName: null,
        errorCode: null,
      }),
      openEvents,
    },
    openEvents,
    stops,
    exit() {
      for (const callback of exits) callback();
      exits = [];
    },
  };
}

describe("DingTalk event listener", () => {
  it("opens one stream and stops it on idle release", async () => {
    const fake = fakeCli(true);
    const listener = new DingTalkEventListener({
      cli: fake.cli,
      local: () => true,
      authenticate: async () => true,
      onRecord: () => undefined,
    });
    listener.touch();
    listener.touch();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.openEvents).toHaveBeenCalledTimes(1);
    expect(listener.running).toBe(true);
    listener.stop();
    expect(listener.running).toBe(false);
    listener.dispose();
  });

  it("does not open a stream on a Host that forwards reads", async () => {
    const fake = fakeCli(true);
    const listener = new DingTalkEventListener({
      cli: fake.cli,
      local: () => false,
      authenticate: async () => true,
      onRecord: () => undefined,
    });
    listener.touch();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.openEvents).not.toHaveBeenCalled();
    listener.dispose();
  });

  it("restarts after an unexpected exit with backoff", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCli(true);
      const listener = new DingTalkEventListener({
        cli: fake.cli,
        local: () => true,
        authenticate: async () => true,
        onRecord: () => undefined,
      });
      listener.touch();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.openEvents).toHaveBeenCalledTimes(1);
      fake.exit();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.openEvents).toHaveBeenCalledTimes(2);
      listener.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
