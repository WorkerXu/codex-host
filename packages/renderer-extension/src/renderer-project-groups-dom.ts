import type {
  MachineConnectionState,
  NativeProjectSnapshot,
} from "./renderer-project-groups-model.js";

export const PROJECTS_SECTION_SELECTOR =
  'section[data-app-action-sidebar-section][data-app-action-sidebar-section-heading="Projects"]';
export const PROJECT_ROW_SELECTOR = "[data-app-action-sidebar-project-row]";
export const PROJECT_ID_ATTRIBUTE = "data-app-action-sidebar-project-id";
export const PROJECT_LABEL_ATTRIBUTE = "data-app-action-sidebar-project-label";
export const PROJECT_COLLAPSED_ATTRIBUTE = "data-app-action-sidebar-project-collapsed";
export const PROJECT_SELECT_SELECTOR = "[data-app-action-sidebar-select-project]";
export const PROJECT_KIND_SELECTOR = "[data-sidebar-project-kind]";
export const SECTION_COLLAPSED_ATTRIBUTE = "data-app-action-sidebar-section-collapsed";
export const NEW_CHAT_BUTTON_SELECTOR = `button:not([aria-haspopup]):not([${PROJECT_SELECT_SELECTOR.slice(
  1,
  -1,
)}])`;

export interface ProjectGroupsDomContract {
  ok: boolean;
  missing: string[];
  hasHasSelector: boolean;
  projectCount: number;
  missingNewChatCount: number;
}

export function findProjectsSection(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(PROJECTS_SECTION_SELECTOR);
}

export function findProjectList(section: HTMLElement): HTMLElement | null {
  const candidates = section.querySelectorAll<HTMLElement>('div[role="list"]');
  for (const candidate of candidates) {
    const units = [...candidate.children].filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.getAttribute("role") === "listitem",
    );
    if (units.some((unit) => unit.querySelector(PROJECT_ROW_SELECTOR))) return candidate;
  }
  return null;
}

export function projectUnits(list: HTMLElement): HTMLElement[] {
  return [...list.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.getAttribute("role") === "listitem",
  );
}

export function projectRowForUnit(unit: HTMLElement): HTMLElement | null {
  return unit.querySelector<HTMLElement>(PROJECT_ROW_SELECTOR);
}

export function projectUnitForId(section: HTMLElement, projectId: string): HTMLElement | null {
  for (const unit of projectUnits(findProjectList(section) ?? section)) {
    if (projectRowForUnit(unit)?.getAttribute(PROJECT_ID_ATTRIBUTE) === projectId) return unit;
  }
  return null;
}

export function projectHostLabel(row: HTMLElement): string | null {
  const label = row.getAttribute(PROJECT_LABEL_ATTRIBUTE);
  const aria = row.getAttribute("aria-label");
  if (!label || !aria || !aria.startsWith(`${label} `)) return null;
  return aria.slice(label.length + 1).trim() || null;
}

export function projectKindForRow(row: HTMLElement): "local" | "remote" | null {
  const value = row.querySelector<HTMLElement>(PROJECT_KIND_SELECTOR)?.dataset.sidebarProjectKind;
  return value === "local" || value === "remote" ? value : null;
}

export function readNativeProjectSnapshots(section: HTMLElement): NativeProjectSnapshot[] {
  const list = findProjectList(section);
  if (!list) return [];
  const snapshots: NativeProjectSnapshot[] = [];
  for (const unit of projectUnits(list)) {
    const row = projectRowForUnit(unit);
    const projectId = row?.getAttribute(PROJECT_ID_ATTRIBUTE);
    if (!row || !projectId) continue;
    snapshots.push({
      projectId,
      label: row.getAttribute(PROJECT_LABEL_ATTRIBUTE) ?? projectId,
      kind: projectKindForRow(row),
      hostLabel: projectHostLabel(row),
      hasNewChatButton: newChatButton(row) !== null,
    });
  }
  return snapshots;
}

export function newChatButton(row: HTMLElement): HTMLElement | null {
  const buttons = [...row.querySelectorAll<HTMLElement>(NEW_CHAT_BUTTON_SELECTOR)];
  return buttons.length === 1 ? (buttons[0] ?? null) : null;
}

