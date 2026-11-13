import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  jarvisCandidateSchema,
  jarvisStatusSchema,
  type JarvisCandidate,
  type JarvisKind,
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

export interface JarvisCli {
  executable(): Promise<string | null>;
  run(args: readonly string[], timeoutMs?: number): Promise<JarvisCommandResult>;
  status(): Promise<JarvisStatus>;
  user(): Promise<JarvisUser | null>;
  projects(): Promise<Record<string, unknown>[]>;
  bugs(projectId: number, options?: { createdByMe?: boolean }): Promise<Record<string, unknown>[]>;
  requirements(userId: number): Promise<Record<string, unknown>[]>;
  tasks(userId: number): Promise<Record<string, unknown>[]>;
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
      return await list(["project", "list", "--json"]);
    },
    async bugs(projectId, bugOptions = {}) {
      return await list([
        "bug",
        "list",
        "--project-id",
        String(projectId),
        ...(bugOptions.createdByMe ? ["--created-by-me"] : []),
        "--page-size",
        "100",
        "--json",
      ]);
    },
    async requirements(userId) {
      return await list([
        "requirement",
        "list",
        "--assignee-id",
        String(userId),
        "--page-size",
        "100",
        "--json",
      ]);
    },
    async tasks(userId) {
      const end = new Date();
      end.setDate(end.getDate() + 1);
      const start = new Date();
      start.setDate(start.getDate() - 120);
      const date = (value: Date): string => value.toISOString().slice(0, 10);
      return await list([
        "task",
        "list",
        "--user-ids",
        String(userId),
        "--start-date",
        date(start),
        "--end-date",
        date(end),
        "--page-size",
        "100",
        "--json",
      ]);
    },
    async detail(mention) {
      if (mention.kind === "bug") {
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
      }
      if (mention.kind === "requirement") {
        return await run([
          "requirement",
          "detail",
          "--requirement-id",
          String(mention.id),
          "--json",
        ]);
      }
      if (mention.kind === "task") {
        return await run(["task", "detail", "--task-id", String(mention.id), "--json"]);
      }
      return await run(["project", "detail", "--project-id", String(mention.id), "--json"]);
    },
  };
}

/** Map CLI rows to the Host's candidate shape; unknown rows are dropped. */
export function candidateFromJarvisRow(
  kind: JarvisKind,
  row: Record<string, unknown>,
  projects: ReadonlyMap<number, string>,
): JarvisCandidate | null {
  const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  const string = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const common = {
    projectId: number(row.projectId) ?? number(row.originProjectId),
    projectName:
      projects.get(number(row.projectId) ?? number(row.originProjectId) ?? -1) ?? undefined,
    creatorId: number(row.creatorId),
    assigneeId: number(row.assigneeId),
    status: typeof row.status === "number" ? row.status : undefined,
    createdAt:
      string(row.createTime) ??
      string(row.startDate) ??
      string(row.updateTime) ??
      string(row.expectedCompletionDate),
  };
  const candidate = (() => {
    if (kind === "project") {
      const id = number(row.id);
      const title = string(row.name);
      return id && title ? { kind, id, title } : null;
    }
    if (kind === "bug") {
      const id = number(row.id);
      const title = string(row.bugTitle);
      return id && title && common.projectId
        ? { kind, id, title, ...common, projectId: common.projectId }
        : null;
    }
    if (kind === "requirement") {
      const id = number(row.id);
      const title = string(row.requireTitle);
      return id && title ? { kind, id, title, ...common } : null;
    }
    const id = number(row.taskId);
    const title = string(row.taskName);
    return id && title ? { kind, id, title, ...common } : null;
  })();
  return candidate ? jarvisCandidateSchema.parse(candidate) : null;
}

export function jarvisItemUrl(mention: Pick<JarvisMention, "kind" | "id" | "projectId">): string {
  const base = "https://jarvis.eshetang.com";
  if (mention.kind === "bug") {
    return `${base}/bugs/form?projectId=${mention.projectId}&bugId=${mention.id}&mode=view`;
  }
  if (mention.kind === "requirement") {
    return `${base}/requirements/form?requirementId=${mention.id}&mode=view`;
  }
  if (mention.kind === "task") {
    return `${base}/tasks/form?taskId=${mention.id}&mode=view`;
  }
  return `${base}/projects/form?projectId=${mention.id}&mode=view`;
}
