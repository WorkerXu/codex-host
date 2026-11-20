/**
 * View builders for the Jarvis `@` row and its bug step.
 *
 * These functions only create DOM. The controller in
 * `renderer-jarvis-mention.ts` owns state, requests, hosting and keyboard
 * handling. Every color is a Desktop token with an explicit fallback so the
 * panel still renders when a token is absent from the current Desktop theme.
 */
import createElement from "lucide/dist/esm/createElement.mjs";
import Bug from "lucide/dist/esm/icons/bug.mjs";

import type { JarvisBug, JarvisBugCondition, JarvisProject } from "@codexhost/shared-contracts";

import {
  createWorkbenchRow,
  createWorkbenchSection,
  keepEditorFocusOnPress,
} from "./renderer-native-at-menu.js";
import {
  BORDER,
  GREEN,
  HOVER,
  ORANGE,
  ROW_MIN_HEIGHT,
  ROW_PADDING_X,
  RED,
  TEXT_PRIMARY,
  TEXT_TERTIARY,
  jarvisResultsScroller,
  style,
  textSpan,
} from "./renderer-jarvis-panel-view.js";
import { createJarvisMark } from "./settings/jarvis-icon.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

export const JARVIS_ENTRY_ROW_ATTRIBUTE = "data-codexhost-jarvis-entry-row";
export const JARVIS_BUG_ROW_ATTRIBUTE = "data-codexhost-jarvis-bug";
export const JARVIS_PROJECT_CHIP_ATTRIBUTE = "data-jarvis-project-chip";
export const JARVIS_SEARCH_PLACEHOLDER = "搜索 Bug 标题";

export function truncateJarvisText(value: string, limit: number): string {
  const text = value.trim().replace(/\s+/gu, " ");
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text;
}

/** Chip and row label, e.g. `Bug #9101 示例：列表页加载失败…`. */
export function jarvisBugLabel(bug: Pick<JarvisBug, "id" | "title">): string {
  return `Bug #${bug.id} ${truncateJarvisText(bug.title, 28)}`;
}

export function jarvisStatusText(
  status: number | undefined,
  locale: RendererSettingsLocale,
): string {
  if (status === undefined) return "";
  const labels =
    locale === "zh-CN"
      ? ({ 1: "未解决", 2: "已解决", 3: "已关闭" } as Record<number, string>)
      : ({ 1: "Open", 2: "Resolved", 3: "Closed" } as Record<number, string>);
  return labels[status] ?? (locale === "zh-CN" ? `状态 ${status}` : `Status ${status}`);
}

export function jarvisPriorityText(
  priority: number | undefined,
  locale: RendererSettingsLocale,
): string {
  if (priority === undefined) return "";
  const labels =
    locale === "zh-CN"
      ? ({ 1: "高优先级", 2: "中优先级", 3: "低优先级" } as Record<number, string>)
      : ({ 1: "High priority", 2: "Medium priority", 3: "Low priority" } as Record<number, string>);
  return labels[priority] ?? (locale === "zh-CN" ? `优先级 ${priority}` : `Priority ${priority}`);
}

export function jarvisSeverityText(
  severity: number | undefined,
  locale: RendererSettingsLocale,
): string {
  if (severity === undefined) return "";
  const labels =
    locale === "zh-CN"
      ? ({ 1: "致命", 2: "严重", 3: "一般", 4: "低" } as Record<number, string>)
      : ({ 1: "Critical", 2: "Major", 3: "Minor", 4: "Trivial" } as Record<number, string>);
  return labels[severity] ?? (locale === "zh-CN" ? `严重程度 ${severity}` : `Severity ${severity}`);
}

