import {
  DESKTOP_PROJECTS_CATALOG_METHOD,
  desktopProjectsCatalogSchema,
} from "@codexhost/shared-contracts";

import {
  findCodexAppScope,
  loadCodexNativeSections,
  type NativeSectionApi,
  type NativeSectionScope,
} from "../codex-native-sections.js";

const PROJECT_ITEM_PREFIX = "codex:project:";

export interface DingTalkAgentProject {
  id: string;
  name: string;
  /** Primary Mac-local root path; the dispatch Thread cwd. */
  path: string;
  /** Every root of the project, primary first. */
  roots: string[];
}

export interface DingTalkAgentSection {
  id: string;
  name: string;
  /** Only Mac-local Desktop projects; remote projects never appear here. */
  projects: DingTalkAgentProject[];
}

export interface DingTalkAgentTargets {
  available: boolean;
  sections: DingTalkAgentSection[];
}

export interface NativeSectionEntry {
  id: string;
  name: string;
  itemKeys: string[];
}

export interface NativeLocalProject {
  id: string;
  label: string;
  cwd: string;
  roots: string[];
}

/** Keeps only `codex:project:` items whose project exists in the local catalog. */
export function dingTalkSectionsOf(
  entries: readonly NativeSectionEntry[],
  projects: readonly NativeLocalProject[],
): DingTalkAgentSection[] {
  const local = new Map(projects.map((project) => [project.id, project]));
  return entries.map((entry) => {
    const seen = new Set<string>();
    const contained: DingTalkAgentProject[] = [];
    for (const key of entry.itemKeys) {
      if (!key.startsWith(PROJECT_ITEM_PREFIX)) continue;
      const projectId = key.slice(PROJECT_ITEM_PREFIX.length);
      const project = local.get(projectId);
      if (!project || seen.has(projectId)) continue;
      seen.add(projectId);
      contained.push({
        id: project.id,
        name: project.label,
        path: project.cwd,
        roots: project.roots.length > 0 ? [...project.roots] : [project.cwd],
      });
    }
    return { id: entry.id, name: entry.name, projects: contained };
  });
}

function sectionEntries(value: unknown): NativeSectionEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: NativeSectionEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !Array.isArray(record.itemKeys)) return null;
    entries.push({
      id: record.id,
      name: typeof record.name === "string" ? record.name : "",
      itemKeys: record.itemKeys.filter((key): key is string => typeof key === "string"),
    });
  }
  return entries;
}

function nativeSections(
  scope: NativeSectionScope,
  api: NativeSectionApi,
): NativeSectionEntry[] | null {
  try {
    return sectionEntries(scope.get(api.QV));
  } catch {
    return null;
  }
}

/**
 * Desktop's own sidebar sections and the Mac-local projects they contain.
 * Reading only; nothing is moved or created. A section keeps its native order.
 */
export async function readDingTalkAgentTargets(ownerWindow: Window): Promise<DingTalkAgentTargets> {
  const manager = ownerWindow.__codexhostHostRoutingV1?.forHost("local")?.manager;
  if (!manager) return { available: false, sections: [] };
  const [api, raw] = await Promise.all([
    loadCodexNativeSections(ownerWindow).catch(() => null),
    manager.sendRequest(DESKTOP_PROJECTS_CATALOG_METHOD, {}, { timeoutMs: 10_000 }),
  ]);
  const catalog = desktopProjectsCatalogSchema.safeParse(raw);
  if (!api || !catalog.success) return { available: false, sections: [] };
  const scope = findCodexAppScope(ownerWindow);
  if (!scope) return { available: false, sections: [] };
  const sections = nativeSections(scope, api);
  if (!sections) return { available: false, sections: [] };
  const projects = Object.values(catalog.data.localProjects).flatMap(({ id, name, rootPaths }) => {
    const cwd = rootPaths[0];
    return cwd ? [{ id, label: name, cwd, roots: rootPaths }] : [];
  });
  return {
    available: true,
    sections: dingTalkSectionsOf(sections, projects),
  };
}

/** The stored choice and what the picker should show for it. */
export function resolveDingTalkAgentTarget(
  targets: DingTalkAgentTargets,
  sectionId: string | null,
  projectId: string | null,
): { section: DingTalkAgentSection | null; project: DingTalkAgentProject | null } {
  const section = sectionId
    ? (targets.sections.find((entry) => entry.id === sectionId) ?? null)
    : null;
  const project =
    section && projectId
      ? (section.projects.find((entry) => entry.id === projectId) ?? null)
      : null;
  return { section, project };
}
