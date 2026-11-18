/**
 * Layout marks for the merged section view.
 *
 * Every mark lives on a native Desktop node. `display: contents` removes the
 * intermediate project wrappers from layout, so the untouched conversation rows
 * become flex items of the section list and can be reordered with `order`.
 */

import type { SidebarSectionSnapshot } from "./renderer-sidebar-sections-dom.js";

export const MERGED_SECTION_ATTRIBUTE = "data-codexhost-merged-section";
export const MERGED_SECTION_STATE_ATTRIBUTE = "data-codexhost-merged-state";
export const MERGE_LIST_ATTRIBUTE = "data-codexhost-merge-list";
export const MERGE_FLATTEN_ATTRIBUTE = "data-codexhost-merge-flatten";
export const MERGE_HIDDEN_ATTRIBUTE = "data-codexhost-merge-hidden";
export const MERGE_ORDER_ATTRIBUTE = "data-codexhost-merge-order";
export const SECTION_DISPLAY_TOGGLE_ATTRIBUTE = "data-codexhost-section-display-toggle";
export const SECTION_DISPLAY_STYLE_ATTRIBUTE = "data-codexhost-sidebar-sections-style";

const MARKED_ATTRIBUTES = [
  MERGE_LIST_ATTRIBUTE,
  MERGE_FLATTEN_ATTRIBUTE,
  MERGE_HIDDEN_ATTRIBUTE,
  MERGE_ORDER_ATTRIBUTE,
];

/** Applies the flatten/hide/order marks for one section snapshot. */
export function applyMergeMarks(
  snapshot: SidebarSectionSnapshot,
  orderByRow: ReadonlyMap<HTMLElement, number>,
): void {
  snapshot.container.setAttribute(MERGED_SECTION_ATTRIBUTE, snapshot.sectionId);
  snapshot.list.setAttribute(MERGE_LIST_ATTRIBUTE, "");
  for (const project of snapshot.projects) {
    project.container.setAttribute(MERGE_FLATTEN_ATTRIBUTE, "");
    for (const hidden of project.hidden) hidden.setAttribute(MERGE_HIDDEN_ATTRIBUTE, "");
    for (const row of project.rows) {
      const order = orderByRow.get(row.element);
      if (order !== undefined) row.element.setAttribute(MERGE_ORDER_ATTRIBUTE, String(order));
      let ancestor = row.element.parentElement;
      while (ancestor && ancestor !== snapshot.list) {
        ancestor.setAttribute(MERGE_FLATTEN_ATTRIBUTE, "");
        ancestor = ancestor.parentElement;
      }
    }
  }
}

export function clearMergeMarks(container: HTMLElement): void {
  container.removeAttribute(MERGED_SECTION_ATTRIBUTE);
  container.removeAttribute(MERGED_SECTION_STATE_ATTRIBUTE);
  for (const attribute of MARKED_ATTRIBUTES) {
    if (container.hasAttribute(attribute)) container.removeAttribute(attribute);
    for (const element of container.querySelectorAll(`[${attribute}]`)) {
      element.removeAttribute(attribute);
    }
  }
}

export function sectionDisplayToggleCss(): string {
  return [
    `[${SECTION_DISPLAY_TOGGLE_ATTRIBUTE}] {`,
    "  width: 24px;",
    "  height: 24px;",
    "  flex: 0 0 auto;",
    "  display: inline-flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  padding: 0;",
    "  border: 0;",
    "  border-radius: 6px;",
    "  background: transparent;",
    "  color: var(--color-text-tertiary, #8b8b8b);",
    "  cursor: default;",
    "}",
    `[${SECTION_DISPLAY_TOGGLE_ATTRIBUTE}]:hover {`,
    "  background: var(--color-background-secondary-ghost-hover, rgba(127, 127, 127, 0.12));",
    "  color: var(--color-text, currentColor);",
    "}",
    `[${SECTION_DISPLAY_TOGGLE_ATTRIBUTE}][aria-pressed="true"] {`,
    "  color: var(--color-text, currentColor);",
    "}",
    `[${SECTION_DISPLAY_TOGGLE_ATTRIBUTE}]:focus-visible {`,
    "  outline: 2px solid var(--color-ring, #5b9dff);",
    "  outline-offset: 0;",
    "}",
  ].join("\n");
}

/** Global rules; every selector only matches marks this extension wrote. */
export function mergeStyleCss(maxOrder: number): string {
  const lines = [
    sectionDisplayToggleCss(),
    `[${MERGE_LIST_ATTRIBUTE}] {`,
    "  display: flex !important;",
    "  flex-direction: column !important;",
    "  gap: 1px;",
    "}",
    `[${MERGE_FLATTEN_ATTRIBUTE}] { display: contents !important; }`,
    `[${MERGE_FLATTEN_ATTRIBUTE}]::before, [${MERGE_FLATTEN_ATTRIBUTE}]::after {`,
    "  content: none !important;",
    "  display: none !important;",
    "}",
    `[${MERGE_HIDDEN_ATTRIBUTE}] { display: none !important; }`,
  ];
  for (let order = 0; order <= maxOrder; order += 1) {
    lines.push(`[${MERGE_ORDER_ATTRIBUTE}="${order}"] { order: ${order}; }`);
  }
  return lines.join("\n");
}

/** Owns the single stylesheet shared by every merged section. */
export class SidebarSectionsStyle {
  readonly #document: Document;
  #element: HTMLStyleElement | null = null;

  constructor(document: Document) {
    this.#document = document;
  }

  apply(css: string): void {
    if (!css) {
      this.clear();
      return;
    }
    if (!this.#element) {
      this.#element = this.#document.createElement("style");
      this.#element.setAttribute(SECTION_DISPLAY_STYLE_ATTRIBUTE, "");
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
