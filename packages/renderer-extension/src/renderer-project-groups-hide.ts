import { findProjectsSection, projectUnitForId } from "./renderer-project-groups-dom.js";

const HIDDEN_ATTRIBUTE = "data-codexhost-project-group-hidden";

function escapeAttribute(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function projectGroupHideCss(projectIds: readonly string[]): string {
  return [...new Set(projectIds)]
    .map(
      (projectId) =>
        `section[data-app-action-sidebar-section][data-app-action-sidebar-section-heading="Projects"] div[role="list"] > div[role="listitem"]:has([data-app-action-sidebar-project-row][data-app-action-sidebar-project-id="${escapeAttribute(
          projectId,
        )}"]) { display: none !important; }`,
    )
    .join("\n");
}

/**
 * Hides native project units with a stylesheet only. The React tree and the
 * project's expanded/collapsed state stay intact; deleting the stylesheet
 * restores the native list immediately.
 */
export class ProjectGroupHider {
  readonly #document: Document;
  readonly #supportsHas: boolean;
  #style: HTMLStyleElement | null = null;
  #fallbackIds = new Set<string>();

  constructor(document: Document, supportsHas?: boolean) {
    this.#document = document;
    this.#supportsHas =
      supportsHas ??
      (typeof CSS !== "undefined" && typeof CSS.supports === "function"
        ? CSS.supports("selector(:has(*))")
        : false);
  }

  apply(section: HTMLElement | null, projectIds: readonly string[]): void {
    this.clear();
    if (!section || projectIds.length === 0) return;
    const unique = [...new Set(projectIds)];
    if (this.#supportsHas) {
      this.#style = this.#document.createElement("style");
      this.#style.setAttribute("data-codexhost-project-groups", "");
      this.#style.textContent = projectGroupHideCss(unique);
      (this.#document.head ?? this.#document.documentElement).append(this.#style);
      return;
    }

    this.#style = this.#document.createElement("style");
    this.#style.setAttribute("data-codexhost-project-groups", "");
    this.#style.textContent = `[${HIDDEN_ATTRIBUTE}="true"] { display: none !important; }`;
    (this.#document.head ?? this.#document.documentElement).append(this.#style);
    for (const projectId of unique) {
      const unit = projectUnitForId(section, projectId);
      if (!unit) continue;
      unit.setAttribute(HIDDEN_ATTRIBUTE, "true");
      this.#fallbackIds.add(projectId);
    }
  }

  clear(): void {
    this.#style?.remove();
    this.#style = null;
    if (this.#fallbackIds.size === 0) return;
    const section = findProjectsSection(this.#document);
    for (const projectId of this.#fallbackIds) {
      if (!section) break;
      projectUnitForId(section, projectId)?.removeAttribute(HIDDEN_ATTRIBUTE);
    }
    for (const element of this.#document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`))
      element.removeAttribute(HIDDEN_ATTRIBUTE);
    this.#fallbackIds.clear();
  }

  dispose(): void {
    this.clear();
  }
}
