import os from "node:os";
import path from "node:path";

import { ProjectMirrorStore, ProjectMirrorRevisionConflictError } from "@codexhost/mapping-store";
import type {
  ProjectMirrorListResult,
  ProjectMirrorUpsertParams,
  ProjectMirrorUpsertResult,
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

  async list(): Promise<ProjectMirrorListResult> {
    const file = await this.#store.list();
    return {
      revision: file.revision,
      projects: file.projects,
      acknowledged: Object.keys(file.acknowledged),
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
      ...(params.acknowledge ? { acknowledge: true as const } : {}),
      ...(record !== undefined ? { record } : {}),
    });
    return {
      revision: file.revision,
      projects: file.projects,
      acknowledged: Object.keys(file.acknowledged),
    };
  }
}

export { ProjectMirrorRevisionConflictError };
