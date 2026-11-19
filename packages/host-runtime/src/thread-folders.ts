import os from "node:os";
import path from "node:path";
import { ThreadFoldersStore } from "@codexhost/mapping-store";
import {
  THREAD_FOLDERS_PARAM,
  workingFoldersSchema,
  type ThreadFoldersSelection,
} from "@codexhost/shared-contracts";
import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";

const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const foldersNote = (folders: readonly string[]): string =>
  `工作文件夹已改为 ${folders.join("、")}（主要：${folders[0]}）`;

export function parseWorkingFolders(value: unknown): string[] {
  const folders = workingFoldersSchema.parse(value);
  if (folders.some((folder) => !path.isAbsolute(folder)))
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
    const folders = parseWorkingFolders([cwd, ...roots.filter((root) => root !== cwd)]);
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
  /** Desktop worktrees are execution copies of a project, never a folder the user picked. */
  readonly #worktreeRoot: string;
  constructor(environment: NodeJS.ProcessEnv) {
    this.store = new ThreadFoldersStore(
      path.join(
        environment.CODEXHOST_DATA_DIR ?? path.join(os.homedir(), ".codexhost"),
        "thread-folders",
      ),
    );
    this.#worktreeRoot = path.join(
      environment.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "worktrees",
    );
  }
  #insideWorktree(folder: string): boolean {
    const relative = path.relative(this.#worktreeRoot, folder);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }
  async recent(): Promise<string[]> {
    return (await this.store.recent()).filter((folder) => !this.#insideWorktree(folder));
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
  async prepare(
    request: JsonRpcRequest,
    environment: (threadId: string) => Promise<string | null>,
    external: boolean,
    additionalDirectories = true,
  ): Promise<JsonRpcRequest> {
    const start = rewriteFolderStart(request);
    if (start.folders) {
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
    const environmentId = external ? null : await environment(threadId);
    if (!external && !environmentId)
      throw new Error("无法读取对话的 environmentId，工作文件夹尚未应用，请重新打开对话后重试");
    const changed = JSON.stringify(selection.folders) !== JSON.stringify(selection.appliedFolders);
    this.#pending.set(request.id, { threadId, folders: selection.folders });
    return rewriteFolderTurn(
      request,
      additionalDirectories ? selection.folders : selection.folders.slice(0, 1),
      environmentId,
      changed,
    );
  }
  foldersForRequest(id: string | number): string[] | null {
    return this.#pending.get(id)?.folders ?? null;
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
    await this.store.update(threadId, (current) => ({
      folders: current?.folders ?? pending.folders,
      appliedFolders: pending.folders,
      changedAt: current?.changedAt ?? new Date().toISOString(),
      notes: current?.notes ?? [],
    }));
  }
}
