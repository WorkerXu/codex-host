import {
  catalogModelForRef,
  harnessIdSchema,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

import { rendererNewThreadPreferenceStorage } from "./renderer-new-thread-preference.js";

const KEY = "codexhost.thread-presentation.v1";
/** Recent Threads are enough to cover the sidebar and the Thread a user reopens. */
const MAX_THREADS = 64;

/**
 * The last footer presentation a Thread displayed: which Harness owned it and which
 * Model and Thinking the Composer named. It lets a cold start paint the footer before
 * the Host answers, and is replaced by the next fresh inspection.
 */
export interface CachedThreadPresentation {
  agent: string;
  model: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  resolvedModelLabel?: string;
  /** Compact Catalog holding just the selected Model, enough to name it. */
  catalog: HarnessModelCatalog;
}

interface StoredThreadPresentation extends CachedThreadPresentation {
  threadId: string;
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredThread(value: unknown): StoredThreadPresentation | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.threadId !== "string" || value.threadId.length === 0) return undefined;
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined;
  const agent = harnessIdSchema.safeParse(value.agent);
  const model = harnessModelRefSchema.safeParse(value.model);
  const catalog = harnessModelCatalogSchema.safeParse(value.catalog);
  const thinkingOptionId =
    value.thinkingOptionId === undefined
      ? undefined
      : harnessThinkingOptionIdSchema.safeParse(value.thinkingOptionId);
  if (!agent.success || !model.success || !catalog.success) return undefined;
  if (thinkingOptionId !== undefined && !thinkingOptionId.success) return undefined;
  if (!catalogModelForRef(catalog.data, model.data)) return undefined;
  const resolvedModelLabel =
    typeof value.resolvedModelLabel === "string" && value.resolvedModelLabel.length > 0
      ? value.resolvedModelLabel
      : undefined;
  return {
    threadId: value.threadId,
    at: value.at,
    agent: agent.data,
    model: model.data,
    ...(thinkingOptionId?.success ? { thinkingOptionId: thinkingOptionId.data } : {}),
    ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
    catalog: catalog.data,
  };
}

function readStoredThreads(hostId: string): StoredThreadPresentation[] {
  try {
    const raw = rendererNewThreadPreferenceStorage(hostId)?.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.threads)) return [];
    return parsed.threads
      .map(parseStoredThread)
      .filter((entry): entry is StoredThreadPresentation => entry !== undefined);
  } catch {
    return [];
  }
}

export function readCachedThreadPresentation(
  hostId: string,
  threadId: string,
): CachedThreadPresentation | undefined {
  const stored = readStoredThreads(hostId).find((entry) => entry.threadId === threadId);
  if (!stored) return undefined;
  return {
    agent: stored.agent,
    model: stored.model,
    ...(stored.thinkingOptionId ? { thinkingOptionId: stored.thinkingOptionId } : {}),
    ...(stored.resolvedModelLabel ? { resolvedModelLabel: stored.resolvedModelLabel } : {}),
    catalog: stored.catalog,
  };
}

export function writeCachedThreadPresentation(
  hostId: string,
  threadId: string,
  presentation: CachedThreadPresentation,
): void {
  try {
    if (threadId.length === 0) return;
    const compact = compactModelCatalog(
      presentation.catalog,
      presentation.model,
      presentation.thinkingOptionId,
    );
    if (!compact) return;
    const threads = readStoredThreads(hostId).filter((entry) => entry.threadId !== threadId);
    threads.push({
      threadId,
      at: Date.now(),
      agent: presentation.agent,
      model: presentation.model,
      ...(presentation.thinkingOptionId ? { thinkingOptionId: presentation.thinkingOptionId } : {}),
      ...(presentation.resolvedModelLabel
        ? { resolvedModelLabel: presentation.resolvedModelLabel }
        : {}),
      catalog: compact,
    });
    const bounded = threads.slice(-MAX_THREADS);
    rendererNewThreadPreferenceStorage(hostId)?.setItem(
      KEY,
      JSON.stringify({ version: 1, threads: bounded }),
    );
  } catch {
    /* Storage is a convenience; a missing cache only shows the loading state. */
  }
}

/**
 * Keep only what the footer needs to name the Thread's Model. The full Catalog is
 * already cached per Harness; copying it per Thread would multiply storage by the
 * number of open Threads for no visible gain.
 */
export function compactModelCatalog(
  catalog: HarnessModelCatalog,
  model: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
): HarnessModelCatalog | undefined {
  const entry = catalogModelForRef(catalog, model);
  if (!entry) return undefined;
  const supported = entry.supportedThinkingOptionIds;
  const thinkingOptionIds =
    thinkingOptionId !== undefined && !supported?.includes(thinkingOptionId)
      ? [...(supported ?? []), thinkingOptionId]
      : supported;
  const thinkingOptions = catalog.thinkingOptions.filter((option) =>
    thinkingOptionIds
      ? thinkingOptionIds.includes(option.id)
      : thinkingOptionId !== undefined && option.id === thinkingOptionId,
  );
  return {
    models: [
      { ...entry, ...(thinkingOptionIds ? { supportedThinkingOptionIds: thinkingOptionIds } : {}) },
    ],
    defaultModel: entry.ref,
    thinkingOptions,
  };
}
