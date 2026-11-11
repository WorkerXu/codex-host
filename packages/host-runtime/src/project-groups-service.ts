import os from "node:os";
import path from "node:path";

import { ProjectGroupStore, ProjectGroupRevisionConflictError } from "@codexhost/mapping-store";
import type {
  DesktopProjectsCatalog,
  ProjectGroupsListResult,
  ProjectGroupsReplaceParams,
  ProjectGroupsReplaceResult,
} from "@codexhost/shared-contracts";

import { DesktopProjectCatalogReader } from "./desktop-project-catalog.js";

export interface ProjectGroupsServiceOptions {
  directory: string;
  codexHome?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  catalogCacheTtlMs?: number;
  catalogRetryDelayMs?: number;
}

export function defaultProjectGroupsDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR;
  return path.join(
    dataDirectory ? path.resolve(dataDirectory) : path.join(os.homedir(), ".codexhost"),
    "project-groups",
  );
}

export class ProjectGroupsService {
  readonly #store: ProjectGroupStore;
  readonly #catalog: DesktopProjectCatalogReader;
  readonly #now: () => Date;

  constructor(options: ProjectGroupsServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#store = new ProjectGroupStore({ directory: options.directory, now: this.#now });
    this.#catalog = new DesktopProjectCatalogReader({
      ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {}),
      ...(options.environment !== undefined ? { environment: options.environment } : {}),
      now: this.#now,
      ...(options.catalogCacheTtlMs !== undefined ? { cacheTtlMs: options.catalogCacheTtlMs } : {}),
      ...(options.catalogRetryDelayMs !== undefined
        ? { retryDelayMs: options.catalogRetryDelayMs }
        : {}),
    });
  }

  list(): Promise<ProjectGroupsListResult> {
    return this.#store.list().then(({ revision, groups }) => ({ revision, groups }));
  }

  replace(params: ProjectGroupsReplaceParams): Promise<ProjectGroupsReplaceResult> {
    const now = this.#now().toISOString();
    const groups = params.groups.map((group) => ({
      ...group,
      updatedAt: now,
      createdAt: group.createdAt || now,
    }));
    return this.#store.replace(params.revision, groups).then(({ revision, groups }) => ({
      revision,
      groups,
    }));
  }

  readDesktopCatalog(): Promise<DesktopProjectsCatalog> {
    return this.#catalog.read();
  }
}

export { ProjectGroupRevisionConflictError };
