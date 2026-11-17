/**
 * View builders for the Jarvis `@` row and its bug-search mode.
 *
 * These functions only create DOM. The controller in
 * `renderer-jarvis-mention.ts` owns state, requests, hosting and keyboard
 * handling. Every color is a Desktop token with an explicit fallback so the
 * panel still renders when a token is absent from the current Desktop theme.
 */
import createElement from "lucide/dist/esm/createElement.mjs";
import Bug from "lucide/dist/esm/icons/bug.mjs";

import type {
  JarvisBug,
  JarvisBugCondition,
  JarvisBugSearchResult,
} from "@codexhost/shared-contracts";

import {
  createWorkbenchRow,
  createWorkbenchSection,
  keepEditorFocusOnPress,
} from "./renderer-native-at-menu.js";
import { createJarvisMark } from "./settings/jarvis-icon.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

export const JARVIS_SECTION_ATTRIBUTE = "data-codexhost-jarvis-section";
export const JARVIS_MODE_ATTRIBUTE = "data-codexhost-jarvis-mode";
export const JARVIS_ENTRY_ROW_ATTRIBUTE = "data-codexhost-jarvis-entry-row";
export const JARVIS_BUG_ROW_ATTRIBUTE = "data-codexhost-jarvis-bug";
export const JARVIS_SKELETON_ATTRIBUTE = "data-codexhost-jarvis-skeleton";
export const JARVIS_SEARCH_PLACEHOLDER = "搜索 Bug，如「我还没处理完成的bug」";

const TEXT_PRIMARY = "var(--color-token-text-primary, #0d0d0d)";
const TEXT_TERTIARY =
  "var(--color-text-tertiary, var(--color-token-text-tertiary, rgba(13, 13, 13, 0.5)))";
const BORDER = "var(--color-token-border-default, rgba(13, 13, 13, 0.08))";
const HOVER = "var(--color-token-interactive-bg-secondary-hover, rgba(127, 127, 127, 0.08))";
const ORANGE = "var(--color-chart-orange, #fb6a22)";
const GREEN = "var(--color-chart-green, #04b84c)";
const RED = "var(--color-chart-red, #fa423e)";
const ROW_MIN_HEIGHT = "48px";
const ROW_PADDING_X = "12px";

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

function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
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

function text(
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
    color,
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

/** A removable parsed-condition chip; mousedown must not blur the search field. */
export function createJarvisConditionChip(
  document: Document,
  condition: JarvisBugCondition,
): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.setAttribute("data-jarvis-chip", condition.key);
  style(chip, {
    display: "inline-flex",
    "align-items": "center",
    gap: "4px",
    "max-width": "100%",
    padding: "1px 7px",
    border: `1px solid ${BORDER}`,
    "border-radius": "999px",
    color: TEXT_TERTIARY,
    background: "transparent",
    font: "400 12px/18px system-ui, sans-serif",
    cursor: "pointer",
  });
  const label = text(document, condition.label);
  label.style.flex = "0 1 auto";
  const close = document.createElement("span");
  close.textContent = "×";
  style(close, { flex: "0 0 auto", color: TEXT_TERTIARY });
  chip.append(label, close);
  keepEditorFocusOnPress(chip);
  return chip;
}

export interface JarvisModeChrome {
  section: HTMLElement;
  back: HTMLButtonElement;
  input: HTMLInputElement;
  clear: HTMLButtonElement;
  chips: HTMLElement;
  fallbackNotice: HTMLElement;
  summary: HTMLElement;
  results: HTMLElement;
}

/** Header, focused search field, chip row, summary and scrolling result area. */
export function createJarvisModeChrome(
  document: Document,
  locale: RendererSettingsLocale,
): JarvisModeChrome {
  const section = document.createElement("div");
  section.setAttribute(JARVIS_SECTION_ATTRIBUTE, "true");
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
  subtitle.textContent = "Bug";
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
  input.placeholder = JARVIS_SEARCH_PLACEHOLDER;
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
  chips.hidden = true;
  const fallbackNotice = document.createElement("div");
  fallbackNotice.setAttribute("data-jarvis-fallback-notice", "true");
  fallbackNotice.hidden = true;
  style(fallbackNotice, {
    "flex-shrink": "0",
    padding: "0 12px 6px",
    color: TEXT_TERTIARY,
    font: "400 12px/16px system-ui, sans-serif",
  });
  const summary = document.createElement("div");
  summary.setAttribute("data-jarvis-summary", "true");
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

  section.append(header, searchWrap, chips, fallbackNotice, summary, results);
  return { section, back, input, clear, chips, fallbackNotice, summary, results };
}

export function renderJarvisFallbackNotice(
  notice: HTMLElement,
  result: Pick<JarvisBugSearchResult, "source" | "fallbackReason">,
): void {
  const reasons: Record<NonNullable<JarvisBugSearchResult["fallbackReason"]>, string> = {
    missing_key: "未配置 Gemini 密钥",
    quota_exhausted: "Gemini 额度不足",
    unauthorized: "Gemini 密钥无效",
    timeout: "Gemini 请求超时",
    network: "网络连接失败",
    invalid_response: "Gemini 返回结果无效",
    gemini_failed: "Gemini 请求失败",
    local_only: "此机器未启用智能解析",
    unrecognized_query: "部分查询未能识别",
  };
  notice.hidden = result.source !== "rules";
  notice.textContent = notice.hidden
    ? ""
    : `智能解析暂不可用（${result.fallbackReason ? reasons[result.fallbackReason] : "Gemini 请求失败"}），已按基础规则解析`;
}

/** The scrollable list that owns bug rows. */
export function jarvisResultsScroller(results: HTMLElement): HTMLElement {
  return results.querySelector<HTMLElement>('[data-jarvis-results="true"]') ?? results;
}

/** Three placeholder rows while the Host search is running. */
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
    row.setAttribute(JARVIS_SKELETON_ATTRIBUTE, "true");
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
    const id = text(document, `#${bug.id}`, {
      color: TEXT_TERTIARY,
      font: "400 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace",
      "flex-shrink": "0",
    });
    const title = text(document, bug.title, {
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
      second.append(dot, text(document, priority));
    }
    const severity = jarvisSeverityText(bug.severity, locale);
    if (severity) second.append(text(document, `· ${severity}`));
    const time = text(document, jarvisRelativeTime(bug.updatedAt ?? bug.createdAt, locale), {
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

export interface JarvisEmptyAction {
  label: string;
  onSelect(opener: HTMLElement): void;
}

export function renderJarvisEmpty(
  document: Document,
  results: HTMLElement,
  message: string,
  action?: JarvisEmptyAction,
): void {
  const scroller = jarvisResultsScroller(results);
  scroller.replaceChildren();
  scroller.scrollTop = 0;
  const empty = document.createElement("div");
  style(empty, {
    padding: "10px 12px",
    color: TEXT_TERTIARY,
    font: "400 12px/18px system-ui, sans-serif",
    "white-space": "normal",
  });
  const messageText = document.createElement("span");
  messageText.textContent = message;
  empty.append(messageText);
  if (action) {
    const link = document.createElement("button");
    link.type = "button";
    link.setAttribute("data-jarvis-settings", "true");
    link.textContent = action.label;
    link.style.cssText =
      "margin-left:4px;border:0;background:transparent;color:" +
      TEXT_PRIMARY +
      ";font:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer;padding:0";
    keepEditorFocusOnPress(link);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action.onSelect(link);
    });
    empty.append(link);
  }
  scroller.append(empty);
}
