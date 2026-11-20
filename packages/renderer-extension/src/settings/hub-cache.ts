export interface HubCacheView<T> {
  value: T;
  updatedAt: number;
}
const views = new Map<string, HubCacheView<unknown>>();

/** Last successful page payload; lets a reopened page paint before India answers. */
export function readHubCache<T>(key: string): HubCacheView<T> | null {
  return (views.get(key) as HubCacheView<T> | undefined) ?? null;
}
export function writeHubCache<T>(key: string, value: T, updatedAt = Date.now()): void {
  views.set(key, { value, updatedAt });
}
export function clearHubCaches(): void {
  views.clear();
}
export function hubAgeLabel(updatedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** Paint the cached view synchronously, then replace it with a background refresh. */
export class HubCacheController<T> {
  constructor(
    private readonly key: string,
    private readonly load: () => Promise<T>,
    private readonly render: (view: HubCacheView<T>) => void,
    private readonly now: () => number = Date.now,
  ) {}
  mount(): void {
    const view = readHubCache<T>(this.key);
    if (view) this.render(view);
    void this.refresh().catch(() => undefined);
  }
  async refresh(): Promise<T> {
    const value = await this.load();
    const updatedAt = this.now();
    writeHubCache(this.key, value, updatedAt);
    this.render({ value, updatedAt });
    return value;
  }
  peek(): HubCacheView<T> | null {
    return readHubCache<T>(this.key);
  }
}
