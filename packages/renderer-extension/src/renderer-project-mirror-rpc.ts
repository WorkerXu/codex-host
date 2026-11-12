import {
  PROJECT_GROUPS_LIST_METHOD,
  PROJECT_GROUPS_REPLACE_METHOD,
  PROJECT_MIRROR_LIST_METHOD,
  PROJECT_MIRROR_UPSERT_METHOD,
  projectGroupsListResultSchema,
  projectGroupsReplaceParamsSchema,
  projectGroupsReplaceResultSchema,
  projectMirrorListResultSchema,
  projectMirrorUpsertParamsSchema,
  projectMirrorUpsertResultSchema,
  type ProjectGroupsListResult,
  type ProjectGroupsReplaceParams,
  type ProjectGroupsReplaceResult,
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

export interface ProjectGroupRpc {
  list(): Promise<ProjectGroupsListResult>;
  replace(input: ProjectGroupsReplaceParams): Promise<ProjectGroupsReplaceResult>;
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

export function createProjectGroupRpc(manager: ProjectMirrorRequestManager): ProjectGroupRpc {
  return {
    async list() {
      return projectGroupsListResultSchema.parse(
        await manager.sendRequest(PROJECT_GROUPS_LIST_METHOD, {}),
      );
    },
    async replace(input) {
      const params = projectGroupsReplaceParamsSchema.parse(input);
      return projectGroupsReplaceResultSchema.parse(
        await manager.sendRequest(PROJECT_GROUPS_REPLACE_METHOD, params),
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
