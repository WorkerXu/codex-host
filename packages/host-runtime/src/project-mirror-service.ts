import os from "node:os";
import path from "node:path";

import { ProjectMirrorStore, ProjectMirrorRevisionConflictError } from "@codexhost/mapping-store";
import type { JsonRpcRequest } from "@codexhost/protocol-core";
import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import {
  PROJECT_MIRROR_LIST_METHOD,
  jsonValueSchema,
  projectMirrorListParamsSchema,
  projectMirrorUpsertParamsSchema,
  type ProjectMirrorListResult,
  type ProjectMirrorUpsertParams,
  type ProjectMirrorUpsertResult,
} from "@codexhost/shared-contracts";

export interface ProjectMirrorServiceOptions {
  directory: string;
  now?: () => Date;
}

export function defaultProjectMirrorDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR;
  return path.join(
    dataDirectory ? path.resolve(dataDirectory) : path.join(os.homedir(), ".codexhost"),
    "project-mirrors",
  );
}

export class ProjectMirrorService {
  readonly #store: ProjectMirrorStore;
  readonly #now: () => Date;

  constructor(options: ProjectMirrorServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#store = new ProjectMirrorStore({ directory: options.directory, now: this.#now });
  }

  async reply(request: JsonRpcRequest) {
    if (request.method === PROJECT_MIRROR_LIST_METHOD) {
      if (!projectMirrorListParamsSchema.safeParse(request.params ?? {}).success)
        return rpcError(request, -32602, "Invalid project mirror list request");
      return rpcEnvelope(request, { result: jsonValueSchema.parse(await this.list()) });
    }
    const parsed = projectMirrorUpsertParamsSchema.safeParse(request.params);
    if (!parsed.success) return rpcError(request, -32602, "Invalid project mirror update");
    try {
      return rpcEnvelope(request, {
        result: jsonValueSchema.parse(await this.upsert(parsed.data)),
      });
    } catch (error) {
      if (error instanceof ProjectMirrorRevisionConflictError)
        return rpcError(request, -32082, error.message);
      throw error;
    }
  }

  async list(): Promise<ProjectMirrorListResult> {
    const file = await this.#store.list();
    return {
      revision: file.revision,
      projects: file.projects,
    };
  }

  async upsert(params: ProjectMirrorUpsertParams): Promise<ProjectMirrorUpsertResult> {
    const now = this.#now().toISOString();
    const record =
      params.record === null || params.record === undefined
        ? params.record
        : {
            ...params.record,
            label: params.record.label.trim() || params.record.label,
            updatedAt: now,
          };
    const file = await this.#store.upsert(params.revision, params.sourceProjectId, {
      ...(record !== undefined ? { record } : {}),
    });
    return {
      revision: file.revision,
      projects: file.projects,
    };
  }
}

export { ProjectMirrorRevisionConflictError };
