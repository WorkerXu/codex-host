/**
 * Shared chrome for the two-step Jarvis panel: header, search field, chip row,
 * summary and the single scrolling result area.
 *
 * Colors are Desktop tokens with explicit fallbacks. Interaction states live in
 * one scoped stylesheet so hover and focus match the native `@` menu instead of
 * being approximated per element.
 */
import { keepEditorFocusOnPress } from "./renderer-native-at-menu.js";
import { createJarvisMark } from "./settings/jarvis-icon.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

export const JARVIS_SECTION_ATTRIBUTE = "data-codexhost-jarvis-section";
export const JARVIS_MODE_ATTRIBUTE = "data-codexhost-jarvis-mode";
export const JARVIS_STEP_ATTRIBUTE = "data-codexhost-jarvis-step";
export const JARVIS_PANEL_STYLE_ATTRIBUTE = "data-codexhost-jarvis-style";

export const TEXT_PRIMARY = "var(--color-token-text-primary, #0d0d0d)";
export const TEXT_TERTIARY =
  "var(--color-text-tertiary, var(--color-token-text-tertiary, rgba(13, 13, 13, 0.5)))";
export const BORDER = "var(--color-token-border-default, rgba(13, 13, 13, 0.08))";
export const HOVER = "var(--color-token-interactive-bg-secondary-hover, rgba(127, 127, 127, 0.08))";
export const SELECTED_BG =
  "var(--color-token-interactive-bg-secondary-active, rgba(127, 127, 127, 0.14))";
export const FOCUS_BORDER = "var(--color-token-focus-border, #0a84ff)";
export const ORANGE = "var(--color-chart-orange, #fb6a22)";
export const GREEN = "var(--color-chart-green, #04b84c)";
export const RED = "var(--color-chart-red, #fa423e)";

export const ROW_MIN_HEIGHT = "48px";
export const ROW_PADDING_X = "12px";

export function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
}

export function textSpan(
  document: Document,
  value: string,
  values: Record<string, string> = {},
): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = value;
  style(span, {
    "min-width": "0",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
    ...values,
  });
  return span;
}

/** Focus and hover styling that inline styles cannot express. */
export function ensureJarvisPanelStyle(document: Document): void {
  if (!document.head || document.querySelector(`[${JARVIS_PANEL_STYLE_ATTRIBUTE}]`)) return;
  const sheet = document.createElement("style");
  sheet.setAttribute(JARVIS_PANEL_STYLE_ATTRIBUTE, "true");
  sheet.textContent = `
[data-codexhost-jarvis-section] [data-jarvis-control]:focus-visible {
  outline: 2px solid ${FOCUS_BORDER};
  outline-offset: 1px;
}
[data-codexhost-jarvis-section] [data-jarvis-control]:hover {
  background: ${HOVER};
}
[data-codexhost-jarvis-section] [data-jarvis-chip][aria-pressed="true"] {
  background: ${SELECTED_BG};
  color: ${TEXT_PRIMARY};
  border-color: transparent;
}
`;
  document.head.append(sheet);
}

export interface JarvisStepChrome {
  section: HTMLElement;
  back: HTMLButtonElement;
  input: HTMLInputElement;
  clear: HTMLButtonElement;
  chips: HTMLElement;
  listLabel: HTMLElement;
  summary: HTMLElement;
  results: HTMLElement;
}

export interface JarvisStepChromeOptions {
  step: "project" | "bug";
  subtitle: string;
  placeholder: string;
  /** Empty hides the label row, used when the project chip already names it. */
  listLabel: string;
  /** Bug step owns a permanent chip row for the project and filters. */
  withChips: boolean;
}

