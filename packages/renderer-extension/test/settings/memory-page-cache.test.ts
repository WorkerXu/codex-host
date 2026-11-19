import { describe, expect, it, vi } from "vitest";
import {
  MemoryPageCache,
  MemoryPageStore,
  nextPageInput,
  type MemoryPage,
  type MemoryPageInput,
} from "../../src/settings/memory-page-cache.js";

function page(offset: number, total = 30): MemoryPage {
  return { total, offset, windowId: null, memories: [] };
}
function input(offset: number, query = "", source = ""): MemoryPageInput {
  return { query, source, offset };
}

describe("Memory page cache", () => {
  it("keys pages by query, source and offset", () => {
    const cache = new MemoryPageCache();
    cache.set(input(0), page(0));
    cache.set(input(10), page(10));
    cache.set(input(0, "发货"), page(0));
    cache.set(input(0, "", "chat"), page(0));
    expect(cache.size).toBe(4);
    expect(cache.get(input(10))?.offset).toBe(10);
    expect(cache.get(input(0, "发货"))).toBeDefined();
  });

  it("keeps only the 20 most recent pages", () => {
    const cache = new MemoryPageCache(20);
    for (let offset = 0; offset < 210; offset += 10) cache.set(input(offset), page(offset));
    expect(cache.size).toBe(20);
    expect(cache.get(input(0))).toBeUndefined();
    expect(cache.get(input(200))).toBeDefined();
  });

  it("renders a cached page before the revalidation resolves", async () => {
    const cache = new MemoryPageCache();
    cache.set(input(0), page(0));
    let resolve!: (value: MemoryPage) => void;
    const load = vi.fn(
      () =>
        new Promise<MemoryPage>((done) => {
          resolve = done;
        }),
    );
    const store = new MemoryPageStore(load, cache);
    const render = vi.fn();
    const opening = store.open(input(0), (value, fromCache) => render(value, fromCache));
    expect(render).toHaveBeenCalledWith(page(0), true);
    expect(load).toHaveBeenCalledTimes(1);
    resolve(page(0, 40));
    await opening;
    expect(render).toHaveBeenLastCalledWith(page(0, 40), false);
  });

  it("prefetches the next page once and shares in-flight requests", async () => {
    const cache = new MemoryPageCache();
    const load = vi.fn(async () => page(10));
    const store = new MemoryPageStore(load, cache);
    await Promise.all([store.prefetch(input(10)), store.prefetch(input(10))]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.peek(input(10))).toBeDefined();
  });

  it("only asks for a next page when one exists", () => {
    expect(nextPageInput(input(0), page(0, 30))).toMatchObject({ offset: 10 });
    expect(nextPageInput(input(20), page(20, 30))).toBeNull();
  });
});
