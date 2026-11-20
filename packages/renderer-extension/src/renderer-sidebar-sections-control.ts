/** The section-header control that switches the section between native and merged display. */

import {
  MERGED_MORE_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_ATTRIBUTE,
  type SidebarSectionPaginationToggle,
} from "./renderer-sidebar-sections-dom.js";
import {
  MERGE_HIDDEN_ATTRIBUTE,
  SECTION_DISPLAY_TOGGLE_ATTRIBUTE,
} from "./renderer-sidebar-sections-layout.js";

export const SECTION_DISPLAY_LABEL = "显示项目分组";
export const MERGED_MORE_EXPAND_LABEL = "展开显示";
export const MERGED_MORE_COLLAPSE_LABEL = "收起";

const ICON_PATHS = [
  "M21 12h-8",
  "M21 6H8",
  "M21 18h-8",
  "M3 6v4c0 1.1.9 2 2 2h3",
  "M3 10v6c0 1.1.9 2 2 2h3",
];

function listTreeIcon(document: Document): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  for (const [name, value] of Object.entries({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.75",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(name, value);
  }
  for (const definition of ICON_PATHS) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", definition);
    svg.append(path);
  }
  return svg;
}

export function createSectionDisplayToggle(
  document: Document,
  pressed: boolean,
  onToggle: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(SECTION_DISPLAY_TOGGLE_ATTRIBUTE, "");
  button.setAttribute("aria-pressed", String(pressed));
  button.setAttribute("aria-label", SECTION_DISPLAY_LABEL);
  button.title = SECTION_DISPLAY_LABEL;
  button.append(listTreeIcon(document));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle();
  });
  return button;
}

function sectionHeaderMenuTrigger(section: HTMLElement): HTMLButtonElement | null {
  const buttons = section.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]');
  for (const button of buttons) {
    if (!button.closest(`[${SIDEBAR_THREAD_ROW_ATTRIBUTE}]`)) return button;
  }
  return null;
}

/** Places the control beside the native header actions; false keeps the section native. */
export function placeSectionDisplayToggle(
  section: HTMLElement,
  button: HTMLButtonElement,
): boolean {
  const cluster = sectionHeaderMenuTrigger(section)?.parentElement;
  if (!cluster) return false;
  if (button.parentElement !== cluster) cluster.append(button);
  return true;
}

export interface MergedMoreControl {
  container: HTMLElement;
  setLabel(label: string): void;
}

export function setMergedMoreLabel(container: HTMLElement, label: string): void {
  const button = container.querySelector("button");
  if (!button) return;
  const target = [...button.querySelectorAll("span")].find(
    (span) => span.children.length === 0 && Boolean(span.textContent?.trim()),
  );
  if (target) target.textContent = label;
  else if (button.children.length === 0) button.textContent = label;
}

/** Clones the native expand/collapse row so the merged control keeps Desktop's look. */
export function createMergedMoreControl(
  template: SidebarSectionPaginationToggle,
  label: string,
  onActivate: () => void,
): MergedMoreControl | null {
  const container = template.container.cloneNode(true) as HTMLElement;
  if (!(container instanceof HTMLElement)) return null;
  container.removeAttribute(MERGE_HIDDEN_ATTRIBUTE);
  for (const element of container.querySelectorAll(`[${MERGE_HIDDEN_ATTRIBUTE}]`)) {
    element.removeAttribute(MERGE_HIDDEN_ATTRIBUTE);
  }
  container.setAttribute(MERGED_MORE_ATTRIBUTE, "");
  const button = container.querySelector("button");
  if (!button) return null;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  });
  setMergedMoreLabel(container, label);
  return { container, setLabel: (value) => setMergedMoreLabel(container, value) };
}
