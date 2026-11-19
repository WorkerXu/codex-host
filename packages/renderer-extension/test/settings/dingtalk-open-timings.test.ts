import { afterEach, describe, expect, it, vi } from "vitest";
import type { DingTalkMessage } from "@codexhost/shared-contracts";
import { createDingTalkOpenTimings } from "../../src/settings/dingtalk-open-timings.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  let now = 0;
  const frames: FrameRequestCallback[] = [];
  const report = vi.fn();
  const view = {
    performance: { now: () => now },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  } as unknown as Window;
  const timings = createDingTalkOpenTimings({ view, report });
  const message = { conversationId: "c", messageId: "m" } as DingTalkMessage;
  const resource = { kind: "image", resourceId: "r" } as NonNullable<
    DingTalkMessage["resources"]
  >[number];
  return {
    timings,
    report,
    message,
    resource,
    at: (time: number) => {
      now = time;
    },
    frame: () => frames.shift()?.(now),
  };
}

describe("DingTalk first viewport timings", () => {
  it("records text after a paint opportunity without waiting for offscreen images", () => {
    const f = fixture();
    f.timings.begin("c", [f.message], 0);
    f.timings.rendered(3);
    f.at(16);
    f.frame();
    expect(f.report).not.toHaveBeenCalled();
    f.at(32);
    f.frame();
    expect(f.report).toHaveBeenCalledWith("c", 32, 3, null);
    f.timings.imageStarted(f.message, f.resource);
    f.timings.imageSettled(f.message, f.resource);
    expect(f.report).toHaveBeenCalledOnce();
  });

  it("keeps the text timing separate from visible image completion", () => {
    const f = fixture();
    f.timings.begin("c", [f.message], 0);
    f.timings.rendered(4);
    f.at(16);
    f.frame();
    f.timings.imageStarted(f.message, f.resource);
    f.at(32);
    f.frame();
    f.at(1250);
    f.timings.imageSettled(f.message, f.resource);
    expect(f.report).toHaveBeenCalledWith("c", 32, 4, 1250);
  });

  it("does not report the timeout as completed images", () => {
    const f = fixture();
    f.timings.begin("c", [f.message], 0);
    f.timings.imageStarted(f.message, f.resource);
    f.timings.rendered(1);
    f.at(16);
    f.frame();
    f.at(32);
    f.frame();
    f.at(20000);
    vi.advanceTimersByTime(20000);
    expect(f.report).toHaveBeenCalledWith("c", 32, 1, null);
  });

  it("ignores an image from the previous open of the same conversation", () => {
    const f = fixture();
    f.timings.begin("c", [f.message], 0);
    f.timings.rendered(1);
    f.frame();
    f.at(32);
    f.frame();
    const nextMessage = { ...f.message };
    f.timings.begin("c", [nextMessage], 40);
    f.timings.imageStarted(nextMessage, f.resource);
    f.timings.rendered(1);
    f.frame();
    f.at(72);
    f.frame();
    f.timings.imageSettled(f.message, f.resource);
    expect(f.report).toHaveBeenCalledOnce();
    f.at(100);
    f.timings.imageSettled(nextMessage, f.resource);
    expect(f.report).toHaveBeenLastCalledWith("c", 32, 1, 60);
  });
});