/** Relative update time; older values fall back to a short calendar date. */
export function jarvisRelativeTime(
  value: string | undefined,
  locale: RendererSettingsLocale,
  now = Date.now(),
): string {
  if (!value) return "";
  const at = Date.parse(value.replace(" ", "T"));
  if (!Number.isFinite(at)) return "";
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return locale === "zh-CN" ? "刚刚" : "just now";
  if (diff < hour) {
    const count = Math.floor(diff / minute);
    return locale === "zh-CN" ? `${count} 分钟前` : `${count} min ago`;
  }
  if (diff < day) {
    const count = Math.floor(diff / hour);
    return locale === "zh-CN" ? `${count} 小时前` : `${count} h ago`;
  }
  if (diff < 30 * day) {
    const count = Math.floor(diff / day);
    return locale === "zh-CN" ? `${count} 天前` : `${count} d ago`;
  }
  const date = new Date(at);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function statusColor(status: number | undefined): string {
  if (status === 1) return ORANGE;
  if (status === 2) return GREEN;
  return TEXT_TERTIARY;
}

function priorityColor(priority: number | undefined): string {
  if (priority === 1) return RED;
  if (priority === 2) return ORANGE;
  return TEXT_TERTIARY;
}

function bugIcon(document: Document, color: string): SVGElement {
  const icon = createElement(Bug, {
    width: 16,
    height: 16,
    "aria-hidden": "true",
    focusable: "false",
    "stroke-width": 1.8,
  }) as SVGElement;
  icon.style.color = color;
  icon.style.flex = "0 0 auto";
  return icon;
}

function statusPill(document: Document, label: string, color: string): HTMLSpanElement {
  const pill = document.createElement("span");
  pill.setAttribute("data-jarvis-status", "");
  pill.textContent = label;
  style(pill, {
    display: "inline-flex",
    "align-items": "center",
    "flex-shrink": "0",
    padding: "1px 7px",
    "border-radius": "999px",
    color: TEXT_PRIMARY,
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    font: "500 11px/16px system-ui, sans-serif",
    "white-space": "nowrap",
  });
  return pill;
}

function projectTag(document: Document, label: string): HTMLSpanElement {
  const tag = document.createElement("span");
  tag.setAttribute("data-jarvis-project", "");
  tag.textContent = label;
  style(tag, {
    "min-width": "0",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
    "flex-shrink": "1",
    padding: "0 6px",
    "border-radius": "4px",
    background: HOVER,
    color: TEXT_TERTIARY,
    font: "400 11px/18px system-ui, sans-serif",
  });
  return tag;
}

/** The single 「Jarvis」 row for previews and the entry section. */
export function createJarvisEntryRow(
  document: Document,
  locale: string,
  query?: string,
): HTMLElement {
  const description = query ? "" : locale === "zh-CN" ? "搜索 Bug" : "Search bugs";
  return createWorkbenchRow(document, {
    rowAttribute: JARVIS_ENTRY_ROW_ATTRIBUTE,
    icon: createJarvisMark(document, 16),
    label: query ? `Jarvis：${query}` : "Jarvis",
    description,
    singleLine: Boolean(query),
  });
}

/** The shared workbench section with only the Jarvis row; previews use it. */
export function createJarvisEntrySection(
  document: Document,
  locale: string,
): { element: HTMLElement; row: HTMLElement } {
  const section = createWorkbenchSection(document, locale === "zh-CN" ? "zh-CN" : "en");
  const row = createJarvisEntryRow(document, locale);
  section.items.append(row);
  return { element: section.element, row };
}

function chipBase(document: Document): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.setAttribute("data-jarvis-control", "true");
  style(chip, {
    display: "inline-flex",
    "align-items": "center",
    gap: "4px",
    "max-width": "100%",
    padding: "1px 8px",
    border: `1px solid ${BORDER}`,
    "border-radius": "999px",
    color: TEXT_TERTIARY,
    background: "transparent",
    font: "400 12px/18px system-ui, sans-serif",
    cursor: "pointer",
    "box-sizing": "border-box",
  });
  keepEditorFocusOnPress(chip);
  return chip;
}

/** The chosen project, removable: removing it returns to the project step. */
export function createJarvisProjectChip(
  document: Document,
  project: Pick<JarvisProject, "id" | "name">,
  onRemove: () => void,
): HTMLButtonElement {
  const chip = chipBase(document);
  chip.setAttribute(JARVIS_PROJECT_CHIP_ATTRIBUTE, String(project.id));
  chip.setAttribute("aria-label", `切换项目：${project.name}`);
  style(chip, {
    "max-width": "min(100%, 260px)",
    background: HOVER,
    color: TEXT_PRIMARY,
    border: "1px solid transparent",
    "font-weight": "500",
  });
  const label = textSpan(document, project.name, { flex: "0 1 auto" });
  const close = textSpan(document, "×", {
    flex: "0 0 auto",
    color: TEXT_TERTIARY,
    "font-size": "14px",
    "line-height": "12px",
  });
  chip.append(label, close);
  chip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onRemove();
  });
  return chip;
}

