/**
 * Read-only discovery of Desktop custom sidebar sections.
 *
 * The section element, its project units and their conversation rows are native
 * Desktop nodes. These helpers only read identity and structure; the controller
 * marks those same nodes for CSS layout.
 */

export const SIDEBAR_SECTION_CONTAINER_SELECTOR =
  'div[data-sidebar-project-container-id^="custom:"]';
export const SIDEBAR_SECTION_ID_PREFIX = "custom:";
export const SIDEBAR_PROJECT_CONTAINER_ATTRIBUTE = "data-sidebar-project-container-id";
export const SIDEBAR_PROJECT_ID_PREFIX = "project:";
export const SIDEBAR_PROJECT_ROW_ATTRIBUTE = "data-app-action-sidebar-project-row";
export const SIDEBAR_PROJECT_COLLAPSED_ATTRIBUTE = "data-app-action-sidebar-project-collapsed";
export const SIDEBAR_PROJECT_SHOW_ALL_ATTRIBUTE = "data-app-action-sidebar-project-show-all";
export const SIDEBAR_PROJECT_LIST_ATTRIBUTE = "data-app-action-sidebar-project-list-id";
export const SIDEBAR_THREAD_ROW_ATTRIBUTE = "data-app-action-sidebar-thread-row";
export const SIDEBAR_THREAD_ID_ATTRIBUTE = "data-app-action-sidebar-thread-id";
export const SIDEBAR_THREAD_HOST_ID_ATTRIBUTE = "data-app-action-sidebar-thread-host-id";
export const SIDEBAR_THREAD_PINNED_ATTRIBUTE = "data-app-action-sidebar-thread-pinned";

export type SidebarSectionFallbackReason =
  | "section-missing"
  | "list-missing"
  | "project-missing"
  | "project-header-missing"
  | "project-collapsed"
  | "project-pagination"
  | "thread-id-missing"
  | "duplicate-thread"
  | "stray-thread"
  | "toggle-missing";

export interface SidebarSectionRow {
  element: HTMLElement;
  threadId: string;
  hostId: string;
  pinned: boolean;
}

export interface SidebarSectionProject {
  container: HTMLElement;
  rows: SidebarSectionRow[];
  /** Direct project children that carry no conversation row (header wrapper, rail). */
  hidden: HTMLElement[];
}

export interface SidebarSectionSnapshot {
  sectionId: string;
  container: HTMLElement;
  section: HTMLElement;
  list: HTMLElement;
  projects: SidebarSectionProject[];
}

export type SidebarSectionReadResult =
  | { ok: true; snapshot: SidebarSectionSnapshot }
  | { ok: false; reason: SidebarSectionFallbackReason };

export function readSectionId(container: Element): string | null {
  const value = container.getAttribute(SIDEBAR_PROJECT_CONTAINER_ATTRIBUTE);
  if (!value?.startsWith(SIDEBAR_SECTION_ID_PREFIX)) return null;
  const sectionId = value.slice(SIDEBAR_SECTION_ID_PREFIX.length);
  return sectionId.length > 0 ? sectionId : null;
}

export function findSectionElement(container: Element): HTMLElement | null {
  const sections = container.querySelectorAll<HTMLElement>(
    "section[data-app-action-sidebar-section]",
  );
  return sections.length === 1 ? (sections[0] ?? null) : null;
}

/** The flex column whose direct listitems are the section's project blocks. */
export function findSectionList(section: HTMLElement): HTMLElement | null {
  const lists = section.querySelectorAll<HTMLElement>('div[role="list"]');
  for (const list of lists) {
    const hasProject = [...list.children].some(
      (child) =>
        child instanceof HTMLElement &&
        child.getAttribute("role") === "listitem" &&
        child.querySelector(`div[${SIDEBAR_PROJECT_CONTAINER_ATTRIBUTE}^="project:"]`) !== null,
    );
    if (hasProject) return list;
  }
  return null;
}

