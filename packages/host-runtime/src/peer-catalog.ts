import type {
  DelegationPeerCatalog,
  DelegationPeerCatalogEntry,
  DesktopRemoteConnection,
  WebDelegationPeers,
} from "@codexhost/shared-contracts";

import { DelegationControlError, type DelegationThreadSnapshot } from "./delegation-types.js";
import { DesktopProjectCatalogReader } from "./desktop-project-catalog.js";
import { readPeerConfig, resolvePeerTarget, type ResolvedPeer } from "./peer-config.js";
import { requestPeerRoute, type PeerSpawn } from "./peer-transport.js";

const DEFAULT_CATALOG_TIMEOUT_MS = 15_000;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 60 * 60_000;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function webFailure(error: unknown): "timeout" | "failed" {
  if (error instanceof DelegationControlError) {
    const { reason, stderr } = error.details ?? {};
    if (
      reason === "peer_timeout" ||
      /timed?\s*out|timeout|deadline|超时/iu.test(
        typeof stderr === "string" ? stderr : error.message,
      )
    )
      return "timeout";
  }
  return "failed";
}

function displayName(peer: ResolvedPeer, connections: readonly DesktopRemoteConnection[]): string {
  for (const hostId of peer.hostIds) {
    const connection = connections.find((entry) => entry.hostId === hostId);
    if (connection) return connection.displayName;
  }
  return connections.find((entry) => entry.alias === peer.ssh)?.displayName ?? peer.name;
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
  #cache: { loadedAt: number; value: DelegationPeerCatalog } | undefined;
  #inflight: Promise<DelegationPeerCatalog> | undefined;
  #webInflight: Promise<WebDelegationPeers> | undefined;
  #desktopProjects: DesktopProjectCatalogReader | undefined;
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
    if (this.#cache && !input.refresh) {
      const stale = this.#now() - this.#cache.loadedAt >= this.#cacheTtlMs;
      if (stale) {
        // Stale-while-revalidate: the menu gets the cached catalog immediately.
        void this.#refresh(false).catch(() => undefined);
      }
      return this.#cache.value;
    }
    return this.#refresh(input.refresh === true);
  }

  /** Query the peer's availability cache on each menu open. */
  listWebPeers(): Promise<WebDelegationPeers> {
    this.#webInflight ??= this.#loadWebPeers().finally(() => {
      this.#webInflight = undefined;
    });
    return this.#webInflight;
  }

  async #loadWebPeers(): Promise<WebDelegationPeers> {
    const peers = await this.#configuredPeers();
    if (peers.targets.length === 0) return { peers: [] };
    this.#desktopProjects ??= new DesktopProjectCatalogReader({ environment: this.#environment });
    const connections = await this.#desktopProjects.read().then(
      (catalog) => catalog.codexManagedRemoteConnections,
      () => [],
    );
    return {
      peers: await Promise.all(
        peers.targets.map(async (peer) => {
          const identity = { name: peer.name, label: displayName(peer, connections) };
          try {
            const { ready } = await this.#listPeerHarnesses(peer, false);
            if (!ready) return { ...identity, status: "failed" as const };
            return {
              ...identity,
              status: "ready" as const,
              harnesses: [...new Set(ready)].filter((harnessId) =>
                /^[a-z0-9][a-z0-9-]*$/u.test(harnessId),
              ),
            };
          } catch (error) {
            return { ...identity, status: webFailure(error) };
          }
        }),
      ),
    };
  }

  #refresh(refresh: boolean): Promise<DelegationPeerCatalog> {
    if (this.#inflight) {
      if (!refresh) return this.#inflight;
      // A manual refresh must not reuse an answer that started before it.
      const pending = this.#inflight;
      return pending.catch(() => undefined).then(() => this.#refresh(true));
    }
    const request = this.#load(refresh).finally(() => {
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

  async #configuredPeers() {
    const config = await readPeerConfig(this.#environment);
    const targets = Object.entries(config.peers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]): ResolvedPeer => ({
        name,
        ...entry,
        linkHostId: entry.hostIds[0] ?? name,
      }));
    return { targets, self: config.self };
  }

  async #listPeerHarnesses(peer: ResolvedPeer, refresh: boolean) {
    const result = await requestPeerRoute({
      environment: this.#environment,
      peer,
      route: "/v1/harness/list",
      body: { includeAvailability: true, ...(refresh ? { refresh: true } : {}) },
      timeoutMs: this.#catalogTimeoutMs,
      ...(this.#spawnImpl ? { spawnImpl: this.#spawnImpl } : {}),
    });
    const listed = Array.isArray(result.harnesses)
      ? result.harnesses.filter((value): value is string => typeof value === "string")
      : [];
    const availability = isRecord(result.availability) ? result.availability : undefined;
    return { listed, ready: availability && listed.filter((id) => availability[id] === "ready") };
  }

  async #load(refresh: boolean): Promise<DelegationPeerCatalog> {
    const { targets, self } = await this.#configuredPeers();
    const peers = await Promise.all(
      targets.map(async (peer): Promise<DelegationPeerCatalogEntry> => {
        const { name, hostIds, ssh } = peer;
        try {
          const { listed, ready } = await this.#listPeerHarnesses(peer, refresh);
          const harnesses = ready ?? listed;
          this.#harnessCache.set(name, harnesses);
          return {
            name,
            hostIds,
            ssh,
            state: "ready",
            harnesses,
          };
        } catch (error) {
          return {
            name,
            hostIds,
            ssh,
            state: "unreachable",
            harnesses: this.#harnessCache.get(name) ?? [],
            error: errorText(error),
          };
        }
      }),
    );
    const value: DelegationPeerCatalog = {
      peers,
      ...(self ? { self: { hostIds: self.hostIds } } : {}),
    };
    this.#cache = { loadedAt: this.#now(), value };
    return value;
  }
}
