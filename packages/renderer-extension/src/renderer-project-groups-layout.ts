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

export interface ProjectGroupLayoutMember {
  projectId: string;
  label: string;
  machineName: string;
  kind: "local" | "remote";
}

export interface ProjectGroupLayoutGroup {
  id: string;
  name: string;
  collapsed: boolean;
  /** Members in the order they should appear inside the group. */
  members: readonly ProjectGroupLayoutMember[];
}

function escapeAttribute(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function cssString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\a ")
    .replaceAll("\r", "\\d ")}"`;
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

function memberUnitSelector(projectId: string): string {
  return `${projectsListSelector()} > div[role="listitem"]:has(${PROJECT_ROW_SELECTOR}[${PROJECT_ID_ATTRIBUTE}="${escapeAttribute(
    projectId,
  )}"])`;
}

function memberRowSelector(projectId: string): string {
  return `${memberUnitSelector(projectId)} ${PROJECT_ROW_SELECTOR}`;
}

/**
 * Turns a native project row into a machine subtitle without touching its DOM.
 * The row's own folder icon/name and the remote host label are hidden; the
 * dot and text are pseudo-elements. Native buttons stay in place.
 */
export function projectGroupSubtitleCss(
  group: ProjectGroupLayoutGroup,
  member: ProjectGroupLayoutMember,
): string[] {
  const row = memberRowSelector(member.projectId);
  const label =
    member.label === group.name ? member.machineName : `${member.machineName} · ${member.label}`;
  return [
    `${row} { position: relative !important; height: 24px !important; min-height: 24px !important; font-size: 11px; color: var(--color-text-secondary, #8b8b8b); }`,
    `${row} > div:first-child { display: none !important; }`,
    `${row} > div:nth-child(2) { margin-left: auto !important; }`,
    `${row} > div:nth-child(2) div[role="presentation"] > div:last-child > div:first-child { display: none !important; }`,
    `${row}::before { content: "●"; position: absolute; left: 14px; top: 50%; transform: translateY(-50%); font-size: 8px; line-height: 1; color: var(--color-text-tertiary, #8b8b8b); }`,
    `${row}::after { content: ${cssString(label)}; position: absolute; left: 26px; right: 72px; top: 50%; transform: translateY(-50%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 1; color: var(--color-text-secondary, #8b8b8b); }`,
    `${row}:has([data-sidebar-project-kind="local"])::before { color: var(--color-chart-green, #3fb950); }`,
    `${row}:has(.text-chart-green)::before { color: var(--color-chart-green, #3fb950); }`,
    `${row}:has(.text-chart-yellow)::before, ${row}:has(.text-chart-orange)::before { color: var(--color-chart-yellow, #d29922); }`,
    `${row}:has(.text-chart-red)::before, ${row}:has(.text-chart-danger)::before { color: var(--color-chart-red, #f85149); }`,
  ];
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
    group.members.forEach((member, memberIndex) => {
      if (seen.has(member.projectId)) return;
      seen.add(member.projectId);
      const scope = memberUnitSelector(member.projectId);
      const order = projectGroupMemberOrder(groupIndex, memberIndex);
      lines.push(
        group.collapsed
          ? `${scope} { order: ${order}; margin-left: ${MEMBER_INDENT}; display: none !important; }`
          : `${scope} { order: ${order}; margin-left: ${MEMBER_INDENT}; }`,
      );
      lines.push(...projectGroupSubtitleCss(group, member));
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
