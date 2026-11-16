import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  jarvisBugSchema,
  jarvisStatusSchema,
  type JarvisBug,
  type JarvisMention,
  type JarvisStatus,
  type JarvisUser,
} from "@codexhost/shared-contracts";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface JarvisCommandResult {
  ok: boolean;
  data: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface JarvisCliOptions {
  environment?: NodeJS.ProcessEnv;
  executable?: string;
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

export interface JarvisBugListOptions {
  createdByMe?: boolean;
  statuses?: readonly number[];
  priorities?: readonly number[];
  title?: string;
  page?: number;
  pageSize?: number;
}

export interface JarvisBugPage {
  list: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

export interface JarvisProjectRow {
  id: number;
  name: string;
}

export interface JarvisCli {
  executable(): Promise<string | null>;
  run(args: readonly string[], timeoutMs?: number): Promise<JarvisCommandResult>;
  status(): Promise<JarvisStatus>;
  user(): Promise<JarvisUser | null>;
  /** Projects linked to my bugs. */
  projects(): Promise<JarvisProjectRow[]>;
  /** Visible project search used only when the query names a project. */
  searchProjects(name: string): Promise<JarvisProjectRow[]>;
  bugs(projectId: number, options?: JarvisBugListOptions): Promise<JarvisBugPage>;
  detail(mention: JarvisMention): Promise<JarvisCommandResult>;
}

function environmentOf(options: JarvisCliOptions): NodeJS.ProcessEnv {
  return options.environment ?? process.env;
}

/** Only used for discovery; every command still goes through the CLI itself. */
export async function jarvisExecutableCandidates(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const home = environment.HOME || os.homedir();
  const names = process.platform === "win32" ? ["jarvis.exe", "jarvis"] : ["jarvis"];
  const candidates: string[] = [];
  const configured = environment.JARVIS_CLI_PATH?.trim();
  if (configured && path.isAbsolute(configured)) candidates.push(configured);
  for (const name of names) candidates.push(path.join(home, ".local", "bin", name));
  const pathValue = environment.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) candidates.push(path.join(directory, name));
  }
  return [...new Set(candidates)];
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    await access(file, process.platform === "win32" ? 0 : 0o1);
    return true;
  } catch {
    return false;
  }
}

