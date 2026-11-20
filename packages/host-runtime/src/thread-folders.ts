import os from "node:os";
import path from "node:path";
import { ThreadFoldersStore } from "@codexhost/mapping-store";
import {
  THREAD_FOLDERS_PARAM,
  THREAD_FOLDERS_GET_METHOD,
  threadFoldersGetParamsSchema,
  threadFoldersSetParamsSchema,
  workingFoldersSchema,
  type ThreadFoldersSelection,
} from "@codexhost/shared-contracts";
import { jsonValueSchema } from "@codexhost/shared-contracts";
import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";

const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const foldersNote = (folders: readonly string[]): string =>
  `工作文件夹已改为 ${folders.join("、")}（主要：${folders[0]}）`;

export function parseWorkingFolders(value: unknown): string[] {
  const folders = workingFoldersSchema.parse(value);
  if (folders.some((folder) => !path.isAbsolute(folder) || folder.includes("\0")))
    throw new Error("工作文件夹必须是绝对路径");
  return folders;
}

/** Current Codex versions expose environments on the Thread and on start/resume results. */
export function threadEnvironmentId(value: unknown): string | null {
  if (!record(value)) return null;
  for (const owner of [value, value.thread, value.result]) {
    if (!record(owner)) continue;
    if (typeof owner.environmentId === "string") return owner.environmentId;
    if (Array.isArray(owner.environments)) {
      const environment = owner.environments.find(
        (entry) => record(entry) && typeof entry.environmentId === "string",
      );
      if (record(environment) && typeof environment.environmentId === "string")
        return environment.environmentId;
    }
    if (owner !== value && record(owner.thread)) {
      const id = threadEnvironmentId(owner.thread);
      if (id) return id;
    }
  }
  return null;
}

export function rewriteFolderStart(request: JsonRpcRequest): {
  request: JsonRpcRequest;
  folders: string[] | null;
} {
  if (request.method !== "thread/start" || !record(request.params))
    return { request, folders: null };
  const carrier = request.params[THREAD_FOLDERS_PARAM];
  if (carrier === undefined) {
    const roots = request.params.runtimeWorkspaceRoots;
    const cwd = request.params.cwd;
    if (typeof cwd !== "string" || !Array.isArray(roots) || !roots.length)
      return { request, folders: null };
    const folders = [
      ...new Set([cwd, ...roots.filter((root): root is string => typeof root === "string")]),
    ];
    if (
      folders.length < 2 ||
      !workingFoldersSchema.safeParse(folders).success ||
      folders.some((folder) => typeof folder !== "string" || !path.isAbsolute(folder))
    )
      return { request, folders: null };
    return { request, folders };
  }
  const folders = parseWorkingFolders(carrier);
  const params: JsonObject = {
    ...request.params,
    cwd: folders[0] ?? "",
    runtimeWorkspaceRoots: folders,
  };
  Reflect.deleteProperty(params, THREAD_FOLDERS_PARAM);
  return { request: { ...request, params } as JsonRpcRequest, folders };
}

export function rewriteFolderTurn(
  request: JsonRpcRequest,
  folders: string[],
  environmentId: string | null,
  note: boolean,
): JsonRpcRequest {
  const params = record(request.params) ? request.params : {};
  const environments = Array.isArray(params.environments) ? params.environments : [];
  return {
    ...request,
    params: {
      ...params,
      cwd: folders[0] ?? "",
      ...(Object.hasOwn(params, "runtimeWorkspaceRoots") ? { runtimeWorkspaceRoots: folders } : {}),
      ...(environmentId
        ? {
            environments: [
              {
                ...(environments.find(
                  (entry) => record(entry) && entry.environmentId === environmentId,
                ) as JsonObject | undefined),
                environmentId,
                cwd: folders[0] ?? "",
                runtimeWorkspaceRoots: folders,
              },
              ...environments.filter(
                (entry) => !record(entry) || entry.environmentId !== environmentId,
              ),
            ],
          }
        : {}),
      ...(note
        ? {
            input: [
              ...(Array.isArray(params.input) ? params.input : []),
              { type: "text", text: foldersNote(folders), text_elements: [] },
            ],
          }
        : {}),
    },
  } as unknown as JsonRpcRequest;
}

