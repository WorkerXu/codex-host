import type {
  DesktopProjectsCatalog,
  ProjectGroup,
  ProjectGroupMember,
} from "@codexhost/shared-contracts";

export type ProjectGroupProjectKind = "local" | "remote";
export type MachineConnectionState =
  "connected" | "connecting" | "disconnected" | "error" | "unknown";

export interface NativeProjectSnapshot {
  projectId: string;
  label: string;
  kind: ProjectGroupProjectKind | null;
  hostLabel: string | null;
  hasNewChatButton: boolean;
}

export interface ProjectIndexEntry {
  projectId: string;
  kind: ProjectGroupProjectKind;
  label: string;
  hostId: string | null;
  hostLabel: string | null;
  rootPaths: string[];
  remotePath: string | null;
  native: NativeProjectSnapshot | null;
}

export interface ResolvedProject {
  member: ProjectGroupMember;
  entry: ProjectIndexEntry | null;
  missing: "missing" | "not-mounted" | null;
}

export interface ProjectGroupProjectView {
  project: ResolvedProject;
  /** The member currently has a native project unit in the Projects list. */
  mounted: boolean;
  newChatAvailable: boolean;
}

export interface ProjectGroupMachineView {
  key: string;
  label: string;
  state: MachineConnectionState;
  projects: readonly ProjectGroupProjectView[];
}

export interface ProjectGroupView {
  group: ProjectGroup;
  projects: readonly ProjectGroupProjectView[];
  machines: readonly ProjectGroupMachineView[];
  unresolved: readonly ProjectGroupMember[];
}

const CONNECTION_RANK: Record<MachineConnectionState, number> = {
  connected: 0,
  connecting: 1,
  unknown: 2,
  disconnected: 3,
  error: 4,
};

export function worseConnectionState(
  left: MachineConnectionState,
  right: MachineConnectionState,
): MachineConnectionState {
  return CONNECTION_RANK[left] >= CONNECTION_RANK[right] ? left : right;
}

/** An unknown status must not erase a known one; otherwise every machine starts gray. */
export function mergeMachineState(
  current: MachineConnectionState | undefined,
  next: MachineConnectionState,
): MachineConnectionState {
  if (current === undefined || current === "unknown") return next;
  if (next === "unknown") return current;
  return worseConnectionState(current, next);
}

export function projectHostKey(entry: ProjectIndexEntry): string {
  return entry.kind === "local"
    ? "local"
    : (entry.hostId ?? `host-label:${entry.hostLabel ?? entry.projectId}`);
}

export function projectGroupMachineSummary(machines: readonly ProjectGroupMachineView[]): {
  text: string;
  title: string;
} {
  const title = machines.map((machine) => machine.label).join(" · ");
  if (machines.length === 0) return { text: "", title };
  if (machines.length === 1) return { text: machines[0]?.label ?? "", title };
  return { text: `${machines.length} 台`, title };
}

/** Machine name used by group headers and native-row subtitles. */
export function projectMachineName(
  entry: ProjectIndexEntry,
  catalog: DesktopProjectsCatalog,
): string {
  if (entry.kind === "local") return "本机";
  const connection = entry.hostId
    ? catalog.codexManagedRemoteConnections.find(({ hostId }) => hostId === entry.hostId)
    : undefined;
  return (
    connection?.displayName ?? connection?.alias ?? entry.hostLabel ?? entry.hostId ?? "远程机器"
  );
}

function sameRootPaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((path, index) => path === right[index]);
}

export function buildProjectIndex(
  catalog: DesktopProjectsCatalog,
  snapshots: readonly NativeProjectSnapshot[],
): Map<string, ProjectIndexEntry> {
  const index = new Map<string, ProjectIndexEntry>();
  for (const [projectId, project] of Object.entries(catalog.localProjects)) {
    index.set(projectId, {
      projectId,
      kind: "local",
      label: project.name,
      hostId: null,
      hostLabel: null,
      rootPaths: project.rootPaths,
      remotePath: null,
      native: null,
    });
  }
  for (const project of catalog.remoteProjects) {
    index.set(project.id, {
      projectId: project.id,
      kind: "remote",
      label: project.label,
      hostId: project.hostId,
      hostLabel: null,
      rootPaths: [],
      remotePath: project.remotePath,
      native: null,
    });
  }
  for (const snapshot of snapshots) {
    const existing = index.get(snapshot.projectId);
    const kind = snapshot.kind ?? existing?.kind ?? "local";
    index.set(snapshot.projectId, {
      projectId: snapshot.projectId,
      kind,
      label: snapshot.label || existing?.label || snapshot.projectId,
      hostId: kind === "remote" ? (existing?.hostId ?? null) : null,
      hostLabel: snapshot.hostLabel,
      rootPaths: existing?.rootPaths ?? [],
      remotePath: existing?.remotePath ?? null,
      native: snapshot,
    });
  }
  return index;
}

