import type {
  MachineConnectionState,
  NativeProjectSnapshot,
  ThreadSnapshot,
} from "./renderer-project-groups-model.js";

export const PROJECTS_SECTION_SELECTOR =
  'section[data-app-action-sidebar-section][data-app-action-sidebar-section-heading="Projects"]';
export const PROJECT_ROW_SELECTOR = "[data-app-action-sidebar-project-row]";
export const PROJECT_LIST_SELECTOR = "[data-app-action-sidebar-project-list-id]";
export const PROJECT_ID_ATTRIBUTE = "data-app-action-sidebar-project-id";
export const PROJECT_LABEL_ATTRIBUTE = "data-app-action-sidebar-project-label";
export const PROJECT_COLLAPSED_ATTRIBUTE = "data-app-action-sidebar-project-collapsed";
export const PROJECT_SHOW_ALL_ATTRIBUTE = "data-app-action-sidebar-project-show-all";
export const PROJECT_SHOW_ALL_TOGGLE_SELECTOR = "[data-app-action-sidebar-project-show-all-toggle]";
export const PROJECT_SELECT_SELECTOR = "[data-app-action-sidebar-select-project]";
export const PROJECT_KIND_SELECTOR = "[data-sidebar-project-kind]";
export const THREAD_ROW_SELECTOR = "[data-app-action-sidebar-thread-row]";
export const THREAD_ID_ATTRIBUTE = "data-app-action-sidebar-thread-id";
export const THREAD_HOST_ATTRIBUTE = "data-app-action-sidebar-thread-host-id";
export const THREAD_TITLE_ATTRIBUTE = "data-app-action-sidebar-thread-title";
export const THREAD_SELECTED_ATTRIBUTE = "data-app-action-sidebar-thread-selected";
export const THREAD_ACTIVE_ATTRIBUTE = "data-app-action-sidebar-thread-active";
export const THREAD_PINNED_ATTRIBUTE = "data-app-action-sidebar-thread-pinned";
export const SECTION_COLLAPSED_ATTRIBUTE = "data-app-action-sidebar-section-collapsed";
export const SIDEBAR_SCROLL_SELECTOR = "[data-app-action-sidebar-scroll]";
export const NEW_CHAT_BUTTON_SELECTOR = `button:not([aria-haspopup]):not([${PROJECT_SELECT_SELECTOR.slice(
  1,
  -1,
)}])`;

export interface ProjectGroupsDomContract {
  ok: boolean;
  missing: string[];
  hasHasSelector: boolean;
  projectCount: number;
  threadRowCount: number;
  missingNewChatCount: number;
  hasContextMenu: boolean;
  hasThreadActions: boolean;
}

export function sidebarScrollContainer(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SIDEBAR_SCROLL_SELECTOR);
}

/** Restores the sidebar scroll after Desktop navigates to a native thread row. */
export function restoreSidebarScrollAfterThreadClick(options: {
  document: Document;
  window: Window;
  target: HTMLElement | null;
  top: number;
  timeoutMs?: number;
}): () => void {
  const { document, window, target, top } = options;
  let restored = false;
  let observer: MutationObserver | null = null;
  let timer: number | null = null;
  const cleanup = (): void => {
    observer?.disconnect();
    observer = null;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const restore = (): void => {
    if (restored) return;
    restored = true;
    cleanup();
    const scroll = sidebarScrollContainer(document);
    if (scroll) scroll.scrollTop = top;
  };
  const isActive = (): boolean =>
    target?.getAttribute(THREAD_ACTIVE_ATTRIBUTE) === "true" ||
    target?.getAttribute(THREAD_SELECTED_ATTRIBUTE) === "true";
  if (isActive()) {
    restore();
    return cleanup;
  }
  observer = new MutationObserver(() => {
    if (isActive()) restore();
  });
  observer.observe(document.body ?? document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: [THREAD_ACTIVE_ATTRIBUTE, THREAD_SELECTED_ATTRIBUTE],
  });
  timer = window.setTimeout(restore, options.timeoutMs ?? 700);
  return cleanup;
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

export function projectListForUnit(unit: HTMLElement): HTMLElement | null {
  return unit.querySelector<HTMLElement>(PROJECT_LIST_SELECTOR);
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
    const projectList = projectListForUnit(unit);
    const showAll = projectList?.getAttribute(PROJECT_SHOW_ALL_ATTRIBUTE);
    snapshots.push({
      projectId,
      label: row.getAttribute(PROJECT_LABEL_ATTRIBUTE) ?? projectId,
      kind: projectKindForRow(row),
      hostLabel: projectHostLabel(row),
      collapsed: row.getAttribute(PROJECT_COLLAPSED_ATTRIBUTE) === "true",
      hasList: projectList !== null,
      hasShowAllToggle: unit.querySelector(PROJECT_SHOW_ALL_TOGGLE_SELECTOR) !== null,
      showAll: showAll === null || showAll === undefined ? null : showAll === "true",
    });
  }
  return snapshots;
}

export function readThreadSnapshots(list: HTMLElement): ThreadSnapshot[] {
  return [...list.querySelectorAll<HTMLElement>(THREAD_ROW_SELECTOR)].flatMap((row) => {
    const threadId = row.getAttribute(THREAD_ID_ATTRIBUTE);
    if (!threadId) return [];
    return [
      {
        threadId,
        hostId: row.getAttribute(THREAD_HOST_ATTRIBUTE) || "local",
        title: row.getAttribute(THREAD_TITLE_ATTRIBUTE) ?? threadId,
        selected: row.getAttribute(THREAD_SELECTED_ATTRIBUTE) === "true",
        active: row.getAttribute(THREAD_ACTIVE_ATTRIBUTE) === "true",
        pinned: row.getAttribute(THREAD_PINNED_ATTRIBUTE) === "true",
        providerIcon: row.querySelector("[data-codexhost-sidebar-agent-icon]"),
      },
    ];
  });
}

