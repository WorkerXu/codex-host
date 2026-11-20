import {
  accountCreditsSnapshotSchema,
  codexAccountListResultSchema,
  harnessAccountListResultSchema,
  type AccountCreditsSnapshot,
  type CodexAccountListResult,
  type HarnessAccountListResult,
} from "@codexhost/shared-contracts";

import { rendererNewThreadPreferenceStorage } from "../renderer-new-thread-preference.js";

const KEY = "codexhost.accounts.presentation.v1";
const MAX_HARNESS_ACCOUNTS = 32;
const MAX_CODEX_ACCOUNTS = 16;
const MAX_USAGE_ENTRIES = 32;
const MAX_SERIALIZED_CHARS = 256 * 1024;

export interface CachedUsageEntry {
  credits: AccountCreditsSnapshot;
  observedAt: string | null;
}

export interface CachedAccountPresentation {
  codex: CodexAccountListResult | null;
  harness: { accounts: HarnessAccountListResult["accounts"]; observedAt: number } | null;
  usage: Record<string, CachedUsageEntry>;
}

function empty(): CachedAccountPresentation {
  return { codex: null, harness: null, usage: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The last account/quota picture per Host. Account rows and quotas change slowly
 * but live fetches can take seconds; this lets the page paint and then update in
 * place. Display data only, never DingTalk content.
 */
export function readCachedAccountPresentation(hostId: string): CachedAccountPresentation {
  try {
    const raw = rendererNewThreadPreferenceStorage(hostId)?.getItem(KEY);
    if (!raw) return empty();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return empty();

    const codex = codexAccountListResultSchema.safeParse(parsed.codex);
    const harness = isRecord(parsed.harness)
      ? harnessAccountListResultSchema.safeParse({ accounts: parsed.harness.accounts })
      : null;
    const harnessData = harness?.success ? harness.data : null;
    const observedAt =
      isRecord(parsed.harness) && typeof parsed.harness.observedAt === "number"
        ? parsed.harness.observedAt
        : null;
    const usage: Record<string, CachedUsageEntry> = {};
    if (isRecord(parsed.usage)) {
      for (const [id, entry] of Object.entries(parsed.usage)) {
        if (!isRecord(entry)) continue;
        const credits = accountCreditsSnapshotSchema.safeParse(entry.credits);
        if (!credits.success) continue;
        usage[id] = {
          credits: credits.data,
          observedAt: typeof entry.observedAt === "string" ? entry.observedAt : null,
        };
      }
    }
    return {
      codex: codex.success ? codex.data : null,
      harness:
        harnessData && observedAt !== null ? { accounts: harnessData.accounts, observedAt } : null,
      usage,
    };
  } catch {
    return empty();
  }
}

export function writeCachedAccountPresentation(
  hostId: string,
  value: CachedAccountPresentation,
): void {
  try {
    const codex = value.codex
      ? {
          ...value.codex,
          accounts: value.codex.accounts.slice(0, MAX_CODEX_ACCOUNTS),
        }
      : null;
    const harness = value.harness
      ? {
          observedAt: value.harness.observedAt,
          accounts: value.harness.accounts.slice(0, MAX_HARNESS_ACCOUNTS),
        }
      : null;
    const usage = Object.fromEntries(Object.entries(value.usage).slice(0, MAX_USAGE_ENTRIES));
    const serialized = JSON.stringify({ version: 1, codex, harness, usage });
    if (serialized.length > MAX_SERIALIZED_CHARS) return;
    rendererNewThreadPreferenceStorage(hostId)?.setItem(KEY, serialized);
  } catch {
    /* Storage is a convenience; uncached account data still loads live. */
  }
}
