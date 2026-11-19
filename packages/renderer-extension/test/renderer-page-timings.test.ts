import { afterEach, describe, expect, it, vi } from "vitest";

import { recordRendererPageOpen, rendererPageTimings } from "../src/renderer-page-timings.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings page timings", () => {
  it("records bounded first-frame timings and publishes them for read-only probes", () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: (time: number) => void) => callback(now),
    });

    recordRendererPageOpen("accounts", 100, "local");
    now = 250;
    recordRendererPageOpen("connections", 100);
    expect(rendererPageTimings()).toEqual([
      { page: "accounts", hostId: "local", firstPaintMs: 0, atMs: 100 },
      { page: "connections", hostId: null, firstPaintMs: 150, atMs: 250 },
    ]);
    expect((globalThis as { __codexhostPageTimingsV1?: unknown }).__codexhostPageTimingsV1).toBe(
      rendererPageTimings(),
    );

    for (let index = 0; index < 30; index += 1) {
      now = 300 + index;
      recordRendererPageOpen("usage-statistics", now - 200, "remote");
    }
    expect(rendererPageTimings()).toHaveLength(24);
    expect(rendererPageTimings().at(-1)).toMatchObject({
      page: "usage-statistics",
      hostId: "remote",
      firstPaintMs: 200,
    });
  });
});
