import type { HarnessAdapter, HarnessInspection } from "@codexhost/harness-adapter";
import type { ExternalHarnessId } from "@codexhost/protocol-core";

import {
  HarnessAvailabilityStore,
  harnessAvailabilityTtlMs,
} from "./harness-availability-store.js";
import { harnessPluginFingerprints } from "./harness-plugin-fingerprint.js";

type Status = HarnessInspection["status"];
const INSPECT_TIMEOUT_MS = 8_000;

const stores = new Map<string, HarnessAvailabilityStore>();

/** The Desktop sessions and delegation endpoint of one process share observations. */
export class HarnessAvailability {
  readonly #store: HarnessAvailabilityStore;
  readonly #roots: readonly string[];
  readonly #inflight = new Map<string, Promise<Status>>();

  constructor(environment: NodeJS.ProcessEnv, roots: readonly string[]) {
    const store = new HarnessAvailabilityStore(environment);
    this.#store = (store.filePath && stores.get(store.filePath)) || store;
    if (store.filePath) stores.set(store.filePath, this.#store);
    this.#roots = roots;
  }

  async list(
    adapters: ReadonlyMap<ExternalHarnessId, HarnessAdapter>,
    refresh: boolean,
  ): Promise<Record<string, Status>> {
    const fingerprints = await harnessPluginFingerprints(this.#roots).catch(() => new Map());
    const entries = await Promise.all(
      [...adapters].map(async ([id, adapter]) => {
        const fingerprint = fingerprints.get(id);
        return [id, await this.#status(id, adapter, fingerprint, refresh)] as const;
      }),
    );
    return { codex: "ready", ...Object.fromEntries(entries) };
  }

  async cached(ids: Iterable<string>): Promise<Record<string, Status>> {
    const fingerprints = await harnessPluginFingerprints(this.#roots).catch(() => new Map());
    const cached = await Promise.all(
      [...ids].map(async (id) => {
        const entry = await this.#store.get(id);
        return entry?.fingerprint === fingerprints.get(id) &&
          entry &&
          Date.now() - entry.checkedAt < harnessAvailabilityTtlMs(entry.status)
          ? ([id, entry.status] as const)
          : undefined;
      }),
    );
    return Object.fromEntries(cached.filter((entry) => entry !== undefined));
  }

  async record(id: string, status: Status, checkedAt: number): Promise<void> {
    const fingerprints = await harnessPluginFingerprints(this.#roots).catch(() => new Map());
    const fingerprint = fingerprints.get(id);
    await this.#store.set(id, { status, checkedAt, ...(fingerprint ? { fingerprint } : {}) });
  }

  invalidate(id: string): Promise<void> {
    return this.#store.invalidate(id);
  }

  async #status(
    id: string,
    adapter: HarnessAdapter,
    fingerprint: string | undefined,
    refresh: boolean,
  ): Promise<Status> {
    if (!refresh) {
      const cached = await this.#store.get(id);
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        Date.now() - cached.checkedAt < harnessAvailabilityTtlMs(cached.status)
      )
        return cached.status;
    }
    const key = JSON.stringify([id, fingerprint, refresh]);
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const checkedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const pending = Promise.race([
      Promise.resolve()
        .then(() => adapter.inspect({ purpose: "availability", refresh }))
        .then(
          (inspection) => inspection.status,
          (): Status => "error",
        ),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), INSPECT_TIMEOUT_MS);
        timer.unref();
      }),
    ])
      .then(async (status): Promise<Status> => {
        if (status === undefined) return "unavailable";
        await this.#store.set(id, { status, checkedAt, ...(fingerprint ? { fingerprint } : {}) });
        return status;
      })
      .finally(() => {
        clearTimeout(timer);
        this.#inflight.delete(key);
      });
    this.#inflight.set(key, pending);
    return pending;
  }
}
