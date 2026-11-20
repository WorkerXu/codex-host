/**
 * Sidebar section display preferences and the merged-list ordering rule.
 *
 * Desktop owns section membership and row order. This module only decides which
 * order numbers the native rows receive, and remembers the per-section choice.
 */

export type SidebarSectionDisplayMode = "merged" | "grouped";

export const SIDEBAR_SECTION_DISPLAY_STORAGE_KEY = "codexhost.sidebarSectionDisplay.v1";
export const DEFAULT_SIDEBAR_SECTION_DISPLAY_MODE: SidebarSectionDisplayMode = "merged";
const MAX_STORED_SECTIONS = 200;

export interface SidebarSectionDisplayStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SidebarMergeThread {
  threadId: string;
  pinned: boolean;
  /** Catalog recency when known; `null` keeps the native position inside its project. */
  recency: number | null;
}

function readPreferences(
  storage: SidebarSectionDisplayStorage | null,
): Record<string, SidebarSectionDisplayMode> {
  try {
    const value: unknown = JSON.parse(
      storage?.getItem(SIDEBAR_SECTION_DISPLAY_STORAGE_KEY) ?? "{}",
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const preferences: Record<string, SidebarSectionDisplayMode> = {};
    for (const [sectionId, mode] of Object.entries(value)) {
      if (sectionId && (mode === "merged" || mode === "grouped")) preferences[sectionId] = mode;
    }
    return preferences;
  } catch {
    return {};
  }
}

export function readSectionDisplayMode(
  sectionId: string,
  storage: SidebarSectionDisplayStorage | null,
): SidebarSectionDisplayMode {
  return readPreferences(storage)[sectionId] ?? DEFAULT_SIDEBAR_SECTION_DISPLAY_MODE;
}

export function writeSectionDisplayMode(
  sectionId: string,
  mode: SidebarSectionDisplayMode,
  storage: SidebarSectionDisplayStorage | null,
): boolean {
  if (!sectionId) return false;
  try {
    const preferences = readPreferences(storage);
    preferences[sectionId] = mode;
    const entries = Object.entries(preferences).slice(-MAX_STORED_SECTIONS);
    storage?.setItem(
      SIDEBAR_SECTION_DISPLAY_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
    return true;
  } catch {
    return false;
  }
}

function compareThreads(
  left: { pinned: boolean; recency: number },
  right: { pinned: boolean; recency: number },
): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return right.recency - left.recency;
}

/**
 * Interleaves the native per-project rows while preserving each project's own
 * order. Only the head of each project competes, so a project's pinned rows and
 * its native sequence can never be split. Rows without catalog recency fall
 * below every known row of the same project, in their native order.
 */
export function mergeSidebarThreads(
  projects: readonly (readonly SidebarMergeThread[])[],
): string[] {
  const known: number[] = [];
  for (const project of projects) {
    for (const thread of project) {
      if (thread.recency !== null && Number.isFinite(thread.recency)) known.push(thread.recency);
    }
  }
  // Without any catalog timestamp there is nothing to compare across projects;
  // keeping the native project blocks is safer than an arbitrary interleave.
  if (known.length === 0) return projects.flatMap((project) => project.map((row) => row.threadId));
  const floor = Math.min(...known);
  const cursors = projects.map((project) => {
    let previous = floor;
    return project.map((thread) => {
      const recency =
        thread.recency !== null && Number.isFinite(thread.recency) ? thread.recency : previous - 1;
      previous = recency;
      return { threadId: thread.threadId, pinned: thread.pinned, recency };
    });
  });
  const positions = projects.map(() => 0);
  const merged: string[] = [];
  for (;;) {
    let bestIndex = -1;
    let bestRow: { threadId: string; pinned: boolean; recency: number } | null = null;
    for (let index = 0; index < cursors.length; index += 1) {
      const head = cursors[index]?.[positions[index] ?? 0];
      if (!head) continue;
      if (!bestRow || compareThreads(head, bestRow) < 0) {
        bestRow = head;
        bestIndex = index;
      }
    }
    if (!bestRow) return merged;
    merged.push(bestRow.threadId);
    positions[bestIndex] = (positions[bestIndex] ?? 0) + 1;
  }
}
