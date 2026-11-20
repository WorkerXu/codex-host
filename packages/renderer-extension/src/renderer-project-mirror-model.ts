import type { DesktopProjectsCatalog, DesktopSelectedProject } from "@codexhost/shared-contracts";
import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

export interface MirrorSourceProject {
  id: string;
  name: string;
  rootPaths: readonly string[];
}

/** A source project and the machine whose Desktop owns it. */
export interface MirrorProjectSource extends MirrorSourceProject {
  hostId: string;
  kind: "local" | "remote";
}

export type ProjectEligibilityReason =
  "eligible" | "no-project" | "missing-project" | "not-name-only";

export type MirrorSourceResolution =
  | { source: MirrorProjectSource; reason: "eligible"; error: null }
  | {
      source: null;
      reason: Exclude<ProjectEligibilityReason, "eligible">;
      error: string | null;
    };

const INVALID_DIRECTORY_CHARACTER = /[<>:"/\\|?*\u0000-\u001f]/u;
// Desktop creates name-only projects directly under its default parent; on a
// remote machine that parent is `~/Documents/ChatGPT` under the remote home.
const REMOTE_NAME_ONLY_PARENT = /(?:^|\/)Documents\/ChatGPT$/u;

/** Desktop's own sanitization is not exported; match its observable result. */
export function sanitizeMirrorDirectoryName(name: string): string {
  const trimmed = name.trim();
  const replaced = [...trimmed]
    .map((character) => (INVALID_DIRECTORY_CHARACTER.test(character) ? "_" : character))
    .join("")
    .replace(/[ .]+$/gu, "");
  return replaced.length === 0 ? "New project" : replaced;
}

/** `<name>` or Desktop's numbered `<name> 2` folder name. */
function isNameOnlyBasename(name: string, basename: string): boolean {
  const expected = sanitizeMirrorDirectoryName(name);
  if (basename === expected) return true;
  return /^\d+$/u.test(basename.slice(expected.length + 1)) && basename.startsWith(`${expected} `);
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
  return isNameOnlyBasename(project.name, basename);
}

/**
 * A project Desktop created by name on another machine. Its remote home differs
 * from this Mac's, so only the `Documents/ChatGPT/<name>` shape is comparable.
 */
export function isNameOnlyRemoteProject(project: { label: string; remotePath: string }): boolean {
  const separator = project.remotePath.lastIndexOf("/");
  if (separator <= 0) return false;
  const parent = project.remotePath.slice(0, separator);
  if (!REMOTE_NAME_ONLY_PARENT.test(parent)) return false;
  return isNameOnlyBasename(project.label, project.remotePath.slice(separator + 1));
}

/** An existing local project the mirror may reuse instead of creating `<name> 2`. */
export function findNameOnlyLocalProject(
  projects: readonly MirrorSourceProject[],
  name: string,
  defaultProjectParent: string | undefined,
): MirrorSourceProject | undefined {
  const trimmed = name.trim();
  return projects.find(
    (project) => project.name === trimmed && isNameOnlyProject(project, defaultProjectParent),
  );
}

/**
 * Classify the Composer's project for the mirror. Local and remote name-only
 * projects are both eligible; the source machine comes with the project.
 */
export function resolveMirrorSource(
  catalog: DesktopProjectsCatalog,
  selected: DesktopSelectedProject,
): MirrorSourceResolution {
  if (selected.type === "local") {
    const project = catalog.localProjects[selected.projectId];
    if (!project)
      return {
        source: null,
        reason: "missing-project",
        error: `Project ${selected.projectId} is missing from the Desktop catalog`,
      };
    if (!isNameOnlyProject(project, catalog.defaultProjectParent))
      return { source: null, reason: "not-name-only", error: null };
    return {
      source: {
        id: project.id,
        name: project.name,
        rootPaths: project.rootPaths,
        hostId: "local",
        kind: "local",
      },
      reason: "eligible",
      error: null,
    };
  }
  const project = catalog.remoteProjects.find(({ id }) => id === selected.projectId);
  if (!project)
    return {
      source: null,
      reason: "missing-project",
      error: `Project ${selected.projectId} is missing from the Desktop catalog`,
    };
  if (!isNameOnlyRemoteProject(project))
    return { source: null, reason: "not-name-only", error: null };
  return {
    source: {
      id: project.id,
      name: project.label,
      rootPaths: [project.remotePath],
      hostId: project.hostId,
      kind: "remote",
    },
    reason: "eligible",
    error: null,
  };
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
  /** What the probe saw for `path`; lets the caller skip a duplicate check. */
  state: "directory" | "missing";
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
    if (desktopProject)
      return { path: desktopProject.remotePath, projectId: desktopProject.id, state: "directory" };
    const appProject = input.appProjects.some((project) =>
      project.roots.some((root) => root.path === input.known?.remotePath),
    );
    if (appProject) return { path: input.known.remotePath, projectId: null, state: "directory" };
    const knownState = await input.directoryState(input.known.remotePath);
    if (knownState === "directory")
      return { path: input.known.remotePath, projectId: null, state: knownState };
  }
  for (const candidate of input.candidates) {
    const desktopProject = input.desktopProjects.find(
      (project) => project.remotePath === candidate,
    );
    if (desktopProject) {
      if (desktopProject.label !== input.name) continue;
      return { path: candidate, projectId: desktopProject.id, state: "directory" };
    }
    const appProject = input.appProjects.find((project) =>
      project.roots.some((root) => root.path === candidate),
    );
    if (appProject && appProject.name !== input.name) continue;
    const state = await input.directoryState(candidate);
    if (state === "other") continue;
    return { path: candidate, projectId: null, state };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The Composer receives the project for its own Thread as a prop. The Host
 * catalog's `selected-project` atom can lag behind during draft creation, so
 * prefer the nearest Composer-owned value and fall back only when it is absent.
 */
export function readComposerProject(composer: Element): DesktopSelectedProject | null {
  const key = Object.getOwnPropertyNames(composer).find((name) => name.startsWith("__reactFiber$"));
  if (!key) return null;
  const fiber: unknown = Object.getOwnPropertyDescriptor(composer, key)?.value;
  for (const ancestor of committedReactAncestors(fiber)) {
    const props = ancestor.memoizedProps;
    if (isRecord(props) && isRecord(props.selectedProject)) {
      const selected = props.selectedProject;
      if (
        (selected.type === "local" || selected.type === "remote") &&
        typeof selected.projectId === "string" &&
        selected.projectId.length > 0
      )
        return { type: selected.type, projectId: selected.projectId };
    }
  }
  return null;
}
