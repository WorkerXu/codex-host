import type {
  DelegationPeerCatalog,
  DelegationPeerCatalogEntry,
} from "@codexhost/shared-contracts";

import { DelegationControlError, type DelegationThreadSnapshot } from "./delegation-types.js";
import { readPeerConfig, resolvePeerTarget } from "./peer-config.js";
import { requestPeerRoute, type PeerSpawn } from "./peer-transport.js";

const DEFAULT_CATALOG_TIMEOUT_MS = 8_000;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 30_000;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
}

/**
 * Peer names, Host IDs and live Harness catalogs for the `#` picker. The
 * Host Runtime owns peers.json and the SSH transport, so the Renderer never
 * parses CLI configuration or opens an SSH connection itself.
 */
export class DelegationPeerCatalogService {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #catalogTimeoutMs: number;
  readonly #readTimeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  readonly #spawnImpl: PeerSpawn | undefined;
  #cache: { expiresAt: number; value: DelegationPeerCatalog } | undefined;
  #inflight: Promise<DelegationPeerCatalog> | undefined;
  /** Last successful Harness list, so an offline machine keeps greyed-out rows. */
  readonly #harnessCache = new Map<string, string[]>();

  constructor(
    environment: NodeJS.ProcessEnv,
    options: {
      catalogTimeoutMs?: number;
      readTimeoutMs?: number;
      cacheTtlMs?: number;
      now?: () => number;
      spawnImpl?: PeerSpawn;
    } = {},
  ) {
    this.#environment = environment;
    this.#catalogTimeoutMs = options.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
    this.#readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#spawnImpl = options.spawnImpl;
  }

  async listPeers(input: { refresh?: boolean | undefined } = {}): Promise<DelegationPeerCatalog> {
    const now = this.#now();
    if (!input.refresh && this.#cache && now < this.#cache.expiresAt) return this.#cache.value;
    if (this.#inflight) return this.#inflight;
    const request = this.#load().finally(() => {
      if (this.#inflight === request) this.#inflight = undefined;
    });
    this.#inflight = request;
    return request;
  }

  /** Read one remote Thread for a cross-host watch on this Runtime. */
  async readThread(input: { hostId: string; threadId: string }): Promise<DelegationThreadSnapshot> {
    if (typeof input.hostId !== "string" || !input.hostId.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Host identifier is required");
    }
    if (typeof input.threadId !== "string" || !input.threadId.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
    }
    const target = resolvePeerTarget(await readPeerConfig(this.#environment), input.hostId);
    if (!target || target === "local") {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `Host '${input.hostId}' is not a configured peer`,
      );
    }
    const result = await requestPeerRoute({
      environment: this.#environment,
      peer: target,
      route: "/v1/thread/read",
      body: { threadId: input.threadId, view: "result" },
      timeoutMs: this.#readTimeoutMs,
      ...(this.#spawnImpl ? { spawnImpl: this.#spawnImpl } : {}),
    });
    if (typeof result.threadId !== "string" || typeof result.status !== "string") {
      throw new DelegationControlError(
        "INTERNAL_ERROR",
        "Peer returned an invalid Thread snapshot",
      );
    }
    return result as unknown as DelegationThreadSnapshot;
  }

  async #load(): Promise<DelegationPeerCatalog> {
    const config = await readPeerConfig(this.#environment);
    const peers = await Promise.all(
      Object.entries(config.peers)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(async ([name, entry]): Promise<DelegationPeerCatalogEntry> => {
          try {
            const result = await requestPeerRoute({
              environment: this.#environment,
              peer: { name, ...entry, linkHostId: entry.hostIds[0] ?? name },
              route: "/v1/harness/list",
              body: {},
              timeoutMs: this.#catalogTimeoutMs,
              ...(this.#spawnImpl ? { spawnImpl: this.#spawnImpl } : {}),
            });
            const harnesses = Array.isArray(result.harnesses)
              ? result.harnesses.filter((value): value is string => typeof value === "string")
              : [];
            this.#harnessCache.set(name, harnesses);
            return {
              name,
              hostIds: entry.hostIds,
              state: "ready",
              harnesses,
            };
          } catch (error) {
            return {
              name,
              hostIds: entry.hostIds,
              state: "unreachable",
              harnesses: this.#harnessCache.get(name) ?? [],
              error: errorText(error),
            };
          }
        }),
    );
    const value: DelegationPeerCatalog = {
      peers,
      ...(config.self ? { self: { hostIds: config.self.hostIds } } : {}),
    };
    this.#cache = { expiresAt: this.#now() + this.#cacheTtlMs, value };
    return value;
  }
}
