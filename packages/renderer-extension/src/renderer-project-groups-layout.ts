import {
  PROJECTS_SECTION_SELECTOR,
  PROJECT_ID_ATTRIBUTE,
  PROJECT_ROW_SELECTOR,
} from "./renderer-project-groups-dom.js";

/** Native items that are not part of any group keep their document order below groups. */
export const PROJECT_GROUP_NON_MEMBER_ORDER = 1_000_000;
const GROUP_ORDER_SPAN = 1_000;
const MEMBER_ORDER_OFFSET = 10;
const PLACEHOLDER_ORDER_OFFSET = 900;
const CREATE_ORDER_OFFSET = 950;
const MEMBER_INDENT = "12px";

export interface ProjectGroupLayoutGroup {
  id: string;
  collapsed: boolean;
  /** Native project IDs in the order they should appear inside the group. */
  projectIds: readonly string[];
}

function escapeAttribute(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function projectGroupHeaderOrder(groupIndex: number): number {
  return groupIndex * GROUP_ORDER_SPAN;
}

export function projectGroupMemberOrder(groupIndex: number, memberIndex: number): number {
  return groupIndex * GROUP_ORDER_SPAN + MEMBER_ORDER_OFFSET + memberIndex;
}

export function projectGroupPlaceholderOrder(groupIndex: number): number {
  return groupIndex * GROUP_ORDER_SPAN + PLACEHOLDER_ORDER_OFFSET;
}

export function projectGroupCreateOrder(groupCount: number): number {
  return Math.max(0, groupCount - 1) * GROUP_ORDER_SPAN + CREATE_ORDER_OFFSET;
}

/**
 * The native Projects list is a flex column. Groups reorder their member
 * listitems with `order` and add a small left indent; every native node keeps
 * its React identity, handlers and children.
 */
export function projectsListSelector(): string {
  return `${PROJECTS_SECTION_SELECTOR} div[role="list"]:has(> div[role="listitem"] ${PROJECT_ROW_SELECTOR})`;
}

export function projectGroupLayoutCss(groups: readonly ProjectGroupLayoutGroup[]): string {
  if (groups.length === 0) return "";
  const list = projectsListSelector();
  const lines = [
    `${list} { display: flex; flex-direction: column; }`,
    `${list} > div[role="listitem"] { order: ${PROJECT_GROUP_NON_MEMBER_ORDER}; }`,
  ];
  const seen = new Set<string>();
  groups.forEach((group, groupIndex) => {
    group.projectIds.forEach((projectId, memberIndex) => {
      if (seen.has(projectId)) return;
      seen.add(projectId);
      const scope = `${list} > div[role="listitem"]:has(${PROJECT_ROW_SELECTOR}[${PROJECT_ID_ATTRIBUTE}="${escapeAttribute(
        projectId,
      )}"])`;
      const order = projectGroupMemberOrder(groupIndex, memberIndex);
      lines.push(
        group.collapsed
          ? `${scope} { order: ${order}; margin-left: ${MEMBER_INDENT}; display: none !important; }`
          : `${scope} { order: ${order}; margin-left: ${MEMBER_INDENT}; }`,
      );
    });
  });
  return lines.join("\n");
}

/** Owns the single stylesheet that reorders the native Projects list. */
export class ProjectGroupLayoutStyle {
  readonly #document: Document;
  #element: HTMLStyleElement | null = null;

  constructor(document: Document) {
    this.#document = document;
  }

  apply(groups: readonly ProjectGroupLayoutGroup[]): void {
    const css = projectGroupLayoutCss(groups);
    if (!css) {
      this.clear();
      return;
    }
    if (!this.#element) {
      this.#element = this.#document.createElement("style");
      this.#element.setAttribute("data-codexhost-project-groups", "");
      (this.#document.head ?? this.#document.documentElement).append(this.#element);
    }
    if (this.#element.textContent !== css) this.#element.textContent = css;
  }

  clear(): void {
    this.#element?.remove();
    this.#element = null;
  }

  dispose(): void {
    this.clear();
  }
}