export class ThreadFolders {
  readonly store: ThreadFoldersStore;
  readonly #pending = new Map<string | number, { threadId?: string; folders: string[] }>();
  #nextRequest = 0;
  /** Desktop's Codex home holds worktrees, visualizations and session data, never a chosen folder. */
  readonly #codexHome: string;
  constructor(environment: NodeJS.ProcessEnv, dataDirectory?: string) {
    this.store = new ThreadFoldersStore(
      path.join(
        dataDirectory ??
          environment.CODEXHOST_DATA_DIR ??
          path.join(environment.HOME ?? os.homedir(), ".codexhost"),
        "thread-folders",
      ),
    );
    this.#codexHome =
      environment.CODEX_HOME || path.join(environment.HOME ?? os.homedir(), ".codex");
  }
  #insideCodexHome(folder: string): boolean {
    const relative = path.relative(this.#codexHome, folder);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  async recent(): Promise<string[]> {
    return (await this.store.recent()).filter((folder) => !this.#insideCodexHome(folder));
  }
  async select(threadId: string, folders: string[]): Promise<ThreadFoldersSelection> {
    return this.store.update(threadId, (current) => {
      if (current && JSON.stringify(current.folders) === JSON.stringify(folders)) return current;
      const at = new Date().toISOString();
      return {
        folders,
        appliedFolders: current?.appliedFolders ?? null,
        changedAt: at,
        notes: [...(current?.notes ?? []), { text: foldersNote(folders), at }].slice(-100),
      };
    });
  }
  async handle(
    request: JsonRpcRequest,
    supported: (threadId?: string, harnessId?: string) => Promise<boolean>,
    changed: (threadId: string) => void,
  ): Promise<JsonObject> {
    if (request.method === THREAD_FOLDERS_GET_METHOD) {
      const { threadId, harnessId } = threadFoldersGetParamsSchema.parse(request.params);
      const [selection, recent, additionalDirectories] = await Promise.all([
        threadId ? this.store.get(threadId) : null,
        this.recent(),
        supported(threadId, harnessId),
      ]);
      return rpcEnvelope(request, {
        result: jsonValueSchema.parse({
          selection,
          recent,
          additionalDirectories,
        }),
      });
    }
    const { threadId, folders } = threadFoldersSetParamsSchema.parse(request.params);
    const selection = await this.select(threadId, parseWorkingFolders(folders));
    changed(threadId);
    return rpcEnvelope(request, { result: jsonValueSchema.parse(selection) });
  }

  async applied(threadId: string, folders: string[]): Promise<void> {
    await this.store.update(threadId, (current) => ({
      folders: current?.folders ?? folders,
      appliedFolders: folders,
      changedAt: current?.changedAt ?? new Date().toISOString(),
      notes: current?.notes ?? [],
    }));
  }

  /** Native RPCs issued by Web and delegation do not pass through Desktop's output stream. */
  async requestNative(
    method: string,
    params: JsonObject,
    send: (method: string, params: JsonObject) => Promise<JsonObject>,
    diagnose: (error: unknown) => void,
  ): Promise<JsonObject> {
    if (method !== "thread/start" && method !== "turn/start") return send(method, params);
    const id = `codexhost:folders:${++this.#nextRequest}`;
    let request: JsonRpcRequest;
    try {
      request = await this.prepare({ id, method, params }, async (threadId) =>
        threadEnvironmentId(await send("thread/read", { threadId, includeTurns: false })),
      );
    } catch {
      return rpcError({ id, method, params }, -32602, "无法应用工作文件夹，请重新打开对话后重试");
    }
    try {
      const reply = await send(method, request.params as JsonObject);
      await this.observe({ ...reply, id }).catch(diagnose);
      return reply;
    } finally {
      this.cancel(id);
    }
  }

  cancel(id: string | number): void {
    this.#pending.delete(id);
  }

  async prepare(
    request: JsonRpcRequest,
    environment: (threadId: string) => Promise<string | null>,
  ): Promise<JsonRpcRequest> {
    const start = rewriteFolderStart(request);
    if (start.folders) {
      if (record(request.params) && request.params.ephemeral === true) return start.request;
      this.#pending.set(request.id, { folders: start.folders });
      return start.request;
    }
    if (
      request.method !== "turn/start" ||
      !record(request.params) ||
      typeof request.params.threadId !== "string"
    )
      return request;
    const threadId = request.params.threadId;
    const selection = await this.store.get(threadId);
    if (!selection) return request;
    const environmentId = await environment(threadId);
    if (!environmentId)
      throw new Error("无法读取对话的 environmentId，工作文件夹尚未应用，请重新打开对话后重试");
    const changed = JSON.stringify(selection.folders) !== JSON.stringify(selection.appliedFolders);
    this.#pending.set(request.id, { threadId, folders: selection.folders });
    return rewriteFolderTurn(request, selection.folders, environmentId, changed);
  }

  async observe(value: unknown): Promise<void> {
    if (!record(value) || (typeof value.id !== "string" && typeof value.id !== "number")) return;
    const pending = this.#pending.get(value.id);
    if (!pending) return;
    this.#pending.delete(value.id);
    if (value.error || !record(value.result)) return;
    const thread = record(value.result.thread) ? value.result.thread : null;
    const threadId = pending.threadId ?? (typeof thread?.id === "string" ? thread.id : null);
    if (!threadId) return;
    await this.applied(threadId, pending.folders);
  }
}