/** Header, focused search field, optional chips, list label, summary, results. */
export function createJarvisStepChrome(
  document: Document,
  locale: RendererSettingsLocale,
  options: JarvisStepChromeOptions,
): JarvisStepChrome {
  ensureJarvisPanelStyle(document);
  const section = document.createElement("div");
  section.setAttribute(JARVIS_SECTION_ATTRIBUTE, "true");
  section.setAttribute(JARVIS_STEP_ATTRIBUTE, options.step);
  style(section, {
    display: "flex",
    "flex-direction": "column",
    width: "100%",
    "min-height": "0",
    "max-height": "100%",
    flex: "1 1 auto",
    color: TEXT_PRIMARY,
    "font-family": "system-ui, -apple-system, sans-serif",
  });

  const header = document.createElement("div");
  style(header, {
    display: "flex",
    "align-items": "center",
    gap: "6px",
    "flex-shrink": "0",
    padding: "8px 12px",
    "border-bottom": `1px solid ${BORDER}`,
  });
  const back = document.createElement("button");
  back.type = "button";
  back.setAttribute("data-jarvis-control", "true");
  back.setAttribute("aria-label", locale === "zh-CN" ? "返回" : "Back");
  back.style.cssText =
    "display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;" +
    "border:0;border-radius:6px;background:transparent;color:inherit;font:400 18px/1 system-ui,sans-serif;" +
    "cursor:pointer;flex:0 0 auto;padding:0";
  back.textContent = "‹";
  keepEditorFocusOnPress(back);
  const mark = createJarvisMark(document, 16);
  mark.style.flex = "0 0 auto";
  const title = document.createElement("span");
  title.textContent = "Jarvis";
  style(title, { color: TEXT_PRIMARY, font: "600 13px/18px system-ui, sans-serif" });
  const separator = document.createElement("span");
  separator.textContent = "·";
  style(separator, { color: TEXT_TERTIARY, font: "400 13px/18px system-ui, sans-serif" });
  const subtitle = document.createElement("span");
  subtitle.textContent = options.subtitle;
  style(subtitle, { color: TEXT_TERTIARY, font: "400 13px/18px system-ui, sans-serif" });
  header.append(back, mark, title, separator, subtitle);

  const searchWrap = document.createElement("div");
  style(searchWrap, {
    position: "relative",
    display: "flex",
    "flex-shrink": "0",
    padding: "8px 12px",
  });
  const input = document.createElement("input");
  // A text input avoids the heavy UA clear button of `type=search`.
  input.type = "text";
  input.setAttribute("data-jarvis-control", "true");
  input.placeholder = options.placeholder;
  input.maxLength = 200;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.value = "";
  style(input, {
    width: "100%",
    "min-width": "0",
    height: "30px",
    padding: "0 28px 0 8px",
    border: `1px solid ${BORDER}`,
    "border-radius": "6px",
    background: "transparent",
    color: TEXT_PRIMARY,
    font: "400 13px/18px system-ui, sans-serif",
    outline: "none",
    "box-sizing": "border-box",
  });
  const clear = document.createElement("button");
  clear.type = "button";
  clear.style.display = "none";
  clear.setAttribute("data-jarvis-clear", "true");
  clear.setAttribute("data-jarvis-control", "true");
  clear.setAttribute("aria-label", locale === "zh-CN" ? "清除" : "Clear");
  clear.style.cssText =
    "position:absolute;right:20px;top:50%;transform:translateY(-50%);" +
    "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;" +
    "border:0;border-radius:4px;background:transparent;color:" +
    TEXT_TERTIARY +
    ";cursor:pointer;padding:0";
  const clearIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  clearIcon.setAttribute("viewBox", "0 0 12 12");
  clearIcon.setAttribute("width", "12");
  clearIcon.setAttribute("height", "12");
  clearIcon.setAttribute("fill", "none");
  clearIcon.setAttribute("stroke", "currentColor");
  clearIcon.setAttribute("stroke-width", "1.25");
  clearIcon.setAttribute("stroke-linecap", "round");
  clearIcon.setAttribute("aria-hidden", "true");
  const clearPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  clearPath.setAttribute("d", "M3 3l6 6M9 3l-6 6");
  clearIcon.append(clearPath);
  clear.append(clearIcon);
  keepEditorFocusOnPress(clear);
  searchWrap.append(input, clear);

  const chips = document.createElement("div");
  style(chips, {
    display: "flex",
    "flex-wrap": "wrap",
    gap: "4px",
    "flex-shrink": "0",
    padding: "0 12px 8px",
  });
  chips.hidden = !options.withChips;

  const listLabel = document.createElement("div");
  listLabel.setAttribute("data-jarvis-list-label", "true");
  listLabel.textContent = options.listLabel;
  style(listLabel, {
    "flex-shrink": "0",
    padding: "0 12px 4px",
    color: TEXT_TERTIARY,
    font: "500 11px/16px system-ui, sans-serif",
    "letter-spacing": "0.02em",
  });
  listLabel.hidden = options.listLabel.length === 0;

  const summary = document.createElement("div");
  summary.setAttribute("data-jarvis-summary", "true");
  summary.setAttribute("role", "status");
  style(summary, {
    "flex-shrink": "0",
    padding: "0 12px 6px",
    color: TEXT_TERTIARY,
    font: "400 12px/16px system-ui, sans-serif",
  });

  const results = document.createElement("div");
  style(results, {
    display: "flex",
    "flex-direction": "column",
    gap: "2px",
    flex: "1 1 auto",
    "min-height": "0",
    overflow: "hidden",
    padding: "0 6px 6px",
  });
  // Results inside the panel are the only scrolling surface; the panel itself
  // grows upward from the Composer and stops at the available space.
  const scroller = document.createElement("div");
  scroller.setAttribute("data-jarvis-results", "true");
  scroller.setAttribute("role", "listbox");
  style(scroller, {
    display: "flex",
    "flex-direction": "column",
    gap: "2px",
    flex: "1 1 auto",
    "min-height": "0",
    "overflow-y": "auto",
    "overscroll-behavior": "contain",
  });
  results.append(scroller);

  section.append(header, searchWrap, chips, listLabel, summary, results);
  return { section, back, input, clear, chips, listLabel, summary, results };
}

