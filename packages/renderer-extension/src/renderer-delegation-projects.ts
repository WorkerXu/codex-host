import {
  DELEGATION_PROJECTS_METHOD,
  DELEGATION_PROJECTS_CHANGED_METHOD,
  DESKTOP_PROJECTS_CATALOG_METHOD,
  delegationProjectsResultSchema,
  desktopProjectsCatalogSchema,
  type ThreadProjectAssignment,
} from "@codexhost/shared-contracts";
import { loadCodexNativeServices } from "./codex-native-services.js";

export interface AssignmentServices {
  threadProjectAssignments: {
    readMemberships(): Promise<{
      assignments: Record<string, ThreadProjectAssignment>;
      projectlessThreadIds: string[];
    }>;
    setMembership(input: {
      hostId: string;
      threadId: string;
      assignment: ThreadProjectAssignment | null;
      projectless: boolean;
    }): Promise<void>;
  };
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === "object" || typeof value === "function");
export function isAssignmentServices(value: unknown): value is AssignmentServices {
  return (
    record(value) &&
    Object.hasOwn(value, "threadProjectAssignments") &&
    record(value.threadProjectAssignments) &&
    typeof value.threadProjectAssignments.readMemberships === "function" &&
    typeof value.threadProjectAssignments.setMembership === "function"
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

/** Project membership belongs to Desktop, including children on the parent's remote Host. */
export function installRendererDelegationProjects(
  owner: Window = window,
  readServices: (owner: Window) => Promise<AssignmentServices | null> = (value) =>
    loadCodexNativeServices(value, isAssignmentServices),
) {
  owner.__codexhostDelegationProjectsV1?.dispose();
  let disposed = false;
  let inFlight = false;
  let refreshRequested = false;
  let nextRefresh = 0;
  let lastError: string | null = null;
  let pending = 0;
  const subscriptions = new Map<unknown, () => void>();
  const storageKey = "codexhost.delegation-projects.applied.v2";
  const applied = new Set<string>();
  try {
    const stored: unknown = JSON.parse(owner.localStorage.getItem(storageKey) ?? "[]");
    if (Array.isArray(stored))
      stored.filter((id): id is string => typeof id === "string").forEach((id) => applied.add(id));
  } catch {
    /* Unavailable storage leaves native assignments as the durable source. */
  }
  const refresh = async () => {
    if (disposed) return;
    if (inFlight) {
      refreshRequested = true;
      return;
    }
    if (Date.now() < nextRefresh) return;
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
      let memberships:
        | Awaited<ReturnType<AssignmentServices["threadProjectAssignments"]["readMemberships"]>>
        | undefined;
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
          services ??= await readServices(owner);
          if (!services) {
            pending += 1;
            lastError = "Desktop threadProjectAssignments.setMembership service is unavailable";
            continue;
          }
          memberships ??= await services.threadProjectAssignments.readMemberships();
          const existing = memberships.assignments[assignment.threadId];
          // A user may have already assigned this child before the companion connected.
          if (existing || memberships.projectlessThreadIds.includes(assignment.threadId)) {
            applied.add(key);
            continue;
          }
          let project: ThreadProjectAssignment | null;
          if (assignment.projectId === null) project = null;
          else if (assignment.projectId !== undefined) {
            const remote = catalog.remoteProjects.find(
              (entry) => entry.id === assignment.projectId,
            );
            if (catalog.localProjects[assignment.projectId])
              project = { projectKind: "local", projectId: assignment.projectId };
            else if (remote) {
              project = { projectKind: "remote", projectId: remote.id, hostId: remote.hostId };
            } else {
              pending += 1;
              continue;
            }
          } else {
            const parent = assignment.sourceThreadId
              ? memberships.assignments[assignment.sourceThreadId]
              : null;
            if (parent) {
              project = { ...parent };
              if (project.projectKind === "remote" && !project.hostId) {
                const remote = catalog.remoteProjects.find(
                  (entry) => entry.id === parent.projectId,
                );
                if (!remote) {
                  pending += 1;
                  continue;
                }
                project.hostId = remote.hostId;
              }
            } else if (
              !assignment.sourceThreadId ||
              memberships.projectlessThreadIds.includes(assignment.sourceThreadId)
            ) {
              project = null;
            } else {
              // An absent parent assignment may still be loading; never persist that as projectless.
              pending += 1;
              continue;
            }
          }
          if (disposed) return;
          await services.threadProjectAssignments.setMembership({
            hostId,
            threadId: assignment.threadId,
            assignment: project,
            projectless: project === null,
          });
          if (project) memberships.assignments[assignment.threadId] = project;
          else memberships.projectlessThreadIds.push(assignment.threadId);
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
      if (refreshRequested) {
        refreshRequested = false;
        nextRefresh = 0;
        void refresh();
      }
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
