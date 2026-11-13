import type {
  JarvisCandidate,
  JarvisCandidatesResult,
  JarvisKind,
  JarvisUser,
} from "@codexhost/shared-contracts";

import { candidateFromJarvisRow, type JarvisCli } from "./jarvis-cli.js";

export const JARVIS_CANDIDATE_TTL_MS = 5 * 60_000;
const PROJECT_FETCH_CONCURRENCY = 4;
const MAX_CANDIDATES_PER_KIND = 1_000;

interface CacheEntry {
  candidates: JarvisCandidate[];
  user: JarvisUser | null;
  fetchedAt: number;
}

export interface JarvisCandidatePoolOptions {
  cli: Pick<JarvisCli, "user" | "projects" | "bugs" | "requirements" | "tasks">;
  ttlMs?: number;
  now?: () => number;
  concurrency?: number;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  });
  await Promise.all(workers);
  return results;
}

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupe(candidates: readonly JarvisCandidate[]): JarvisCandidate[] {
  const seen = new Set<string>();
  const unique: JarvisCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.projectId ?? ""}:${candidate.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))
    .slice(0, MAX_CANDIDATES_PER_KIND);
}

/**
 * Jarvis data is fetched in the background per Host and reused across queries.
 * Everything is derived from the CLI's own "my items" scopes; the pool never
 * searches arbitrary Jarvis projects.
 */
export class JarvisCandidatePool {
  readonly #cli: JarvisCandidatePoolOptions["cli"];
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #concurrency: number;
  readonly #cache = new Map<JarvisKind, CacheEntry>();
  readonly #inflight = new Map<JarvisKind, Promise<CacheEntry>>();

  constructor(options: JarvisCandidatePoolOptions) {
    this.#cli = options.cli;
    this.#ttlMs = options.ttlMs ?? JARVIS_CANDIDATE_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#concurrency = options.concurrency ?? PROJECT_FETCH_CONCURRENCY;
  }

  invalidate(): void {
    this.#cache.clear();
  }

  async get(
    kind: JarvisKind,
    options: { refresh?: boolean } = {},
  ): Promise<JarvisCandidatesResult> {
    const cached = this.#cache.get(kind);
    if (!options.refresh && cached && this.#now() - cached.fetchedAt < this.#ttlMs) {
      return resultOf(cached);
    }
    const pending = this.#inflight.get(kind);
    if (pending) return resultOf(await pending);
    const request = this.#refresh(kind)
      .then((entry) => {
        if (entry.user) this.#cache.set(kind, entry);
        else if (cached) return cached;
        else this.#cache.set(kind, entry);
        return entry;
      })
      .finally(() => {
        this.#inflight.delete(kind);
      });
    this.#inflight.set(kind, request);
    return resultOf(await request);
  }

  async #refresh(kind: JarvisKind): Promise<CacheEntry> {
    const user = await this.#cli.user();
    if (!user) return { candidates: [], user: null, fetchedAt: this.#now() };
    const projectRows = await this.#cli.projects();
    const projects = new Map<number, string>();
    for (const row of projectRows) {
      if (typeof row.id === "number" && typeof row.name === "string") {
        projects.set(row.id, row.name);
      }
    }
    const candidates =
      kind === "project"
        ? dedupe(
            projectRows.flatMap((row) => {
              const candidate = candidateFromJarvisRow("project", row, projects);
              return candidate ? [candidate] : [];
            }),
          )
        : kind === "bug"
          ? await this.#bugs(projects)
          : kind === "requirement"
            ? dedupe(
                (await this.#cli.requirements(user.id)).flatMap((row) => {
                  const candidate = candidateFromJarvisRow("requirement", row, projects);
                  return candidate ? [candidate] : [];
                }),
              )
            : dedupe(
                (await this.#cli.tasks(user.id)).flatMap((row) => {
                  const candidate = candidateFromJarvisRow("task", row, projects);
                  return candidate ? [candidate] : [];
                }),
              );
    return { candidates, user, fetchedAt: this.#now() };
  }

  async #bugs(projects: ReadonlyMap<number, string>): Promise<JarvisCandidate[]> {
    const rows = await mapWithConcurrency(
      [...projects.keys()],
      this.#concurrency,
      async (projectId) => {
        const [assigned, created] = await Promise.all([
          this.#cli.bugs(projectId).catch(() => []),
          this.#cli.bugs(projectId, { createdByMe: true }).catch(() => []),
        ]);
        return [...assigned, ...created];
      },
    );
    return dedupe(
      rows.flat().flatMap((row) => {
        const candidate = candidateFromJarvisRow("bug", row, projects);
        return candidate ? [candidate] : [];
      }),
    );
  }
}

function resultOf(entry: CacheEntry): JarvisCandidatesResult {
  return {
    available: entry.user !== null,
    candidates: entry.candidates,
    user: entry.user,
    fetchedAt: entry.user ? new Date(entry.fetchedAt).toISOString() : null,
  };
}
