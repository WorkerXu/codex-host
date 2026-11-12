import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  desktopProjectsCatalogSchema,
  type DesktopLocalProject,
  type DesktopProjectsCatalog,
  type DesktopRemoteConnection,
  type DesktopRemoteProject,
  type ThreadProjectAssignment,
} from "@codexhost/shared-contracts";

export class DesktopProjectCatalogError extends Error {
  constructor(
    readonly code: "UNAVAILABLE" | "INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesktopProjectCatalogError";
  }
}

export interface DesktopProjectCatalogReaderOptions {
  environment?: NodeJS.ProcessEnv;
  codexHome?: string;
  now?: () => Date;
  cacheTtlMs?: number;
  retryDelayMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 1_000;
const DEFAULT_RETRY_DELAY_MS = 25;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function localProject(id: string, value: unknown): DesktopLocalProject | null {
  const entry = record(value);
  if (!entry) return null;
  const name = string(entry.name) ?? id;
  return { id: string(entry.id) ?? id, name, rootPaths: strings(entry.rootPaths) };
}

function remoteProject(value: unknown): DesktopRemoteProject | null {
  const entry = record(value);
  if (!entry) return null;
  const id = string(entry.id);
  const hostId = string(entry.hostId);
  const remotePath = string(entry.remotePath);
  const label = string(entry.label);
  return id && hostId && remotePath && label ? { id, hostId, remotePath, label } : null;
}

function assignment(value: unknown): ThreadProjectAssignment | null {
  const entry = record(value);
  if (!entry) return null;
  const kind =
    entry.projectKind === "local" || entry.projectKind === "remote" ? entry.projectKind : null;
  const projectId = string(entry.projectId);
  return kind && projectId ? { projectKind: kind, projectId } : null;
}

function connection(value: unknown): DesktopRemoteConnection | null {
  const entry = record(value);
  if (!entry) return null;
  const hostId = string(entry.hostId);
  const displayName = string(entry.displayName);
  const source = string(entry.source);
  return hostId && displayName && source
    ? {
        hostId,
        displayName,
        ...(entry.alias === null || typeof entry.alias === "string" ? { alias: entry.alias } : {}),
        ...(entry.hostname === null || typeof entry.hostname === "string"
          ? { hostname: entry.hostname }
          : {}),
        source,
      }
    : null;
}

function normalize(raw: unknown, readAt: string): DesktopProjectsCatalog {
  const root = record(raw) ?? {};
  const atom = record(root["electron-persisted-atom-state"]) ?? {};
  const value = (key: string): unknown => root[key] ?? atom[key];

  const localProjects: Record<string, DesktopLocalProject> = {};
  for (const [key, entry] of Object.entries(record(value("local-projects")) ?? {})) {
    const parsed = localProject(key, entry);
    if (parsed) localProjects[parsed.id] = parsed;
  }

  const threadProjectAssignments: Record<string, ThreadProjectAssignment> = {};
  for (const [key, entry] of Object.entries(record(value("thread-project-assignments")) ?? {})) {
    const parsed = assignment(entry);
    if (parsed) threadProjectAssignments[key] = parsed;
  }

  const remoteProjects = value("remote-projects");
  const remoteConnections = value("codex-managed-remote-connections");
  const selected = record(value("selected-project"));
  const selectedProjectId = selected ? string(selected.projectId) : null;
  const selectedProject =
    selected && selectedProjectId && (selected.type === "local" || selected.type === "remote")
      ? { type: selected.type, projectId: selectedProjectId }
      : null;
  const homeDirectory = os.homedir();
  return desktopProjectsCatalogSchema.parse({
    localProjects,
    remoteProjects: (Array.isArray(remoteProjects) ? remoteProjects : [])
      .map(remoteProject)
      .filter((entry): entry is DesktopRemoteProject => entry !== null),
    threadProjectAssignments,
    codexManagedRemoteConnections: (Array.isArray(remoteConnections) ? remoteConnections : [])
      .map(connection)
      .filter((entry): entry is DesktopRemoteConnection => entry !== null),
    projectOrder: strings(value("project-order")),
    selectedProject,
    homeDirectory,
    defaultProjectParent: path.join(homeDirectory, "Documents", "ChatGPT"),
    readAt,
  });
}

function defaultCodexHome(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

/** Reads only the Desktop project state used by the companion; never writes it. */
export class DesktopProjectCatalogReader {
  readonly #file: string;
  readonly #now: () => Date;
  readonly #cacheTtlMs: number;
  readonly #retryDelayMs: number;
  #cached: { mtimeMs: number; size: number; value: DesktopProjectsCatalog } | null = null;
  #cachedAt = 0;

  constructor(options: DesktopProjectCatalogReaderOptions = {}) {
    const codexHome = options.codexHome ?? defaultCodexHome(options.environment ?? process.env);
    this.#file = path.join(codexHome, ".codex-global-state.json");
    this.#now = options.now ?? (() => new Date());
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  get file(): string {
    return this.#file;
  }

  async read(): Promise<DesktopProjectsCatalog> {
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(this.#file);
    } catch (error) {
      throw new DesktopProjectCatalogError(
        "UNAVAILABLE",
        "Codex Desktop project state is unavailable",
        { cause: error },
      );
    }
    if (
      this.#cached &&
      this.#cached.mtimeMs === metadata.mtimeMs &&
      this.#cached.size === metadata.size &&
      this.#now().getTime() - this.#cachedAt < this.#cacheTtlMs
    ) {
      return this.#cached.value;
    }

    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      throw new DesktopProjectCatalogError(
        "UNAVAILABLE",
        "Codex Desktop project state could not be read",
        { cause: error },
      );
    }

    let value: DesktopProjectsCatalog;
    try {
      value = normalize(JSON.parse(text), this.#now().toISOString());
    } catch {
      // Desktop may be between its temp-file rename and the previous snapshot;
      // retry once before treating the file as invalid.
      await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs));
      try {
        text = await readFile(this.#file, "utf8");
        value = normalize(JSON.parse(text), this.#now().toISOString());
      } catch (error) {
        throw new DesktopProjectCatalogError("INVALID", "Codex Desktop project state is invalid", {
          cause: error,
        });
      }
    }

    this.#cached = { mtimeMs: metadata.mtimeMs, size: metadata.size, value };
    this.#cachedAt = this.#now().getTime();
    return value;
  }
}
