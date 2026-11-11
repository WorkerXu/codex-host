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
  collapsed: boolean;
  hasList: boolean;
  showAll: boolean | null;
}

export interface ThreadSnapshot {
  threadId: string;
  hostId: string;
  title: string;
  selected: boolean;
  active: boolean;
  pinned: boolean;
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
  threads: readonly ThreadSnapshot[];
  collapsed: boolean;
  hasList: boolean;
  showAll: boolean | null;
  canShowAll: boolean;
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

export function projectHostKey(entry: ProjectIndexEntry): string {
  return entry.kind === "local"
    ? "local"
    : (entry.hostId ?? `host-label:${entry.hostLabel ?? entry.projectId}`);
}

export function projectHostLabel(
  entry: ProjectIndexEntry,
  catalog: DesktopProjectsCatalog,
): string {
  if (entry.kind === "local") return "本机";
  if (entry.hostLabel) return entry.hostLabel;
  const connection = entry.hostId
    ? catalog.codexManagedRemoteConnections.find(({ hostId }) => hostId === entry.hostId)
    : undefined;
  return connection?.displayName ?? connection?.alias ?? entry.hostId ?? "远程机器";
}

function memberKey(member: ProjectGroupMember): string {
  return `${member.projectKind}\u0000${member.projectId}`;
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

function projectView(
  resolved: ResolvedProject,
  threadsByProject: ReadonlyMap<string, readonly ThreadSnapshot[]>,
): ProjectGroupProjectView {
  const native = resolved.entry?.native ?? null;
  return {
    project: resolved,
    threads: native ? (threadsByProject.get(native.projectId) ?? []) : [],
    collapsed: native?.collapsed ?? true,
    hasList: native?.hasList ?? false,
    showAll: native?.showAll ?? null,
    canShowAll: native?.hasList === true && native.showAll === false,
  };
}

export function buildProjectGroupViews(input: {
  groups: readonly ProjectGroup[];
  catalog: DesktopProjectsCatalog;
  snapshots: readonly NativeProjectSnapshot[];
  threadsByProject: ReadonlyMap<string, readonly ThreadSnapshot[]>;
  machineState: ReadonlyMap<string, MachineConnectionState>;
}): ProjectGroupView[] {
  const index = buildProjectIndex(input.catalog, input.snapshots);
  return [...input.groups]
    .map((group, index) => ({ group, index }))
    .sort((left, right) => left.group.order - right.group.order || left.index - right.index)
    .map(({ group }) => {
      const projects = group.members.map((member) =>
        projectView(resolveGroupProject(member, index), input.threadsByProject),
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
            label: projectHostLabel(entry, input.catalog),
            state: input.machineState.get(key) ?? "unknown",
            projects: [],
          };
          machines.set(key, machine);
        }
        machine.projects.push(project);
        machine.state = worseConnectionState(
          machine.state,
          input.machineState.get(key) ?? "unknown",
        );
      }
      return {
        group,
        projects,
        machines: [...machines.values()],
        unresolved,
      } satisfies ProjectGroupView;
    });
}

export function memberGroupKey(member: ProjectGroupMember): string {
  return memberKey(member);
}

export function groupProjectIds(groups: readonly ProjectGroup[]): string[] {
  return groups.flatMap((group) => group.members.map((member) => member.projectId));
}