export function nativeThreadRows(section: HTMLElement): HTMLElement[] {
  return [...section.querySelectorAll<HTMLElement>(THREAD_ROW_SELECTOR)];
}

export function findNativeThreadRow(
  section: HTMLElement,
  threadId: string,
  hostId: string,
): HTMLElement | null {
  return (
    nativeThreadRows(section).find(
      (row) =>
        row.getAttribute(THREAD_ID_ATTRIBUTE) === threadId &&
        (row.getAttribute(THREAD_HOST_ATTRIBUTE) || "local") === hostId,
    ) ?? null
  );
}

export function newChatButton(row: HTMLElement): HTMLElement | null {
  const buttons = [...row.querySelectorAll<HTMLElement>(NEW_CHAT_BUTTON_SELECTOR)];
  return buttons.length === 1 ? (buttons[0] ?? null) : null;
}

export function projectMenuButton(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
}

export type NativeThreadAction = "pin" | "archive";

export function nativeThreadActionButton(
  row: HTMLElement,
  action: NativeThreadAction,
): HTMLElement | null {
  const pattern = action === "pin" ? /置顶|pin/i : /归档|archive/i;
  return (
    [...row.querySelectorAll<HTMLElement>("button[aria-label]")].find((button) =>
      pattern.test(button.getAttribute("aria-label") ?? ""),
    ) ?? null
  );
}

export function showAllToggle(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(PROJECT_SHOW_ALL_TOGGLE_SELECTOR);
}

export function sectionCollapsed(section: HTMLElement): boolean {
  return section.getAttribute(SECTION_COLLAPSED_ATTRIBUTE) === "true";
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

/** Read-only capability check for the native thread context menu. */
export function hasNativeContextMenu(row: HTMLElement): boolean {
  const names = Object.getOwnPropertyNames(row).filter((name) => name.startsWith("__reactFiber$"));
  if (names.length !== 1) return false;
  const name = names[0];
  if (!name) return false;
  let fiber: unknown = Object.getOwnPropertyDescriptor(row, name)?.value;
  for (let depth = 0; depth < 12 && fiber; depth += 1) {
    if (typeof fiber !== "object" || fiber === null) return false;
    const props = (fiber as { memoizedProps?: unknown }).memoizedProps;
    if (typeof props === "object" && props !== null) {
      if (typeof (props as { onContextMenu?: unknown }).onContextMenu === "function") return true;
    }
    fiber = (fiber as { return?: unknown }).return;
  }
  return false;
}

export function findProjectsShowMoreButton(section: HTMLElement): HTMLElement | null {
  const list = findProjectList(section);
  if (!list) return null;
  const units = projectUnits(list);
  for (const unit of units.toReversed()) {
    if (projectRowForUnit(unit)) continue;
    const buttons = [...unit.querySelectorAll<HTMLElement>("button")];
    const labelled = buttons.find((button) =>
      /展开显示|Show more/i.test((button.textContent ?? "").trim()),
    );
    if (labelled) return labelled;
  }
  return null;
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
  let threadRowCount = 0;
  for (const unit of units) {
    const row = projectRowForUnit(unit);
    // `Show more` and other section rows are direct listitems without a project row.
    if (!row) continue;
    if (!row.getAttribute(PROJECT_ID_ATTRIBUTE) || !row.getAttribute(PROJECT_LABEL_ATTRIBUTE)) {
      missing.push("project-row-identity");
      continue;
    }
    projectCount += 1;
    if (!newChatButton(row)) missingNewChatCount += 1;
    const threadList = projectListForUnit(unit);
    if (threadList) threadRowCount += threadList.querySelectorAll(THREAD_ROW_SELECTOR).length;
  }
  if (missingNewChatCount > 0) missing.push("new-chat-button");
  const threadRows = section ? [...section.querySelectorAll<HTMLElement>(THREAD_ROW_SELECTOR)] : [];
  const firstThreadRow = threadRows[0] ?? null;
  if (firstThreadRow && !firstThreadRow.getAttribute(THREAD_ID_ATTRIBUTE))
    missing.push("thread-row-identity");
  const hasThreadActions = threadRows.some(
    (row) =>
      nativeThreadActionButton(row, "pin") !== null &&
      nativeThreadActionButton(row, "archive") !== null,
  );
  return {
    ok: missing.length === 0,
    missing: [...new Set(missing)],
    hasHasSelector:
      typeof CSS !== "undefined" && typeof CSS.supports === "function"
        ? CSS.supports("selector(:has(*))")
        : false,
    projectCount,
    threadRowCount,
    missingNewChatCount,
    hasContextMenu: threadRows.some((row) => hasNativeContextMenu(row)),
    hasThreadActions,
  };
}

export interface RendererProjectGroupsContractInspection {
  sectionCount: number;
  projectCount: number;
  threadRowCount: number;
  missingNewChatCount: number;
  hasContextMenu: boolean;
  hasThreadActions: boolean;
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
    threadRowCount: contract.threadRowCount,
    missingNewChatCount: contract.missingNewChatCount,
    hasContextMenu: contract.hasContextMenu,
    hasThreadActions: contract.hasThreadActions,
    contractOk: contract.ok,
  };
}
