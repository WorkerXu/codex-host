import {
  PROJECT_MIRROR_LIST_METHOD,
  PROJECT_MIRROR_UPSERT_METHOD,
  projectMirrorListResultSchema,
  projectMirrorUpsertParamsSchema,
  projectMirrorUpsertResultSchema,
  type ProjectMirrorListResult,
  type ProjectMirrorUpsertParams,
  type ProjectMirrorUpsertResult,
} from "@codexhost/shared-contracts";

export interface ProjectMirrorRequestManager {
  sendRequest(method: string, params: unknown): Promise<unknown>;
}

export interface ProjectMirrorRpc {
  list(): Promise<ProjectMirrorListResult>;
  upsert(input: ProjectMirrorUpsertParams): Promise<ProjectMirrorUpsertResult>;
}

export function createProjectMirrorRpc(manager: ProjectMirrorRequestManager): ProjectMirrorRpc {
  return {
    async list() {
      return projectMirrorListResultSchema.parse(
        await manager.sendRequest(PROJECT_MIRROR_LIST_METHOD, {}),
      );
    },
    async upsert(input) {
      const params = projectMirrorUpsertParamsSchema.parse(input);
      return projectMirrorUpsertResultSchema.parse(
        await manager.sendRequest(PROJECT_MIRROR_UPSERT_METHOD, params),
      );
    },
  };
}

export function localProjectMirrorManager(
  routing: { forHost(hostId: string): { manager: unknown } | null } | undefined,
): ProjectMirrorRequestManager | null {
  const manager = routing?.forHost("local")?.manager;
  return manager ? (manager as ProjectMirrorRequestManager) : null;
}
