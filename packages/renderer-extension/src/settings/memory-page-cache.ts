import type { HubResult } from "@codexhost/shared-contracts";

export type MemoryPage = HubResult<"search">;
export interface MemoryPageInput {
  query: string;
  source: string;
  offset: number;
  windowId?: string | undefined;
}
const PAGE_SIZE = 10;
/** Bounded session cache; going back to a visited page paints before the Host answers. */
export class MemoryPageCache {
  readonly #pages = new Map<string, MemoryPage>();
  constructor(readonly limit = 20) {}
  key(input: Pick<MemoryPageInput, "query" | "source" | "offset">): string {
    return `${input.query}\u0000${input.source}\u0000${input.offset}`;
  }
  get(input: Pick<MemoryPageInput, "query" | "source" | "offset">): MemoryPage | undefined {
    const key = this.key(input);
    const value = this.#pages.get(key);
    if (value) {
      this.#pages.delete(key);
      this.#pages.set(key, value);
    }
    return value;
  }
  set(input: Pick<MemoryPageInput, "query" | "source" | "offset">, page: MemoryPage): void {
    const key = this.key(input);
    this.#pages.delete(key);
    this.#pages.set(key, page);
    while (this.#pages.size > this.limit) {
      const oldest = this.#pages.keys().next().value;
      if (oldest === undefined) break;
      this.#pages.delete(oldest);
    }
  }
  get size(): number {
    return this.#pages.size;
  }
  clear(): void {
    this.#pages.clear();
  }
}
/** Shared for the renderer session, so reopening 记忆 keeps visited pages. */
export const memoryPageCache = new MemoryPageCache();
export function nextPageInput(input: MemoryPageInput, page: MemoryPage): MemoryPageInput | null {
  return page.offset + PAGE_SIZE < page.total
    ? {
        query: input.query,
        source: input.source,
        offset: page.offset + PAGE_SIZE,
        windowId: page.windowId ?? undefined,
      }
    : null;
}

/**
 * SWR loader: a cached page renders synchronously, then revalidates; a miss
 * waits for the Host. Identical in-flight requests are shared.
 */
export class MemoryPageStore {
  readonly #inflight = new Map<string, Promise<MemoryPage>>();
  constructor(
    private readonly load: (input: MemoryPageInput) => Promise<MemoryPage>,
    private readonly cache: MemoryPageCache = memoryPageCache,
  ) {}
  peek(input: MemoryPageInput): MemoryPage | undefined {
    return this.cache.get(input);
  }
  async open(
    input: MemoryPageInput,
    render: (page: MemoryPage, fromCache: boolean) => void,
  ): Promise<MemoryPage> {
    const cached = this.cache.get(input);
    if (cached) render(cached, true);
    const value = await this.fetch(input);
    this.cache.set(input, value);
    render(value, false);
    return value;
  }
  async prefetch(input: MemoryPageInput): Promise<void> {
    if (this.cache.get(input)) return;
    const value = await this.fetch(input).catch(() => undefined);
    if (value) this.cache.set(input, value);
  }
  async fetch(input: MemoryPageInput): Promise<MemoryPage> {
    const key = this.cache.key(input);
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.load(input);
      this.#inflight.set(key, pending);
      void pending.finally(() => this.#inflight.delete(key)).catch(() => undefined);
    }
    return pending;
  }
}
