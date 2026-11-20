import {
  harnessInstallationStateSchema,
  type HarnessInstallationState,
} from "@codexhost/shared-contracts";

import { rendererPresentationStorage } from "../renderer-presentation-storage.js";

const KEY = "codexhost.connection.versions.v1";
const MAX_ENTRIES = 32;
const MAX_SERIALIZED_CHARS = 64 * 1024;
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

interface StoredVersion {
  checkedAt: number;
  state: HarnessInstallationState;
}

interface StoredFile {
  version: 1;
  entries: Record<string, StoredVersion>;
}

export interface CachedHarnessVersion {
  state: HarnessInstallationState;
  checkedAt: number;
  fresh: boolean;
}

function read(hostId: string): StoredFile {
  try {
    const parsed: unknown = JSON.parse(rendererPresentationStorage(hostId)?.getItem(KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { version: 1, entries: {} };
    }
    const file = parsed as Partial<StoredFile>;
    if (file.version !== 1 || typeof file.entries !== "object" || file.entries === null) {
      return { version: 1, entries: {} };
    }
    return { version: 1, entries: file.entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

/**
 * Version lookups are CLI round trips that change only on a Harness release.
 * Keep the last answer for several hours; a manual update still replaces it.
 */
export function readCachedHarnessVersion(
  hostId: string,
  agent: string,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
): CachedHarnessVersion | undefined {
  const entry = read(hostId).entries[agent];
  if (!entry || typeof entry.checkedAt !== "number") return undefined;
  const state = harnessInstallationStateSchema.safeParse(entry.state);
  if (!state.success) return undefined;
  return {
    state: state.data,
    checkedAt: entry.checkedAt,
    fresh: now - entry.checkedAt < ttlMs,
  };
}

export function writeCachedHarnessVersion(
  hostId: string,
  agent: string,
  state: HarnessInstallationState,
  now = Date.now(),
): void {
  try {
    const file = read(hostId);
    const entries = Object.entries(file.entries)
      .filter(([id, entry]) => id !== agent && typeof entry?.checkedAt === "number")
      .sort(([, left], [, right]) => right.checkedAt - left.checkedAt)
      .slice(0, MAX_ENTRIES - 1);
    const next: StoredFile = {
      version: 1,
      entries: Object.fromEntries([[agent, { checkedAt: now, state }], ...entries]),
    };
    const serialized = JSON.stringify(next);
    if (serialized.length > MAX_SERIALIZED_CHARS) return;
    rendererPresentationStorage(hostId)?.setItem(KEY, serialized);
  } catch {
    /* Storage is a convenience; an absent cache only costs one CLI check. */
  }
}