export function statusIconState(row: HTMLElement): MachineConnectionState {
  const icon = row.querySelector<HTMLElement>('[role="img"][aria-label]');
  if (!icon) return "unknown";
  const className = typeof icon.className === "string" ? icon.className : "";
  if (className.includes("text-chart-green")) return "connected";
  if (className.includes("text-chart-red") || className.includes("text-chart-danger"))
    return "error";
  if (className.includes("text-chart-yellow") || className.includes("text-chart-orange"))
    return "connecting";
  const label = icon.getAttribute("aria-label") ?? "";
  if (/已连接|Connected/i.test(label)) return "connected";
  if (/连接中|Connecting/i.test(label)) return "connecting";
  if (/未连接|Disconnected/i.test(label)) return "disconnected";
  if (/失败|Error|Failed/i.test(label)) return "error";
  return "unknown";
}

export function findProjectsShowMoreButton(section: HTMLElement): HTMLElement | null {
  const list = findProjectList(section);
  if (!list) return null;
  const units = projectUnits(list);
  for (const unit of units.toReversed()) {
    if (projectRowForUnit(unit)) continue;
    const buttons = [...unit.querySelectorAll<HTMLElement>("button")];
    const labelled = buttons.find(
      (button) =>
        /展开显示|Show more/i.test((button.textContent ?? "").trim()) ||
        /show more/i.test(button.getAttribute("aria-label") ?? ""),
    );
    if (labelled) return labelled;
  }
  return (
    [...section.querySelectorAll<HTMLElement>("button")].find(
      (button) =>
        /展开显示|Show more/i.test((button.textContent ?? "").trim()) ||
        /show more/i.test(button.getAttribute("aria-label") ?? ""),
    ) ?? null
  );
}

/** A project may be shown natively outside Projects, for example in a pinned area. */
export function projectRowOutsideSection(
  root: ParentNode,
  section: HTMLElement,
  projectId: string,
): HTMLElement | null {
  for (const row of root.querySelectorAll<HTMLElement>(PROJECT_ROW_SELECTOR)) {
    if (row.getAttribute(PROJECT_ID_ATTRIBUTE) !== projectId) continue;
    if (!section.contains(row)) return row;
  }
  return null;
}

export function hasHasSelector(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("selector(:has(*))")
    : false;
}

export function probeProjectGroupsContract(section: HTMLElement | null): ProjectGroupsDomContract {
  const missing: string[] = [];
  if (!section) missing.push("projects-section");
  const list = section ? findProjectList(section) : null;
  if (!list) missing.push("projects-list");
  const units = list ? projectUnits(list) : [];
  if (units.length === 0) missing.push("project-units");
  let projectCount = 0;
  let missingNewChatCount = 0;
  for (const unit of units) {
    const row = projectRowForUnit(unit);
    // `Show more` and other section rows are direct listitems without a project row.
    if (!row) continue;
    if (!row.getAttribute(PROJECT_ID_ATTRIBUTE) || !row.getAttribute(PROJECT_LABEL_ATTRIBUTE)) {
      missing.push("project-row-identity");
      continue;
    }
    projectCount += 1;
    // A missing new-chat button is a per-project state (for example an offline
    // remote), not a Desktop contract break. Keep the count for diagnostics.
    if (!newChatButton(row)) missingNewChatCount += 1;
  }
  const supportsHas = hasHasSelector();
  if (!supportsHas) missing.push("has-selector");
  return {
    ok: missing.length === 0,
    missing: [...new Set(missing)],
    hasHasSelector: supportsHas,
    projectCount,
    missingNewChatCount,
  };
}

export interface RendererProjectGroupsContractInspection {
  sectionCount: number;
  projectCount: number;
  missingNewChatCount: number;
  contractOk: boolean;
}

export function inspectRendererProjectGroupsContract(
  root: ParentNode = document,
): RendererProjectGroupsContractInspection {
  const section = findProjectsSection(root);
  const contract = probeProjectGroupsContract(section);
  return {
    sectionCount: section ? 1 : 0,
    projectCount: contract.projectCount,
    missingNewChatCount: contract.missingNewChatCount,
    contractOk: contract.ok,
  };
}
