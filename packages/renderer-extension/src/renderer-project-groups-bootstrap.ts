import {
  desktopLocalProjectSchema,
  desktopProjectsCatalogSchema,
  desktopRemoteProjectSchema,
  threadProjectAssignmentSchema,
  type DesktopProjectsCatalog,
} from "@codexhost/shared-contracts";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bootstrapEntries(window: Window): Map<string, unknown> | null {
  const bridge = (
    window as Window & {
      electronBridge?: { getInitialSidebarBootstrap?: () => unknown };
    }
  ).electronBridge;
  const bootstrap = bridge?.getInitialSidebarBootstrap?.();
  const entries = record(bootstrap)?.globalStateEntries;
  if (!Array.isArray(entries)) return null;
  const result = new Map<string, unknown>();
  for (const entry of entries) {
    const item = record(entry);
    if (item && typeof item.key === "string") result.set(item.key, item.value);
  }
  return result;
}

/**
 * The preload caches this snapshot for the lifetime of the Renderer. It is a
 * startup fallback only; fresh project state comes from the local Host RPC.
 */
export function readBootstrapCatalog(
  window: Window,
  now: () => Date = () => new Date(),
): DesktopProjectsCatalog | null {
  const entries = bootstrapEntries(window);
  if (!entries) return null;

  const localProjects: Record<string, unknown> = {};
  for (const [projectId, value] of Object.entries(record(entries.get("local-projects")) ?? {})) {
    const parsed = desktopLocalProjectSchema.safeParse({ id: projectId, ...record(value) });
    if (parsed.success) localProjects[parsed.data.id] = parsed.data;
  }

  const remoteProjectsRaw = entries.get("remote-projects");
  const remoteProjects = (Array.isArray(remoteProjectsRaw) ? remoteProjectsRaw : []).flatMap(
    (value) => {
      const parsed = desktopRemoteProjectSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    },
  );

  const threadProjectAssignments: Record<string, unknown> = {};
  for (const [threadId, value] of Object.entries(
    record(entries.get("thread-project-assignments")) ?? {},
  )) {
    const parsed = threadProjectAssignmentSchema.safeParse(value);
    if (parsed.success) threadProjectAssignments[threadId] = parsed.data;
  }

  const projectOrderRaw = entries.get("project-order");
  const projectOrder = Array.isArray(projectOrderRaw)
    ? projectOrderRaw.filter((value): value is string => typeof value === "string")
    : [];

  const parsed = desktopProjectsCatalogSchema.safeParse({
    localProjects,
    remoteProjects,
    threadProjectAssignments,
    codexManagedRemoteConnections: [],
    projectOrder,
    readAt: now().toISOString(),
  });
  return parsed.success ? parsed.data : null;
}
