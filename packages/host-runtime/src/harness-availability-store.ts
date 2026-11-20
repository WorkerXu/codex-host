import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HarnessInspection } from "@codexhost/harness-adapter";

import { codexhostUserDirectory, isUnisolatedTestUserDirectory } from "./runtime-control-file.js";

const FORMAT_VERSION = 1;
const CACHE_DIRECTORY = "cache";
const CACHE_FILE = "harness-availability.json";

/** A ready Harness stays valid for a day; its catalog follows upstream releases separately. */
export const READY_AVAILABILITY_TTL_MS = 24 * 60 * 60_000;
/** A missing CLI usually means the user has not installed it yet; the plugin fingerprint
 * still invalidates this entry when the plugin itself changes. */
export const NOT_INSTALLED_AVAILABILITY_TTL_MS = 24 * 60 * 60_000;
/** A transient failure must not hide a working Harness for a day. */
export const FAILURE_AVAILABILITY_TTL_MS = 10 * 60_000;

export function harnessAvailabilityTtlMs(status: HarnessInspection["status"]): number {
  if (status === "ready") return READY_AVAILABILITY_TTL_MS;
  if (status === "notInstalled") return NOT_INSTALLED_AVAILABILITY_TTL_MS;
  return FAILURE_AVAILABILITY_TTL_MS;
}

const STATUSES: ReadonlySet<string> = new Set(["ready", "notInstalled", "unavailable", "error"]);

export interface HarnessAvailabilityEntry {
  status: HarnessInspection["status"];
  /** Epoch milliseconds of the last successful inspection. */
  checkedAt: number;
  /** Plugin version/directory fingerprint used to invalidate after upgrades. */
  fingerprint?: string;
}

interface StoredAvailabilityFile {
  formatVersion: 1;
  /** Increments whenever an availability entry is written or invalidated. */
  generation?: number;
  entries: Record<string, unknown>;
}

function parseEntry(value: unknown): HarnessAvailabilityEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) return undefined;
  if (typeof raw.checkedAt !== "number" || !Number.isFinite(raw.checkedAt)) return undefined;
  return {
    status: raw.status as HarnessInspection["status"],
    checkedAt: raw.checkedAt,
    ...(typeof raw.fingerprint === "string" ? { fingerprint: raw.fingerprint } : {}),
  };
}

/** Persistent, best-effort availability cache; a write failure never blocks delegation. */
export class HarnessAvailabilityStore {
  readonly filePath: string | undefined;
  readonly #entries = new Map<string, HarnessAvailabilityEntry>();
  #loaded: Promise<void> | undefined;
  #writeChain: Promise<void> = Promise.resolve();
  #generation = 0;

  constructor(environment: NodeJS.ProcessEnv) {
    this.filePath = isUnisolatedTestUserDirectory(environment)
      ? undefined
      : path.join(codexhostUserDirectory(environment), CACHE_DIRECTORY, CACHE_FILE);
  }

  async get(harnessId: string): Promise<HarnessAvailabilityEntry | undefined> {
    await this.#ensureLoaded();
    return this.#entries.get(harnessId);
  }
  /** Every Harness the Host has actually seen installed, even if currently unavailable. */
  async availableHarnessIds(): Promise<ReadonlySet<string>> {
    await this.#ensureLoaded();
    return new Set(
      [...this.#entries].filter(([, entry]) => entry.status !== "notInstalled").map(([id]) => id),
    );
  }

  async set(harnessId: string, entry: HarnessAvailabilityEntry): Promise<void> {
    await this.#ensureLoaded();
    // Two paths inspect the same Harness (interactive and background). The later
    // observation wins even if the earlier one finishes last.
    const existing = this.#entries.get(harnessId);
    if (existing && existing.checkedAt > entry.checkedAt) return;
    // Generation keys the directory fingerprint, so a repeated observation of
    // the same status/fingerprint must not invalidate every Renderer's cache.
    const changed =
      !existing || existing.status !== entry.status || existing.fingerprint !== entry.fingerprint;
    this.#entries.set(harnessId, entry);
    if (changed) this.#generation += 1;
    await this.#persist();
  }

  async invalidate(harnessId: string): Promise<void> {
    await this.#ensureLoaded();
    if (this.#entries.delete(harnessId)) {
      this.#generation += 1;
      await this.#persist();
    }
  }

  /** Monotonic per-file generation: an availability change or refresh changes it. */
  async generation(): Promise<number> {
    await this.#ensureLoaded();
    return this.#generation;
  }

  async #ensureLoaded(): Promise<void> {
    this.#loaded ??= this.#load().catch(() => undefined);
    return this.#loaded;
  }

  async #load(): Promise<void> {
    if (!this.filePath) return;
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const file = parsed as Partial<StoredAvailabilityFile>;
    if (file.formatVersion !== FORMAT_VERSION) return;
    if (typeof file.generation === "number" && Number.isFinite(file.generation)) {
      this.#generation = Math.max(0, Math.trunc(file.generation));
    }
    if (typeof file.entries !== "object" || file.entries === null) return;
    for (const [harnessId, value] of Object.entries(file.entries)) {
      const entry = parseEntry(value);
      if (entry) this.#entries.set(harnessId, entry);
    }
  }

  #persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    const filePath = this.filePath;
    const body = `${JSON.stringify(
      {
        formatVersion: FORMAT_VERSION,
        generation: this.#generation,
        entries: Object.fromEntries(this.#entries),
      } satisfies StoredAvailabilityFile,
      null,
      2,
    )}\n`;
    this.#writeChain = this.#writeChain
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, body, { mode: 0o600 });
          await rename(temporary, filePath);
          await chmod(filePath, 0o600).catch(() => undefined);
        } catch {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return this.#writeChain;
  }
}