function directProjectUnits(list: HTMLElement): HTMLElement[] | null {
  const units: HTMLElement[] = [];
  for (const child of list.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.getAttribute("role") !== "listitem") return null;
    if (child.querySelector(`div[${SIDEBAR_PROJECT_CONTAINER_ATTRIBUTE}^="project:"]`) === null) {
      return null;
    }
    units.push(child);
  }
  return units.length > 0 ? units : null;
}

function threadKey(hostId: string, threadId: string): string {
  return `${hostId}\u0000${threadId}`;
}

export function readSectionSnapshot(container: HTMLElement): SidebarSectionReadResult {
  const sectionId = readSectionId(container);
  const section = findSectionElement(container);
  if (!sectionId || !section) return { ok: false, reason: "section-missing" };
  const list = findSectionList(section);
  if (!list) return { ok: false, reason: "list-missing" };
  const units = directProjectUnits(list);
  if (!units) return { ok: false, reason: "project-missing" };

  const projects: SidebarSectionProject[] = [];
  const seenThreads = new Set<string>();
  for (const unit of units) {
    const project = unit.querySelector<HTMLElement>(
      `div[${SIDEBAR_PROJECT_CONTAINER_ATTRIBUTE}^="project:"]`,
    );
    if (!project) return { ok: false, reason: "project-missing" };
    const headerRow = project.querySelector<HTMLElement>(`[${SIDEBAR_PROJECT_ROW_ATTRIBUTE}]`);
    if (!headerRow) return { ok: false, reason: "project-header-missing" };
    if (headerRow.getAttribute(SIDEBAR_PROJECT_COLLAPSED_ATTRIBUTE) !== "false") {
      return { ok: false, reason: "project-collapsed" };
    }
    const rowList = project.querySelector<HTMLElement>(`[${SIDEBAR_PROJECT_LIST_ATTRIBUTE}]`);
    if (!rowList || rowList.getAttribute(SIDEBAR_PROJECT_SHOW_ALL_ATTRIBUTE) !== "true") {
      return { ok: false, reason: "project-pagination" };
    }

    const rows: SidebarSectionRow[] = [];
    for (const element of rowList.querySelectorAll<HTMLElement>(
      `[${SIDEBAR_THREAD_ROW_ATTRIBUTE}]`,
    )) {
      const threadId = element.getAttribute(SIDEBAR_THREAD_ID_ATTRIBUTE);
      const hostId = element.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE);
      if (!threadId || !hostId) return { ok: false, reason: "thread-id-missing" };
      const key = threadKey(hostId, threadId);
      if (seenThreads.has(key)) return { ok: false, reason: "duplicate-thread" };
      seenThreads.add(key);
      rows.push({
        element,
        threadId,
        hostId,
        pinned: element.getAttribute(SIDEBAR_THREAD_PINNED_ATTRIBUTE) === "true",
      });
    }

    const hidden = [...project.children].filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.querySelector(`[${SIDEBAR_THREAD_ROW_ATTRIBUTE}]`) === null,
    );
    projects.push({ container: project, rows, hidden });
  }

  const owned = new Set(projects.flatMap((project) => project.rows.map((row) => row.element)));
  for (const element of section.querySelectorAll<HTMLElement>(
    `[${SIDEBAR_THREAD_ROW_ATTRIBUTE}]`,
  )) {
    if (!owned.has(element)) return { ok: false, reason: "stray-thread" };
  }

  return { ok: true, snapshot: { sectionId, container, section, list, projects } };
}

/** Native row identity used by the catalog: host id plus the conversation UUID. */
export function readRowThreadId(row: HTMLElement): string | null {
  const value = row.getAttribute(SIDEBAR_THREAD_ID_ATTRIBUTE);
  if (!value) return null;
  const hostId = row.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE) ?? "";
  if (hostId && value.startsWith(`${hostId}:`)) {
    return (
      value
        .slice(hostId.length + 1)
        .split(":")
        .pop() ?? null
    );
  }
  return value.split(":").pop() ?? null;
}
