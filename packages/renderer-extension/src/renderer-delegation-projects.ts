import {
  DELEGATION_PROJECTS_METHOD,
  DELEGATION_PROJECTS_CHANGED_METHOD,
  DESKTOP_PROJECTS_CATALOG_METHOD,
  delegationProjectsResultSchema,
  desktopProjectsCatalogSchema,
  type DesktopSelectedProject,
} from "@codexhost/shared-contracts";
import { loadCodexNativeServices } from "./codex-native-services.js";

export interface AssignmentServices {
  threadProjectAssignments: {
    assign(input: {
      hostId: string;
      threadId: string;
      project: DesktopSelectedProject | null;
    }): Promise<void>;
  };
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
function isAssignmentServices(value: unknown): value is AssignmentServices {
  return (
    record(value) &&
    record(value.threadProjectAssignments) &&
    typeof value.threadProjectAssignments.assign === "function"
  );
}

declare global {
  interface Window {
    __codexhostDelegationProjectsV1?: {
      refresh(): void;
      status(): { pending: number; lastError: string | null };
      dispose(): void;
    };
  }
}

/** Peer project IDs belong to Desktop, not the peer's app-server project catalog. */
export function installRendererDelegationProjects(
  owner: Window = window,
  readServices: (owner: Window) => Promise<AssignmentServices | null> = (value) =>
    loadCodexNativeServices(value, isAssignmentServices),
) {
  owner.__codexhostDelegationProjectsV1?.dispose();
  let disposed = false;
  let inFlight = false;
  let nextRefresh = 0;
  let lastError: string | null = null;
  let pending = 0;
  const subscriptions = new Map<unknown, () => void>();
  const storageKey = "codexhost.delegation-projects.applied.v1";
  const applied = new Set<string>();
  try {
    const stored: unknown = JSON.parse(owner.localStorage.getItem(storageKey) ?? "[]");
    if (Array.isArray(stored))
      stored.filter((id): id is string => typeof id === "string").forEach((id) => applied.add(id));
  } catch {
    /* Unavailable storage leaves native assignments as the durable source. */
  }
  const refresh = async () => {
    if (disposed || inFlight || Date.now() < nextRefresh) return;
    inFlight = true;
    nextRefresh = Date.now() + 5000;
    try {
      const routing = owner.__codexhostHostRoutingV1;
      const local = routing?.forHost("local");
      if (!local) return;
      const catalog = desktopProjectsCatalogSchema.parse(
        await local.manager.sendRequest(DESKTOP_PROJECTS_CATALOG_METHOD, {}),
      );
      pending = 0;
      lastError = null;
      let services: AssignmentServices | null | undefined;
      for (const hostId of routing?.knownHostIds?.() ?? []) {
        const route = routing?.forHost(hostId);
        if (!route) continue;
        if (!subscriptions.has(route.manager) && route.manager.addNotificationCallback) {
          subscriptions.set(
            route.manager,
            route.manager.addNotificationCallback(DELEGATION_PROJECTS_CHANGED_METHOD, () => {
              nextRefresh = 0;
              void refresh();
            }),
          );
        }
        const response = await Promise.resolve(
          route.manager.sendRequest(DELEGATION_PROJECTS_METHOD, {}),
        )
          .then((value) => delegationProjectsResultSchema.parse(value))
          .catch(() => null);
        for (const assignment of response?.assignments ?? []) {
          const key = `${hostId}\0${assignment.threadId}`;
          if (applied.has(key)) continue;
          const existing = catalog.threadProjectAssignments[assignment.threadId];
          // A user may have already assigned this child before the companion connected.
          if (existing) {
            applied.add(key);
            continue;
          }
          let project: DesktopSelectedProject | null;
          if (assignment.projectId === null) project = null;
          else if (assignment.projectId !== undefined) {
            if (catalog.localProjects[assignment.projectId])
              project = { type: "local", projectId: assignment.projectId };
            else if (catalog.remoteProjects.some((entry) => entry.id === assignment.projectId))
              project = { type: "remote", projectId: assignment.projectId };
            else {
              pending += 1;
              continue;
            }
          } else {
            const parent = assignment.sourceThreadId
              ? catalog.threadProjectAssignments[assignment.sourceThreadId]
              : null;
            project = parent ? { type: parent.projectKind, projectId: parent.projectId } : null;
          }
          services ??= await readServices(owner);
          if (!services) {
            pending += 1;
            lastError = "Desktop threadProjectAssignments.assign service is unavailable";
            continue;
          }
          if (disposed) return;
          await services.threadProjectAssignments.assign({
            hostId,
            threadId: assignment.threadId,
            project,
          });
          applied.add(key);
        }
      }
      try {
        owner.localStorage.setItem(storageKey, JSON.stringify([...applied].slice(-4096)));
      } catch {
        /* Native assignments remain persisted by Desktop. */
      }
    } catch (error) {
      pending += 1;
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      inFlight = false;
    }
  };
  const retry = owner.setInterval(() => {
    if (pending || lastError) {
      nextRefresh = 0;
      void refresh();
    }
  }, 5000);
  const api = {
    refresh() {
      void refresh();
    },
    status: () => ({ pending, lastError }),
    dispose() {
      disposed = true;
      owner.clearInterval(retry);
      subscriptions.forEach((stop) => stop());
      subscriptions.clear();
      if (owner.__codexhostDelegationProjectsV1 === api)
        delete owner.__codexhostDelegationProjectsV1;
    },
  };
  owner.__codexhostDelegationProjectsV1 = api;
  return api;
}
