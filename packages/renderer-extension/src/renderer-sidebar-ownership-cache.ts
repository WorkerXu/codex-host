import { harnessIdSchema } from "@codexhost/shared-contracts";

import { rendererPresentationStorage } from "./renderer-presentation-storage.js";

const KEY = "codexhost.sidebar-ownership.v1";
/** Enough for a long sidebar history without letting the file grow without bound. */
const MAX_THREADS = 400;

export interface SidebarOwnershipStore {
  read(hostId: string): ReadonlyMap<string, string>;
  write(hostId: string, entries: Iterable<readonly [string, string]>): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntries(value: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  if (!Array.isArray(value)) return entries;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [threadId, agent] = entry as [unknown, unknown];
    if (typeof threadId !== "string" || threadId.length === 0) continue;
    if (typeof agent !== "string" || !harnessIdSchema.safeParse(agent).success) continue;
    entries.set(threadId, agent);
  }
  return entries;
}

/**
 * Thread → Harness ownership per Host, so sidebar rows can show their icon as soon as
 * they appear. Fresh ownership replies replace entries; nothing else is stored.
 */
export function createSidebarOwnershipStore(): SidebarOwnershipStore {
  const byHost = new Map<string, Map<string, string>>();

  const hostEntries = (hostId: string): Map<string, string> => {
    const existing = byHost.get(hostId);
    if (existing) return existing;
    let loaded = new Map<string, string>();
    try {
      const raw = rendererPresentationStorage(hostId)?.getItem(KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed) && parsed.version === 1) loaded = parseEntries(parsed.threads);
      }
    } catch {
      /* A corrupt cache only costs one ownership round trip. */
    }
    byHost.set(hostId, loaded);
    return loaded;
  };

  return {
    read(hostId) {
      return new Map(hostEntries(hostId));
    },
    write(hostId, entries) {
      const current = hostEntries(hostId);
      let changed = false;
      for (const [threadId, agent] of entries) {
        if (threadId.length === 0) continue;
        if (current.get(threadId) === agent) continue;
        // Re-insert so the newest ownership survives the cap.
        current.delete(threadId);
        current.set(threadId, agent);
        changed = true;
      }
      if (!changed) return;
      while (current.size > MAX_THREADS) {
        const oldest = current.keys().next().value;
        if (oldest === undefined) break;
        current.delete(oldest);
      }
      try {
        rendererPresentationStorage(hostId)?.setItem(
          KEY,
          JSON.stringify({ version: 1, threads: [...current] }),
        );
      } catch {
        /* Storage is a convenience; the in-memory map still serves this session. */
      }
    },
  };
}
