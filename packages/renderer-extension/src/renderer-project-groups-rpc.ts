import {
  DESKTOP_PROJECTS_CATALOG_METHOD,
  PROJECT_GROUPS_LIST_METHOD,
  PROJECT_GROUPS_REPLACE_METHOD,
  desktopProjectsCatalogSchema,
  projectGroupsListResultSchema,
  projectGroupsReplaceParamsSchema,
  projectGroupsReplaceResultSchema,
  type DesktopProjectsCatalog,
  type ProjectGroupsListResult,
  type ProjectGroupsReplaceParams,
  type ProjectGroupsReplaceResult,
} from "@codexhost/shared-contracts";

export interface ProjectGroupsRequestManager {
  sendRequest(method: string, params: unknown): Promise<unknown>;
}

export interface ProjectGroupsRpc {
  list(): Promise<ProjectGroupsListResult>;
  replace(input: ProjectGroupsReplaceParams): Promise<ProjectGroupsReplaceResult>;
  readDesktopCatalog(): Promise<DesktopProjectsCatalog>;
}

export function createProjectGroupsRpc(manager: ProjectGroupsRequestManager): ProjectGroupsRpc {
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
    async readDesktopCatalog() {
      return desktopProjectsCatalogSchema.parse(
        await manager.sendRequest(DESKTOP_PROJECTS_CATALOG_METHOD, {}),
      );
    },
  };
}

export function localProjectGroupsManager(
  routing: { forHost(hostId: string): { manager: ProjectGroupsRequestManager } | null } | undefined,
): ProjectGroupsRequestManager | null {
  return routing?.forHost("local")?.manager ?? null;
}