/** A parsed condition chip; removing it re-runs the parse with that `omit`. */
export function createJarvisConditionChip(
  document: Document,
  condition: JarvisBugCondition,
  onRemove: () => void,
): HTMLButtonElement {
  const chip = chipBase(document);
  chip.setAttribute("data-jarvis-chip", condition.key);
  chip.setAttribute("aria-label", `移除条件：${condition.label}`);
  const label = textSpan(document, condition.label, { flex: "0 1 auto" });
  const close = textSpan(document, "×", {
    flex: "0 0 auto",
    color: TEXT_TERTIARY,
    "font-size": "14px",
    "line-height": "12px",
  });
  chip.append(label, close);
  chip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onRemove();
  });
  return chip;
}

export interface JarvisBugRowHandlers {
  onSelect(index: number): void;
  onChoose(bug: JarvisBug): void;
}

/** Two-line native-density rows: id/title/status, then project/priority/time. */
export function renderJarvisBugRows(
  document: Document,
  results: HTMLElement,
  bugs: readonly JarvisBug[],
  locale: RendererSettingsLocale,
  handlers: JarvisBugRowHandlers,
): { bug: JarvisBug; row: HTMLElement }[] {
  const scroller = jarvisResultsScroller(results);
  scroller.replaceChildren();
  scroller.scrollTop = 0;
  const entries: { bug: JarvisBug; row: HTMLElement }[] = [];
  bugs.forEach((bug, index) => {
    const row = document.createElement("div");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.setAttribute(JARVIS_BUG_ROW_ATTRIBUTE, `${bug.projectId}:${bug.id}`);
    style(row, {
      display: "flex",
      "align-items": "center",
      gap: "10px",
      width: "100%",
      "min-height": ROW_MIN_HEIGHT,
      padding: `6px ${ROW_PADDING_X}`,
      "box-sizing": "border-box",
      "border-radius": "8px",
      background: "transparent",
      cursor: "pointer",
      "text-align": "left",
    });

    const color = statusColor(bug.status);
    const icon = bugIcon(document, color);
    icon.style.margin = "0 2px";

    const content = document.createElement("div");
    style(content, {
      display: "flex",
      "flex-direction": "column",
      gap: "2px",
      "min-width": "0",
      flex: "1 1 auto",
    });

    const first = document.createElement("div");
    style(first, {
      display: "flex",
      "align-items": "center",
      gap: "8px",
      "min-width": "0",
      width: "100%",
    });
    const id = textSpan(document, `#${bug.id}`, {
      color: TEXT_TERTIARY,
      font: "400 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace",
      "flex-shrink": "0",
    });
    const title = textSpan(document, bug.title, {
      color: TEXT_PRIMARY,
      font: "500 13px/18px system-ui, sans-serif",
      flex: "1 1 auto",
    });
    first.append(id, title);
    const status = jarvisStatusText(bug.status, locale);
    if (status) first.append(statusPill(document, status, color));

    const second = document.createElement("div");
    style(second, {
      display: "flex",
      "align-items": "center",
      gap: "6px",
      "min-width": "0",
      width: "100%",
      color: TEXT_TERTIARY,
      font: "400 11px/16px system-ui, sans-serif",
    });
    if (bug.projectName) second.append(projectTag(document, bug.projectName));
    const priority = jarvisPriorityText(bug.priority, locale);
    if (priority) {
      const dot = document.createElement("span");
      style(dot, {
        display: "inline-block",
        width: "6px",
        height: "6px",
        "border-radius": "999px",
        background: priorityColor(bug.priority),
        "flex-shrink": "0",
      });
      dot.setAttribute("aria-hidden", "true");
      second.append(dot, textSpan(document, priority));
    }
    const severity = jarvisSeverityText(bug.severity, locale);
    if (severity) second.append(textSpan(document, `· ${severity}`));
    const time = textSpan(document, jarvisRelativeTime(bug.updatedAt ?? bug.createdAt, locale), {
      "margin-left": "auto",
      "flex-shrink": "0",
    });
    second.append(time);

    content.append(first, second);
    row.append(icon, content);
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
      handlers.onChoose(bug);
    });
    entries.push({ bug, row });
    scroller.append(row);
  });
  return entries;
}
