import type { DelegationPeerCatalog } from "@codexhost/shared-contracts";

/**
 * Per-Host peer catalogs for the `#` menu. `peers.json` belongs to the Host
 * Runtime of the machine that runs the conversation, so a Mac conversation and
 * an oracle-main conversation see different peer lists; caching them together
 * would show one machine's peers in the other's menu.
 */
export interface DelegationPeerCatalogSourceOptions {
  /** Ask the given Host Runtime for its current peer catalog. */
  load(hostId: string, input: { refresh: boolean }): Promise<DelegationPeerCatalog>;
  /** A catalog replaced what the open menu renders. */
  onUpdate?(): void;
  now?(): number;
  /** A cached catalog older than this is refreshed in the background. */
  revalidateMs?: number;
  /** A failed load is retried after this delay. */
  retryMs?: number;
}

export interface DelegationPeerCatalogSource {
  get(hostId: string): DelegationPeerCatalog | null;
  /** Fetch when missing or stale; concurrent calls for one Host share a request. */
  refresh(hostId: string): void;
  dispose(): void;
}

interface CatalogEntry {
  catalog: DelegationPeerCatalog | null;
  loadedAt: number;
  request: Promise<void> | null;
}

const DEFAULT_REVALIDATE_MS = 60 * 60_000;
const DEFAULT_RETRY_MS = 10_000;

export function createDelegationPeerCatalogSource(
  options: DelegationPeerCatalogSourceOptions,
): DelegationPeerCatalogSource {
  const now = options.now ?? Date.now;
  const revalidateMs = options.revalidateMs ?? DEFAULT_REVALIDATE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const entries = new Map<string, CatalogEntry>();
  let disposed = false;

  const entryFor = (hostId: string): CatalogEntry => {
    const existing = entries.get(hostId);
    if (existing) return existing;
    const entry: CatalogEntry = { catalog: null, loadedAt: 0, request: null };
    entries.set(hostId, entry);
    return entry;
  };

  return {
    get(hostId) {
      return entries.get(hostId)?.catalog ?? null;
    },
    refresh(hostId) {
      if (disposed) return;
      const entry = entryFor(hostId);
      if (entry.request) return;
      if (entry.catalog && now() - entry.loadedAt < revalidateMs) return;
      const revalidate = entry.catalog !== null;
      entry.request = Promise.resolve()
        .then(() => options.load(hostId, { refresh: revalidate }))
        .then((catalog) => {
          if (disposed) return;
          entry.catalog = catalog;
          entry.loadedAt = now();
          options.onUpdate?.();
        })
        .catch(() => {
          // Keep the last catalog; an older Host may not implement the RPC yet.
          entry.loadedAt = now() - revalidateMs + retryMs;
        })
        .finally(() => {
          entry.request = null;
        });
    },
    dispose() {
      disposed = true;
      entries.clear();
    },
  };
}
