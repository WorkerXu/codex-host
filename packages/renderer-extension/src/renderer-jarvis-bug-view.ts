/**
 * View builders for the Jarvis `@` row and its bug-search mode.
 *
 * These functions only create DOM using Desktop's own menu classes. The
 * controller in `renderer-jarvis-mention.ts` owns state, requests and
 * keyboard handling.
 */
import type { JarvisBug, JarvisBugCondition } from "@codexhost/shared-contracts";

import { ROW_CLASS } from "./renderer-delegation-mention.js";
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

export function truncateJarvisText(value: string, limit: number): string {
  const text = value.trim().replace(/\s+/gu, " ");
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text;
}

/** Chip and row label, e.g. `Bug #928 填写已查码的序列号…`. */
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
  chip.className =
    "inline-flex max-w-full items-center gap-1 truncate rounded-sm border border-default px-1 text-xs text-tertiary";
  chip.setAttribute("data-jarvis-chip", condition.key);
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = condition.label;
  const close = document.createElement("span");
  close.className = "shrink-0";
  close.textContent = "×";
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
  summary: HTMLElement;
  results: HTMLElement;
}

/** Header, focused search field, chip row, summary and result area. */
export function createJarvisModeChrome(
  document: Document,
  locale: RendererSettingsLocale,
): JarvisModeChrome {
  const section = document.createElement("div");
  section.setAttribute(JARVIS_SECTION_ATTRIBUTE, "true");
  section.className = "flex w-full flex-col";

  const header = document.createElement("div");
  header.className =
    "sticky top-0 z-10 flex items-center gap-1 px-row-x py-1 text-sm bg-surface-elevated-secondary";
  const back = document.createElement("button");
  back.type = "button";
  back.setAttribute("aria-label", locale === "zh-CN" ? "返回" : "Back");
  back.className =
    "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-default hover:bg-primary-ghost-hover";
  back.textContent = "‹";
  keepEditorFocusOnPress(back);
  const title = document.createElement("span");
  title.className = "min-w-0 truncate text-sm text-default";
  title.textContent = "Jarvis · Bug";
  header.append(back, title);

  const searchWrap = document.createElement("div");
  searchWrap.className = "relative px-row-x pb-1";
  const input = document.createElement("input");
  // A text input avoids the heavy UA clear button of `type=search`.
  input.type = "text";
  input.className =
    "w-full min-w-0 rounded-sm border border-default bg-transparent px-2 py-1 pr-8 text-sm text-default outline-none";
  input.placeholder = JARVIS_SEARCH_PLACEHOLDER;
  input.maxLength = 200;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.value = "";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.style.display = "none";
  clear.setAttribute("data-jarvis-clear", "true");
  clear.setAttribute("aria-label", locale === "zh-CN" ? "清除" : "Clear");
  clear.className =
    "absolute right-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-tertiary hover:text-default";
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
  chips.className = "flex flex-wrap gap-1 px-row-x pb-1";
  chips.hidden = true;
  const summary = document.createElement("div");
  summary.className = "px-row-x py-1 text-xs text-tertiary";
  summary.setAttribute("data-jarvis-summary", "true");
  const results = document.createElement("div");
  results.className = "flex w-full flex-col";

  section.append(header, searchWrap, chips, summary, results);
  return { section, back, input, clear, chips, summary, results };
}

/** Three placeholder rows while the Host search is running. */
export function renderJarvisLoading(document: Document, results: HTMLElement): void {
  results.replaceChildren();
  for (let index = 0; index < 3; index += 1) {
    const row = document.createElement("div");
    row.className = `${ROW_CLASS} pointer-events-none`;
    row.setAttribute(JARVIS_SKELETON_ATTRIBUTE, "true");
    row.setAttribute("aria-hidden", "true");
    const content = document.createElement("div");
    content.className = "flex w-full min-w-0 flex-col gap-1";
    const first = document.createElement("div");
    first.className = "h-3 w-2/3 rounded-sm bg-primary-ghost-hover";
    const second = document.createElement("div");
    second.className = "h-2 w-1/3 rounded-sm bg-primary-ghost-hover opacity-60";
    content.append(first, second);
    row.append(content);
    results.append(row);
  }
}

export interface JarvisBugRowHandlers {
  onSelect(index: number): void;
  onChoose(bug: JarvisBug): void;
}

/** Result rows; the controller owns keyboard selection on top of them. */
export function renderJarvisBugRows(
  document: Document,
  results: HTMLElement,
  bugs: readonly JarvisBug[],
  locale: RendererSettingsLocale,
  handlers: JarvisBugRowHandlers,
): { bug: JarvisBug; row: HTMLElement }[] {
  results.replaceChildren();
  const entries: { bug: JarvisBug; row: HTMLElement }[] = [];
  bugs.forEach((bug, index) => {
    const row = document.createElement("div");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.setAttribute(JARVIS_BUG_ROW_ATTRIBUTE, `${bug.projectId}:${bug.id}`);
    row.className = ROW_CLASS;
    const content = document.createElement("div");
    content.className = "flex w-full min-w-0 flex-col gap-0.5";
    const first = document.createElement("div");
    first.className = "flex w-full min-w-0 items-center gap-1";
    const id = document.createElement("span");
    id.className = "shrink-0 text-xs text-tertiary";
    id.textContent = `#${bug.id}`;
    const title = document.createElement("span");
    title.className = "min-w-0 flex-1 truncate text-sm text-default";
    title.textContent = bug.title;
    first.append(id, title);
    const status = jarvisStatusText(bug.status, locale);
    if (status) {
      const pill = document.createElement("span");
      pill.className = "shrink-0 rounded-sm border border-default px-1 text-xs text-tertiary";
      pill.textContent = status;
      first.append(pill);
    }
    const second = document.createElement("div");
    second.className = "flex w-full min-w-0 items-center gap-1 text-xs text-tertiary";
    const project = document.createElement("span");
    project.className = "min-w-0 flex-1 truncate";
    project.textContent = bug.projectName ?? "";
    const priority = jarvisPriorityText(bug.priority, locale);
    const severity = jarvisSeverityText(bug.severity, locale);
    const level = document.createElement("span");
    level.className = "shrink-0";
    level.textContent = [priority, severity].filter(Boolean).join(" · ");
    const time = document.createElement("span");
    time.className = "shrink-0";
    time.textContent = jarvisRelativeTime(bug.updatedAt ?? bug.createdAt, locale);
    second.append(project);
    if (level.textContent) second.append(level);
    if (time.textContent) second.append(time);
    content.append(first, second);
    row.append(content);
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
    results.append(row);
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
  results.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "px-row-x py-2 text-xs text-tertiary";
  const text = document.createElement("span");
  text.textContent = message;
  empty.append(text);
  if (action) {
    const link = document.createElement("button");
    link.type = "button";
    link.setAttribute("data-jarvis-settings", "true");
    link.className = "ml-1 text-default underline underline-offset-2";
    link.textContent = action.label;
    keepEditorFocusOnPress(link);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action.onSelect(link);
    });
    empty.append(link);
  }
  results.append(empty);
}
