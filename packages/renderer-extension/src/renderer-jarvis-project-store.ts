/**
 * Renderer-local Jarvis project memory.
 *
 * The first step must paint instantly, so the last 「我的项目」 response is kept
 * for a short time and revalidated in the background. The last chosen project
 * is remembered per signed-in Jarvis user, so the next search can start in the
 * bug step. Neither is Jarvis data of record: every request still goes to the
 * Host, and a missing or malformed entry simply opens the project step.
 */
import type { JarvisProject } from "@codexhost/shared-contracts";

const KEY_PREFIX = "codexhost.jarvis.projects.v1.";
const LAST_PROJECT_PREFIX = "codexhost.jarvis.last-project.v1.";
const PROJECTS_TTL_MS = 10 * 60_000;
const LAST_PROJECT_TTL_MS = 90 * 24 * 60 * 60_000;

export interface JarvisProjectCacheRecord {
  userId: number;
  savedAt: number;
  projects: JarvisProject[];
}

function isProject(value: unknown): value is JarvisProject {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "number" &&
    Number.isSafeInteger(record.id) &&
    record.id > 0 &&
    typeof record.name === "string" &&
    record.name.trim().length > 0
  );
}

function read(storage: Storage | null, key: string): Record<string, unknown> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function write(storage: Storage | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or unavailable store only costs the next paint its cache.
  }
}

/** Raw project cache, including its owner; callers decide about expiry. */
export function readJarvisProjectCache(
  storage: Storage | null,
  hostId: string,
): JarvisProjectCacheRecord | null {
  const record = read(storage, `${KEY_PREFIX}${hostId}`);
  if (!record) return null;
  const userId = record.userId;
  const savedAt = record.savedAt;
  const projects = record.projects;
  if (
    typeof userId !== "number" ||
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    typeof savedAt !== "number" ||
    !Number.isFinite(savedAt) ||
    !Array.isArray(projects) ||
    !projects.every(isProject)
  ) {
    return null;
  }
  return { userId, savedAt, projects };
}

export function isJarvisProjectCacheFresh(
  record: JarvisProjectCacheRecord,
  now: number,
  ttlMs = PROJECTS_TTL_MS,
): boolean {
  return now - record.savedAt >= 0 && now - record.savedAt < ttlMs;
}

export function writeJarvisProjectCache(
  storage: Storage | null,
  hostId: string,
  userId: number,
  projects: readonly JarvisProject[],
  now: number,
): void {
  write(storage, `${KEY_PREFIX}${hostId}`, {
    userId,
    savedAt: now,
    projects: projects.map(({ id, name }) => ({ id, name })),
  });
}

export function clearJarvisProjectCache(storage: Storage | null, hostId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(`${KEY_PREFIX}${hostId}`);
  } catch {
    // Ignore an unavailable store.
  }
}

/** Last project this user opened in the bug step. */
export function readJarvisLastProject(
  storage: Storage | null,
  hostId: string,
  userId: number,
  now: number,
  ttlMs = LAST_PROJECT_TTL_MS,
): JarvisProject | null {
  const record = read(storage, `${LAST_PROJECT_PREFIX}${hostId}.${userId}`);
  if (!record || !isProject(record.project)) return null;
  if (typeof record.savedAt !== "number" || !Number.isFinite(record.savedAt)) return null;
  if (now - record.savedAt < 0 || now - record.savedAt >= ttlMs) return null;
  return { id: record.project.id, name: record.project.name };
}

export function writeJarvisLastProject(
  storage: Storage | null,
  hostId: string,
  userId: number,
  project: Pick<JarvisProject, "id" | "name">,
  now: number,
): void {
  write(storage, `${LAST_PROJECT_PREFIX}${hostId}.${userId}`, {
    savedAt: now,
    project: { id: project.id, name: project.name },
  });
}