function resolveMember(
  member: ProjectGroupMember,
  index: ReadonlyMap<string, ProjectIndexEntry>,
): ProjectIndexEntry | null {
  const exact = index.get(member.projectId);
  if (exact?.kind === member.projectKind) return exact;
  if (member.projectKind === "local") {
    return (
      [...index.values()].find(
        (entry) =>
          entry.kind === "local" &&
          entry.rootPaths.length > 0 &&
          sameRootPaths(entry.rootPaths, member.rootPaths),
      ) ?? null
    );
  }
  return (
    [...index.values()].find(
      (entry) =>
        entry.kind === "remote" &&
        entry.hostId === member.hostId &&
        entry.remotePath === member.remotePath,
    ) ?? null
  );
}

export function resolveGroupProject(
  member: ProjectGroupMember,
  index: ReadonlyMap<string, ProjectIndexEntry>,
): ResolvedProject {
  const entry = resolveMember(member, index);
  if (!entry) return { member, entry: null, missing: "missing" };
  return {
    member,
    entry,
    missing: entry.native ? null : "not-mounted",
  };
}

function projectView(resolved: ResolvedProject): ProjectGroupProjectView {
  const native = resolved.entry?.native ?? null;
  return {
    project: resolved,
    mounted: native !== null,
    newChatAvailable: native?.hasNewChatButton ?? false,
  };
}

export function buildProjectGroupViews(input: {
  groups: readonly ProjectGroup[];
  catalog: DesktopProjectsCatalog;
  snapshots: readonly NativeProjectSnapshot[];
  machineState: ReadonlyMap<string, MachineConnectionState>;
}): ProjectGroupView[] {
  const index = buildProjectIndex(input.catalog, input.snapshots);
  return [...input.groups]
    .map((group, position) => ({ group, position }))
    .sort((left, right) => left.group.order - right.group.order || left.position - right.position)
    .map(({ group }) => {
      const projects = group.members.map((member) =>
        projectView(resolveGroupProject(member, index)),
      );
      const unresolved = projects
        .filter((project) => project.project.missing !== null)
        .map((project) => project.project.member);
      const machines = new Map<
        string,
        Omit<ProjectGroupMachineView, "projects"> & { projects: ProjectGroupProjectView[] }
      >();
      for (const project of projects) {
        const entry = project.project.entry;
        if (!entry) continue;
        const key = projectHostKey(entry);
        let machine = machines.get(key);
        if (!machine) {
          machine = {
            key,
            label: projectMachineName(entry, input.catalog),
            state: input.machineState.get(key) ?? "unknown",
            projects: [],
          };
          machines.set(key, machine);
        }
        machine.projects.push(project);
        machine.state = mergeMachineState(machine.state, input.machineState.get(key) ?? "unknown");
      }
      return {
        group,
        projects,
        machines: [...machines.values()],
        unresolved,
      } satisfies ProjectGroupView;
    });
}

export interface ProjectGroupAddMachineTarget {
  hostId: string;
  machineLabel: string;
  state: "ready" | "offline" | "error";
  /** Preferred Agent on that machine; null when the machine has none. */
  harnessId: string | null;
  harnessLabel: string | null;
}

/** Machines not already present in the group, one row per machine. */
export function projectGroupAddMachineTargets(
  catalog: {
    machines: readonly {
      hostId: string;
      label: string;
      state: "ready" | "offline" | "error";
      harnesses: readonly { id: string; label: string }[];
    }[];
  },
  memberHostIds: ReadonlySet<string>,
): ProjectGroupAddMachineTarget[] {
  return catalog.machines.flatMap((machine) => {
    if (memberHostIds.has(machine.hostId) || machine.hostId === "local") return [];
    const preferred =
      machine.harnesses.find((harness) => harness.id === "codex") ?? machine.harnesses[0];
    if (!preferred) return [];
    return [
      {
        hostId: machine.hostId,
        machineLabel: machine.label,
        state: machine.state,
        harnessId: preferred.id,
        harnessLabel: preferred.label,
      },
    ];
  });
}

export interface ProjectGroupAddMachineResult {
  ok: boolean;
  message: string | null;
}
