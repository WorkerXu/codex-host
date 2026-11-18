/** The section-header control that switches the section between native and merged display. */

import { SIDEBAR_THREAD_ROW_ATTRIBUTE } from "./renderer-sidebar-sections-dom.js";
import { SECTION_DISPLAY_TOGGLE_ATTRIBUTE } from "./renderer-sidebar-sections-layout.js";

export const SECTION_DISPLAY_LABEL = "显示项目分组";

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
