import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHubCaches,
  hubAgeLabel,
  HubCacheController,
  readHubCache,
  writeHubCache,
} from "../../src/settings/hub-cache.js";

beforeEach(() => clearHubCaches());

describe("Hub view cache", () => {
  it("renders the cached value before the background refresh resolves", async () => {
    writeHubCache("hub-mcp", { servers: 2 }, 1_000);
    let resolve!: (value: { servers: number }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ servers: number }>((done) => {
          resolve = done;
        }),
    );
    const render = vi.fn();
    const controller = new HubCacheController("hub-mcp", load, render, () => 2_000);
    controller.mount();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenLastCalledWith({ value: { servers: 2 }, updatedAt: 1_000 });
    expect(load).toHaveBeenCalledTimes(1);
    resolve({ servers: 3 });
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(render).toHaveBeenLastCalledWith({ value: { servers: 3 }, updatedAt: 2_000 });
    expect(readHubCache("hub-mcp")).toEqual({ value: { servers: 3 }, updatedAt: 2_000 });
  });

  it("does not paint a stale value when nothing is cached", async () => {
    const render = vi.fn();
    const controller = new HubCacheController(
      "hub-memory",
      async () => ({ total: 4 }),
      render,
      () => 5_000,
    );
    controller.mount();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    expect(render).toHaveBeenCalledWith({ value: { total: 4 }, updatedAt: 5_000 });
  });
});

describe("Hub updated label", () => {
  const now = 1_000_000;
  it.each([
    [now - 10_000, "刚刚"],
    [now - 180_000, "3 分钟前"],
    [now - 7_200_000, "2 小时前"],
    [now - 172_800_000, "2 天前"],
  ])("formats %i", (updatedAt, label) => {
    expect(hubAgeLabel(updatedAt, now)).toBe(label);
  });
});