/** The scrollable list that owns result rows. */
export function jarvisResultsScroller(results: HTMLElement): HTMLElement {
  return results.querySelector<HTMLElement>('[data-jarvis-results="true"]') ?? results;
}

/** Three placeholder rows while a Host call is running. */
export function renderJarvisLoading(document: Document, results: HTMLElement): void {
  const scroller = jarvisResultsScroller(results);
  scroller.replaceChildren();
  scroller.scrollTop = 0;
  for (let index = 0; index < 3; index += 1) {
    const row = document.createElement("div");
    style(row, {
      display: "flex",
      "align-items": "center",
      gap: "10px",
      "min-height": ROW_MIN_HEIGHT,
      padding: `6px ${ROW_PADDING_X}`,
      "pointer-events": "none",
    });
    row.setAttribute("data-codexhost-jarvis-skeleton", "true");
    row.setAttribute("aria-hidden", "true");
    const content = document.createElement("div");
    style(content, {
      display: "flex",
      "flex-direction": "column",
      gap: "6px",
      width: "100%",
    });
    const first = document.createElement("div");
    style(first, {
      height: "10px",
      width: "64%",
      "border-radius": "4px",
      background: HOVER,
    });
    const second = document.createElement("div");
    style(second, {
      height: "8px",
      width: "36%",
      "border-radius": "4px",
      background: HOVER,
      opacity: "0.6",
    });
    content.append(first, second);
    row.append(content);
    scroller.append(row);
  }
}

export interface JarvisMessageAction {
  label: string;
  onClick(opener: HTMLElement): void;
}

/** Empty and error states share one calm, native-density block. */
export function renderJarvisMessage(
  document: Document,
  results: HTMLElement,
  message: string,
  action?: JarvisMessageAction,
): void {
  const scroller = jarvisResultsScroller(results);
  scroller.replaceChildren();
  scroller.scrollTop = 0;
  const empty = document.createElement("div");
  empty.setAttribute("data-jarvis-message", "true");
  style(empty, {
    padding: "14px 12px 10px",
    color: TEXT_PRIMARY,
    font: "400 13px/20px system-ui, sans-serif",
    "white-space": "normal",
  });
  const messageText = document.createElement("span");
  messageText.textContent = message;
  empty.append(messageText);
  if (action) {
    const link = document.createElement("button");
    link.type = "button";
    link.setAttribute("data-jarvis-action", "true");
    link.textContent = action.label;
    link.style.cssText =
      "margin-left:8px;border:0;background:transparent;color:" +
      TEXT_TERTIARY +
      ";font:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer;padding:0";
    keepEditorFocusOnPress(link);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action.onClick(link);
    });
    empty.append(link);
  }
  scroller.append(empty);
}