/** First installed CLI, preferring an explicit path and the user-local install. */
export async function resolveJarvisExecutable(
  options: JarvisCliOptions = {},
): Promise<string | null> {
  if (options.executable) return options.executable;
  for (const candidate of await jarvisExecutableCandidates(environmentOf(options))) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * `jarvis --json` writes event lines to stderr and one `{ok,data}` object to
 * stdout. A missing terminal object is a failure, never a partial success.
 */
export function parseJarvisOutput(stdout: string, stderr: string): JarvisCommandResult {
  const records = [...stdout.split(/\r?\n/u), ...stderr.split(/\r?\n/u)]
    .map(parseJsonLine)
    .filter((value): value is Record<string, unknown> => value !== null);
  const terminal = records.findLast((record) => typeof record.ok === "boolean");
  if (!terminal) {
    return {
      ok: false,
      data: null,
      errorCode: "invalid_output",
      errorMessage: "CLI returned no JSON result",
    };
  }
  if (terminal.ok === true) {
    return { ok: true, data: terminal.data ?? null, errorCode: null, errorMessage: null };
  }
  const error =
    typeof terminal.error === "object" && terminal.error !== null
      ? (terminal.error as Record<string, unknown>)
      : null;
  return {
    ok: false,
    data: null,
    errorCode: typeof error?.code === "string" ? error.code : "operation_failed",
    errorMessage: typeof error?.message === "string" ? error.message : null,
  };
}

export function createJarvisCli(options: JarvisCliOptions = {}): JarvisCli {
  const environment = environmentOf(options);
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const resolve = (): Promise<string | null> => resolveJarvisExecutable(options);

  const run = async (
    args: readonly string[],
    requestTimeoutMs = timeoutMs,
  ): Promise<JarvisCommandResult> => {
    const executable = await resolve();
    if (!executable) {
      return {
        ok: false,
        data: null,
        errorCode: "not_installed",
        errorMessage: "jarvis CLI is not installed",
      };
    }
    return await new Promise<JarvisCommandResult>((resolveResult) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (result: JarvisCommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult(result);
      };
      const child = spawnImpl(executable, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle({
          ok: false,
          data: null,
          errorCode: "timeout",
          errorMessage: "jarvis CLI timed out",
        });
      }, requestTimeoutMs);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
      });
      child.on("error", () => {
        settle({
          ok: false,
          data: null,
          errorCode: "not_installed",
          errorMessage: "jarvis CLI could not start",
        });
      });
      child.on("close", () => settle(parseJarvisOutput(stdout, stderr)));
    });
  };

  const dataObject = (result: JarvisCommandResult): Record<string, unknown> | null =>
    result.ok && typeof result.data === "object" && result.data !== null
      ? (result.data as Record<string, unknown>)
      : null;

  const list = async (args: readonly string[]): Promise<Record<string, unknown>[]> => {
    const data = dataObject(await run(args));
    return Array.isArray(data?.list)
      ? data.list.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && !Array.isArray(item),
        )
      : [];
  };

  const projectsFrom = (rows: Record<string, unknown>[]): JarvisProjectRow[] =>
    rows.flatMap((row) =>
      typeof row.id === "number" &&
      Number.isSafeInteger(row.id) &&
      row.id > 0 &&
      typeof row.name === "string" &&
      row.name.trim().length > 0
        ? [{ id: row.id, name: row.name.trim() }]
        : [],
    );

  return {
    executable: resolve,
    run,
    async status() {
      const executable = await resolve();
      if (!executable) {
        return jarvisStatusSchema.parse({
          installed: false,
          version: null,
          platform: null,
          authenticated: false,
          userName: null,
          userId: null,
          errorCode: "not_installed",
        });
      }
      const [version, auth] = await Promise.all([
        run(["version", "--json"], 10_000),
        run(["auth", "status", "--json"], 10_000),
      ]);
      const versionData = dataObject(version);
      const authData = dataObject(auth);
      const user =
        typeof authData?.user === "object" && authData.user !== null
          ? (authData.user as Record<string, unknown>)
          : null;
      return jarvisStatusSchema.parse({
        installed: true,
        version: typeof versionData?.version === "string" ? versionData.version : null,
        platform: typeof versionData?.platform === "string" ? versionData.platform : null,
        authenticated: authData?.authenticated === true,
        userName: typeof user?.name === "string" ? user.name : null,
        userId: typeof user?.user_id === "number" ? user.user_id : null,
        errorCode: version.ok ? (auth.ok ? null : "auth_failed") : "version_failed",
      });
    },
    async user() {
      const data = dataObject(await run(["auth", "status", "--json"], 10_000));
      if (data?.authenticated !== true) return null;
      const user =
        typeof data.user === "object" && data.user !== null
          ? (data.user as Record<string, unknown>)
          : null;
      return typeof user?.user_id === "number" && typeof user.name === "string"
        ? { id: user.user_id, name: user.name }
        : null;
    },
    async projects() {
      return projectsFrom(await list(["project", "list", "--json"]));
    },
    async searchProjects(name) {
      return projectsFrom(
        await list(["project", "list", "--scope", "visible", "--name", name, "--json"]),
      );
    },
    async bugs(projectId, bugOptions = {}) {
      const page = bugOptions.page ?? 1;
      const pageSize = bugOptions.pageSize ?? 100;
      const result = await run([
        "bug",
        "list",
        "--project-id",
        String(projectId),
        ...(bugOptions.createdByMe ? ["--created-by-me"] : []),
        ...(bugOptions.statuses && bugOptions.statuses.length > 0
          ? ["--status", bugOptions.statuses.join(",")]
          : []),
        ...(bugOptions.priorities && bugOptions.priorities.length > 0
          ? ["--priority", bugOptions.priorities.join(",")]
          : []),
        ...(bugOptions.title ? ["--title", bugOptions.title] : []),
        "--page",
        String(page),
        "--page-size",
        String(pageSize),
        "--json",
      ]);
      const data = dataObject(result);
      const rows = Array.isArray(data?.list)
        ? data.list.filter(
            (item): item is Record<string, unknown> =>
              typeof item === "object" && item !== null && !Array.isArray(item),
          )
        : [];
      return {
        list: rows,
        total: typeof data?.total === "number" ? data.total : rows.length,
        page: typeof data?.page === "number" ? data.page : page,
        pageSize: typeof data?.pageSize === "number" ? data.pageSize : pageSize,
      };
    },
    async detail(mention) {
      const args = [
        "bug",
        "context",
        "--project-id",
        String(mention.projectId),
        "--bug-id",
        String(mention.id),
        "--json",
      ];
      const context = await run(args);
      if (context.ok) return context;
      return await run([
        "bug",
        "detail",
        "--project-id",
        String(mention.projectId),
        "--bug-id",
        String(mention.id),
        "--json",
      ]);
    },
  };
}

/** Map a CLI bug row to the search result shape; unknown rows are dropped. */
export function bugFromJarvisRow(
  row: Record<string, unknown>,
  projects: ReadonlyMap<number, string>,
): JarvisBug | null {
  const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  const string = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const projectId = number(row.projectId);
  const id = number(row.id);
  const title = string(row.bugTitle);
  if (!projectId || !id || !title) return null;
  const bug = {
    id,
    projectId,
    projectName: projects.get(projectId),
    title,
    ...(typeof row.status === "number" ? { status: row.status } : {}),
    ...(typeof row.priority === "number" ? { priority: row.priority } : {}),
    ...(typeof row.severity === "number" ? { severity: row.severity } : {}),
    ...(number(row.creatorId) ? { creatorId: number(row.creatorId) } : {}),
    ...(number(row.assigneeId) ? { assigneeId: number(row.assigneeId) } : {}),
    ...(string(row.createTime) ? { createdAt: string(row.createTime) } : {}),
    ...(string(row.updateTime) ? { updatedAt: string(row.updateTime) } : {}),
  };
  return jarvisBugSchema.parse(bug);
}

export function jarvisBugUrl(mention: Pick<JarvisMention, "id" | "projectId">): string {
  return `https://jarvis.eshetang.com/bugs/form?projectId=${mention.projectId}&bugId=${mention.id}&mode=view`;
}
