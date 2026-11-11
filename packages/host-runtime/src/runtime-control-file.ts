import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const RUNTIME_CONTROL_FORMAT_VERSION = 1;
const CONTROL_FILE_NAME = /^control-(\d+)\.json$/u;
const CONTROL_DIRECTORY_NAME = "runtime";

export interface RuntimeControlRecord {
  formatVersion: 1;
  /** Loopback control endpoint of the owning Host Runtime. */
  endpoint: string;
  token: string;
  pid: number;
  startedAt: string;
}

export interface RuntimeControlLocation {
  filePath: string;
  record: RuntimeControlRecord;
}

export interface RuntimeControlHandle {
  filePath: string;
  record: RuntimeControlRecord;
  /** Removes the file this handle published; a replaced file is left alone. */
  close(): Promise<void>;
}

/** Same rule as the Runtime log, Launcher startup record, and console. */
export function codexhostDataDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(homedir(), ".codexhost");
}

export function runtimeControlDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), CONTROL_DIRECTORY_NAME);
}

export function runtimeControlPath(environment: NodeJS.ProcessEnv, pid = process.pid): string {
  return path.join(runtimeControlDirectory(environment), `control-${pid}.json`);
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // Permission and platform-specific failures do not prove that the process exited.
    return true;
  }
}

/** The token must never travel to a non-loopback endpoint. */
function isLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
      url.port !== ""
    );
  } catch {
    return false;
  }
}

function parseRecord(value: unknown): RuntimeControlRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== RUNTIME_CONTROL_FORMAT_VERSION) return undefined;
  if (typeof record.endpoint !== "string" || !isLoopbackEndpoint(record.endpoint)) return undefined;
  if (typeof record.token !== "string" || record.token.length === 0 || record.token.length > 4096) {
    return undefined;
  }
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return undefined;
  if (typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt))) {
    return undefined;
  }
  return {
    formatVersion: RUNTIME_CONTROL_FORMAT_VERSION,
    endpoint: record.endpoint,
    token: record.token,
    pid: record.pid as number,
    startedAt: record.startedAt,
  };
}

async function readRecord(filePath: string): Promise<RuntimeControlRecord | undefined> {
  try {
    return parseRecord(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

async function ensureControlDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A pre-existing directory keeps its mode through mkdir; tighten it explicitly.
  await chmod(directory, 0o700).catch(() => undefined);
}

/**
 * Publishes one file per Runtime process. Per-PID names let concurrent Runtimes
 * coexist without a shared pointer that a dying process could leave dangling;
 * readers pick the newest live record instead.
 */
export async function publishRuntimeControl(input: {
  environment: NodeJS.ProcessEnv;
  endpoint: string;
  token: string;
  pid?: number;
  startedAt?: string;
}): Promise<RuntimeControlHandle> {
  const pid = input.pid ?? process.pid;
  const record: RuntimeControlRecord = {
    formatVersion: RUNTIME_CONTROL_FORMAT_VERSION,
    endpoint: input.endpoint,
    token: input.token,
    pid,
    startedAt: input.startedAt ?? new Date().toISOString(),
  };
  const directory = runtimeControlDirectory(input.environment);
  await ensureControlDirectory(directory);
  const filePath = runtimeControlPath(input.environment, pid);
  const temporary = path.join(directory, `.control-${pid}-${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    filePath,
    record,
    close: async () => {
      const current = await readRecord(filePath);
      // A reused PID may already own the path; only remove our own record.
      if (current?.pid === record.pid && current.token === record.token) {
        await rm(filePath, { force: true }).catch(() => undefined);
      }
    },
  };
}

/**
 * Returns the newest live Runtime record. Stale records (dead PID, unreadable
 * or malformed files) are ignored rather than deleted by readers.
 */
export async function readRuntimeControl(
  environment: NodeJS.ProcessEnv,
  options: { isProcessAlive?: (pid: number) => boolean } = {},
): Promise<RuntimeControlLocation | undefined> {
  const directory = runtimeControlDirectory(environment);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const isAlive = options.isProcessAlive ?? processIsAlive;
  const candidates: RuntimeControlLocation[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !CONTROL_FILE_NAME.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const record = await readRecord(filePath);
    if (!record || !isAlive(record.pid)) continue;
    candidates.push({ filePath, record });
  }
  candidates.sort(
    (left, right) =>
      Date.parse(right.record.startedAt) - Date.parse(left.record.startedAt) ||
      right.record.pid - left.record.pid,
  );
  return candidates[0];
}
