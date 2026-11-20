/**
 * Project rows for the first step of the Jarvis panel.
 *
 * The controller owns requests and keyboard state; this module only creates
 * the one-line rows that sit in the shared panel chrome.
 */
import createElement from "lucide/dist/esm/createElement.mjs";
import ChevronRight from "lucide/dist/esm/icons/chevron-right.mjs";
import Folder from "lucide/dist/esm/icons/folder.mjs";

import type { JarvisProject } from "@codexhost/shared-contracts";

import {
  ROW_PADDING_X,
  TEXT_PRIMARY,
  TEXT_TERTIARY,
  jarvisResultsScroller,
  style,
  textSpan,
} from "./renderer-jarvis-panel-view.js";

export const JARVIS_PROJECT_ROW_ATTRIBUTE = "data-codexhost-jarvis-project";

export interface JarvisProjectRowHandlers {
  onSelect(index: number): void;
  onChoose(project: JarvisProject): void;
}

/** One line per project; the chevron signals that selecting it opens bugs. */
export function renderJarvisProjectRows(
  document: Document,
  results: HTMLElement,
  projects: readonly JarvisProject[],
  handlers: JarvisProjectRowHandlers,
): { project: JarvisProject; row: HTMLElement }[] {
  const scroller = jarvisResultsScroller(results);
  scroller.replaceChildren();
  scroller.scrollTop = 0;
  const entries: { project: JarvisProject; row: HTMLElement }[] = [];
  projects.forEach((project, index) => {
    const row = document.createElement("div");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.setAttribute(JARVIS_PROJECT_ROW_ATTRIBUTE, String(project.id));
    style(row, {
      display: "flex",
      "align-items": "center",
      gap: "10px",
      width: "100%",
      "min-height": "44px",
      padding: `6px ${ROW_PADDING_X}`,
      "box-sizing": "border-box",
      "border-radius": "8px",
      background: "transparent",
      cursor: "pointer",
      "text-align": "left",
    });

    const icon = createElement(Folder, {
      width: 16,
      height: 16,
      "aria-hidden": "true",
      focusable: "false",
      "stroke-width": 1.8,
    }) as SVGElement;
    icon.style.color = TEXT_TERTIARY;
    icon.style.flex = "0 0 auto";
    icon.style.margin = "0 2px";

    const name = textSpan(document, project.name, {
      color: TEXT_PRIMARY,
      font: "500 13px/18px system-ui, sans-serif",
      flex: "1 1 auto",
    });
    const chevron = createElement(ChevronRight, {
      width: 14,
      height: 14,
      "aria-hidden": "true",
      focusable: "false",
      "stroke-width": 1.8,
    }) as SVGElement;
    chevron.style.color = TEXT_TERTIARY;
    chevron.style.flex = "0 0 auto";

    row.append(icon, name, chevron);
    row.addEventListener("pointermove", (event) => {
      event.stopPropagation();
      handlers.onSelect(index);
    });
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handlers.onChoose(project);
    });
    entries.push({ project, row });
    scroller.append(row);
  });
  return entries;
}
