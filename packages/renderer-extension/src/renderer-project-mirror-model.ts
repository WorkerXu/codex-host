import type { ProjectGroup, ProjectGroupMember } from "@codexhost/shared-contracts";

export interface MirrorSourceProject {
  id: string;
  name: string;
  rootPaths: readonly string[];
}

const INVALID_DIRECTORY_CHARACTER = /[<>:"/\\|?*\u0000-\u001f]/u;

/** Desktop's own sanitization is not exported; match its observable result. */
export function sanitizeMirrorDirectoryName(name: string): string {
  const trimmed = name.trim();
  const replaced = [...trimmed]
    .map((character) => (INVALID_DIRECTORY_CHARACTER.test(character) ? "_" : character))
    .join("")
    .replace(/[ .]+$/gu, "");
  return replaced.length === 0 ? "New project" : replaced;
}

export function isNameOnlyProject(
  project: MirrorSourceProject,
  defaultProjectParent: string | undefined,
): boolean {
  if (!defaultProjectParent || project.rootPaths.length !== 1) return false;
  const root = project.rootPaths[0];
  if (!root) return false;
  const separator = Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\"));
  const parent = separator >= 0 ? root.slice(0, separator) : root;
  const basename = separator >= 0 ? root.slice(separator + 1) : root;
  if (parent !== defaultProjectParent.replace(/[\\/]+$/u, "")) return false;
  const expected = sanitizeMirrorDirectoryName(project.name);
  if (basename === expected) return true;
  return /^\d+$/u.test(basename.slice(expected.length + 1)) && basename.startsWith(`${expected} `);
}

/** Deterministic candidates mirroring Desktop's `<name>`, `<name> 2`, `<name> 3` rule. */
export function mirrorDirectoryCandidates(parent: string, name: string, limit = 32): string[] {
  const normalizedParent = parent.replace(/\/+$/u, "");
  const base = sanitizeMirrorDirectoryName(name);
  const candidates = [`${normalizedParent}/${base}`];
  for (let index = 2; index < limit + 2; index += 1) {
    candidates.push(`${normalizedParent}/${base} ${index}`);
  }
  return candidates;
}

export function effectiveModelId(
  providerId: string,
  modelId: string,
  defaultProviderId: string | null,
): string {
  if (modelId.includes("/")) return modelId;
  return providerId === defaultProviderId ? modelId : `${providerId}/${modelId}`;
}

export interface HostModelLike {
  id: string;
  label?: string | null;
  displayName?: string | null;
  defaultReasoningEffort?: string | null;
  isDefault?: boolean;
  hidden?: boolean;
}

export interface ProviderConfigLike {
  name?: string | null;
}

export interface ProviderModelGroup {
  providerId: string;
  providerLabel: string;
  models: HostModelLike[];
}

/**
 * `model/list` does not return a provider field. Codex resolves a bare model id
 * through the host's default provider; a `provider/model` id names its
 * provider explicitly.
 */
export function groupProviderModels(
  models: readonly HostModelLike[],
  providers: Readonly<Record<string, ProviderConfigLike>>,
  defaultProviderId: string | null,
): ProviderModelGroup[] {
  const groups = new Map<string, HostModelLike[]>();
  for (const model of models) {
    if (model.hidden) continue;
    const slash = model.id.indexOf("/");
    const providerId =
      slash > 0 ? model.id.slice(0, slash) : (defaultProviderId ?? Object.keys(providers)[0] ?? "");
    if (!providerId) continue;
    const bucket = groups.get(providerId) ?? [];
    bucket.push(model);
    groups.set(providerId, bucket);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([providerId, bucket]) => ({
      providerId,
      providerLabel: providers[providerId]?.name?.trim() || providerId,
      models: [...bucket].sort((left, right) => {
        if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
        return (left.label ?? left.displayName ?? left.id).localeCompare(
          right.label ?? right.displayName ?? right.id,
        );
      }),
    }));
}

export interface MirrorGroupPlan {
  groups: ProjectGroup[];
  action: "created" | "appended" | "skipped-other-group";
  changed: boolean;
}

function memberKey(member: ProjectGroupMember): string {
  return `${member.projectKind}\u0000${member.projectId}`;
}

function sameMember(left: ProjectGroupMember, right: ProjectGroupMember): boolean {
  return memberKey(left) === memberKey(right);
}

/**
 * One project may belong to one group only. A mirror never moves a project out
 * of an existing group; it reports the conflict so the caller can toast once.
 */
export function planMirrorGroup(input: {
  groups: readonly ProjectGroup[];
  name: string;
  source: ProjectGroupMember;
  mirror: ProjectGroupMember;
  createId: () => string;
  now: string;
}): MirrorGroupPlan {
  const name = input.name.trim();
  const targetMembers = [input.source, input.mirror];
  const owner = input.groups.find((group) =>
    group.members.some((member) => targetMembers.some((target) => sameMember(member, target))),
  );
  if (owner && owner.name.trim() !== name) {
    return { groups: [...input.groups], action: "skipped-other-group", changed: false };
  }
  const group = input.groups.find((candidate) => candidate.name.trim() === name);
  if (!group) {
    const order =
      input.groups.reduce((maximum, candidate) => Math.max(maximum, candidate.order), -1) + 1;
    return {
      action: "created",
      changed: true,
      groups: [
        ...input.groups,
        {
          id: input.createId(),
          name,
          order,
          collapsed: false,
          members: [...targetMembers],
          createdAt: input.now,
          updatedAt: input.now,
        },
      ],
    };
  }
  const missing = targetMembers.filter(
    (target) => !group.members.some((member) => sameMember(member, target)),
  );
  if (missing.length === 0)
    return { groups: [...input.groups], action: "appended", changed: false };
  return {
    action: "appended",
    changed: true,
    groups: input.groups.map((candidate) =>
      candidate === group
        ? { ...candidate, members: [...candidate.members, ...missing], updatedAt: input.now }
        : candidate,
    ),
  };
}

export interface MirrorDestinationInput {
  name: string;
  hostId: string;
  candidates: readonly string[];
  known: { hostId: string; remotePath: string; remoteProjectId: string } | null;
  desktopProjects: readonly { id: string; label: string; remotePath: string }[];
  appProjects: readonly { name: string; roots: readonly { path: string }[] }[];
  directoryState(path: string): Promise<"directory" | "missing" | "other">;
}

export interface MirrorDestination {
  path: string;
  projectId: string | null;
}

/**
 * Reuse the registered mirror first, then the first candidate that is either an
 * existing same-named project, an existing directory, or a missing path (which
 * the caller creates). A path owned by a differently named project is skipped
 * so the caller falls through to `<name> 2`.
 */
export async function chooseMirrorDestination(
  input: MirrorDestinationInput,
): Promise<MirrorDestination | null> {
  if (input.known && input.known.hostId === input.hostId) {
    const desktopProject = input.desktopProjects.find(
      (project) => project.id === input.known?.remoteProjectId,
    );
    if (desktopProject) return { path: desktopProject.remotePath, projectId: desktopProject.id };
    const appProject = input.appProjects.some((project) =>
      project.roots.some((root) => root.path === input.known?.remotePath),
    );
    if (appProject || (await input.directoryState(input.known.remotePath)) === "directory")
      return { path: input.known.remotePath, projectId: null };
  }
  for (const candidate of input.candidates) {
    const desktopProject = input.desktopProjects.find(
      (project) => project.remotePath === candidate,
    );
    if (desktopProject) {
      if (desktopProject.label !== input.name) continue;
      return { path: candidate, projectId: desktopProject.id };
    }
    const appProject = input.appProjects.find((project) =>
      project.roots.some((root) => root.path === candidate),
    );
    if (appProject && appProject.name !== input.name) continue;
    const state = await input.directoryState(candidate);
    if (state === "other") continue;
    return { path: candidate, projectId: null };
  }
  return null;
}
