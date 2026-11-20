/**
 * Shared 「工作台」 group inside Desktop's native `@` mention menu.
 *
 * The current Desktop menu is not a listbox: the panel is a
 * `ComposerTopMenuShell` / `suggestionMenu` element whose only scroll child is
 * `[data-mention-list-scroll-area]`. Sections are plain `div`s keyed by
 * `data-mention-section-id`, rows are `[data-list-navigation-item]` buttons and
 * the highlighted row carries `aria-current="true"`. Appending a native-shaped
 * section there keeps the Workbench rows in the same scroll container, with the
 * same row look and the same keyboard model, instead of drawing another popup.
 */
import type { RendererSettingsLocale } from "./settings/localization.js";

export const WORKBENCH_SECTION_ATTRIBUTE = "data-codexhost-workbench-section";
export const WORKBENCH_ROW_ATTRIBUTE = "data-codexhost-workbench-row";
export const WORKBENCH_SECTION_ID = "codexhost-workbench";

const NATIVE_SCROLL_ATTRIBUTE = "data-mention-list-scroll-area";
const NATIVE_SCROLL_CLASS = "vertical-scroll-fade-mask";
const NATIVE_ROW_SELECTOR = '[data-list-navigation-item="true"]';
const LEGACY_ROW_SELECTOR = '[role="option"]';
const OWN_NODE_SELECTOR = [
  `[${WORKBENCH_SECTION_ATTRIBUTE}]`,
  "[data-codexhost-delegation-mention-menu]",
  "[data-codexhost-jarvis-mode]",
  "[data-codexhost-jarvis-panel]",
  "[data-codexhost-dingtalk-panel]",
].join(",");

// Classes below are copied from the real menu DOM (`native-at-dom-2026-11-16`).
const HEADER_CLASS =
  "text-codex-description shrink-0 h-[var(--suggestion-menu-header-height,auto)] px-row-x py-1 " +
  "text-sm sticky top-0 z-10 " +
  "bg-[var(--suggestion-menu-header-background,var(--color-surface-elevated-secondary))]";
const ROW_CLASS =
  "text-default outline-hidden focus:bg-secondary-ghost-hover cursor-interaction flex w-full " +
  "shrink-0 items-center overflow-hidden text-start min-h-[var(--app-menu-item-height,0px)] " +
  "rounded-[var(--suggestion-menu-item-radius,var(--radius-xl))] " +
  "p-[var(--suggestion-menu-item-padding,var(--app-menu-item-padding,var(--padding-row-y)_var(--padding-row-x)))] " +
  "text-sm [content-visibility:auto] [contain-intrinsic-block-size:auto_1lh]";
const ROW_CONTENT_CLASS =
  "flex w-full min-w-0 items-center gap-[var(--spacing-menu-item-content,calc(var(--spacing)*1.5))]";
const ICON_SLOT_CLASS =
  "inline-flex flex-none items-center justify-center size-(--icon-leading-size)";
const LABEL_WRAPPER_CLASS = "flex-1 min-w-0 truncate";
const LABEL_GROUP_CLASS = "flex min-w-0 items-center gap-menu-row-content";
const LABEL_CLASS = "min-w-0 truncate shrink-0";
const DESCRIPTION_CLASS = "min-w-0 flex-1 truncate text-sm text-codex-description";
const HIGHLIGHT_CLASSES = ["bg-secondary-ghost-hover", "opacity-100"] as const;
const IDLE_CLASS = "menu-row-opacity";

export interface WorkbenchSection {
  element: HTMLElement;
  header: HTMLElement;
  items: HTMLElement;
}

export interface WorkbenchRowOptions {
  /** Row marker that identifies the owner, e.g. `data-codexhost-dingtalk-entry`. */
  rowAttribute: string;
  icon: Element;
  label: string;
  description: string;
  /** One-line row without a description column, e.g. `Jarvis：<query>`. */
  singleLine?: boolean;
}

function isVisible(element: HTMLElement): boolean {
  if (element.getClientRects().length === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

interface Candidate {
  scroll: HTMLElement;
  preferred: number;
  distance: number;
  order: number;
}

/**
 * Find the native `@` menu's scroll container next to `anchor`.
 *
 * Ordering: the explicit scroll-area attribute wins, then Desktop's fade-mask
 * scroll child inside the suggestion panel, then the old listbox shape.
 */
export function findNativeSuggestionList(
  ownerDocument: Document,
  anchor: Element | null,
): HTMLElement | null {
  const anchorRect = anchor?.getBoundingClientRect();
  const candidates: Candidate[] = [];
  const seen = new Set<HTMLElement>();

  const collect = (element: HTMLElement | null, preferred: number): void => {
    if (!element || seen.has(element)) return;
    if (element.closest(OWN_NODE_SELECTOR)) return;
    if (!isVisible(element)) return;
    seen.add(element);
    const rect = element.getBoundingClientRect();
    const distance = anchorRect
      ? rect.top >= anchorRect.top
        ? rect.top - anchorRect.bottom
        : anchorRect.top - rect.bottom
      : 0;
    if (anchorRect && Math.abs(distance) >= 600) return;
    candidates.push({ scroll: element, preferred, distance, order: candidates.length });
  };

  for (const element of ownerDocument.querySelectorAll<HTMLElement>(
    `[${NATIVE_SCROLL_ATTRIBUTE}]`,
  )) {
    collect(element, 3);
  }
  for (const element of ownerDocument.querySelectorAll<HTMLElement>(`.${NATIVE_SCROLL_CLASS}`)) {
    if (!element.closest('[class*="ComposerTopMenuShell"],[class*="suggestionMenu"]')) continue;
    collect(element, 2);
  }
  for (const element of ownerDocument.querySelectorAll<HTMLElement>('[role="listbox"]')) {
    if (element.closest(OWN_NODE_SELECTOR)) continue;
    const scroll = element.classList.contains(NATIVE_SCROLL_CLASS)
      ? element
      : (element.querySelector<HTMLElement>(`.${NATIVE_SCROLL_CLASS}`) ?? element);
    collect(scroll, 1);
  }

  candidates.sort(
    (left, right) =>
      right.preferred - left.preferred ||
      left.distance - right.distance ||
      right.order - left.order,
  );
  return candidates[0]?.scroll ?? null;
}

/**
 * Retry detection for the first animation frames after `input`; Desktop mounts
 * the popup after the event. A list that never appears simply shows nothing.
 */
export function waitForNativeSuggestionList(
  ownerDocument: Document,
  anchor: () => Element | null,
  onFound: (list: HTMLElement) => void,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): () => void {
  const view = ownerDocument.defaultView;
  const interval = options.intervalMs ?? 50;
  const timeout = options.timeoutMs ?? 300;
  let cancelled = false;
  let elapsed = 0;

  const attempt = (): void => {
    if (cancelled) return;
    const list = findNativeSuggestionList(ownerDocument, anchor());
    if (list) {
      onFound(list);
      return;
    }
    if (elapsed >= timeout) return;
    elapsed += interval;
    view?.setTimeout(attempt, interval);
  };

  attempt();
  return () => {
    cancelled = true;
  };
}

/** One native-shaped 「工作台」 section. */
export function createWorkbenchSection(
  ownerDocument: Document,
  locale: RendererSettingsLocale,
): WorkbenchSection {
  const element = ownerDocument.createElement("div");
  element.setAttribute(WORKBENCH_SECTION_ATTRIBUTE, "true");
  element.setAttribute("data-mention-section-id", WORKBENCH_SECTION_ID);
  const header = ownerDocument.createElement("div");
  // Every appended section is non-first, which native markup marks with `pt-2`.
  header.className = `${HEADER_CLASS} pt-2`;
  header.textContent = locale === "zh-CN" ? "工作台" : "Workbench";
  const items = ownerDocument.createElement("div");
  items.setAttribute("data-mention-section-items", "true");
  element.append(header, items);
  return { element, header, items };
}

/**
 * Reuse the existing shared section or append one. Whichever controller
 * installs first creates it; the other finds it. The section is always last.
 */
export function ensureWorkbenchSection(
  ownerDocument: Document,
  list: HTMLElement,
  locale: RendererSettingsLocale,
): WorkbenchSection {
  const existing = list.querySelector<HTMLElement>(`[${WORKBENCH_SECTION_ATTRIBUTE}]`);
  if (!existing) {
    const section = createWorkbenchSection(ownerDocument, locale);
    list.append(section.element);
    return section;
  }
  if (list.lastElementChild !== existing) list.append(existing);
  let header = existing.firstElementChild as HTMLElement | null;
  if (header?.hasAttribute("data-mention-section-items")) header = null;
  let items = existing.querySelector<HTMLElement>('[data-mention-section-items="true"]');
  if (!items) {
    items = ownerDocument.createElement("div");
    items.setAttribute("data-mention-section-items", "true");
    existing.append(items);
  }
  if (!header) {
    header = ownerDocument.createElement("div");
    header.className = `${HEADER_CLASS} pt-2`;
    existing.prepend(header);
  }
  const title = locale === "zh-CN" ? "工作台" : "Workbench";
  if (header.textContent !== title) header.textContent = title;
  return { element: existing, header, items };
}

export function removeWorkbenchSectionIfEmpty(section: HTMLElement | null): void {
  if (!section) return;
  if (section.querySelector(`[${WORKBENCH_ROW_ATTRIBUTE}]`)) return;
  section.remove();
}

/**
 * Keep the ProseMirror editor focused. A button's default mousedown moves
 * focus out of the Composer, which closes Desktop's native `@` popup before
 * the click can be handled.
 */
export function keepEditorFocusOnPress(element: HTMLElement): void {
  const prevent = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  element.addEventListener("pointerdown", prevent);
  element.addEventListener("mousedown", prevent);
}

/** A native row: button, row classes, menu row content, icon slot, label. */
export function createWorkbenchRow(
  ownerDocument: Document,
  options: WorkbenchRowOptions,
): HTMLButtonElement {
  const row = ownerDocument.createElement("button");
  row.type = "button";
  row.setAttribute("data-list-navigation-item", "true");
  row.setAttribute(WORKBENCH_ROW_ATTRIBUTE, "true");
  row.setAttribute(options.rowAttribute, "true");
  row.className = `${ROW_CLASS} ${IDLE_CLASS}`;
  const content = ownerDocument.createElement("div");
  content.setAttribute("data-menu-row-content", "true");
  content.className = ROW_CONTENT_CLASS;
  const iconSlot = ownerDocument.createElement("span");
  iconSlot.setAttribute("data-leading-icon-slot", "menu");
  iconSlot.className = ICON_SLOT_CLASS;
  iconSlot.append(options.icon);
  const wrapper = ownerDocument.createElement("span");
  wrapper.className = LABEL_WRAPPER_CLASS;
  const group = ownerDocument.createElement("span");
  group.className = LABEL_GROUP_CLASS;
  const label = ownerDocument.createElement("span");
  const singleLine = options.singleLine === true || options.description.length === 0;
  label.className = singleLine ? "min-w-0 flex-1 truncate" : LABEL_CLASS;
  label.textContent = options.label;
  group.append(label);
  if (!singleLine) {
    const description = ownerDocument.createElement("span");
    description.className = DESCRIPTION_CLASS;
    description.textContent = options.description;
    group.append(description);
  }
  wrapper.append(group);
  content.append(iconSlot, wrapper);
  row.append(content);
  keepEditorFocusOnPress(row);
  return row;
}

/** Apply the native highlighted-row state (aria-current + classes). */ export function setWorkbenchRowHighlight(
  row: HTMLElement,
  selected: boolean,
): void {
  if (selected) row.setAttribute("aria-current", "true");
  else row.removeAttribute("aria-current");
  for (const name of HIGHLIGHT_CLASSES) row.classList.toggle(name, selected);
  row.classList.toggle(IDLE_CLASS, !selected);
}

/** Native rows in DOM order; falls back to the legacy option rows. */
export function nativeMenuRows(list: HTMLElement): HTMLElement[] {
  const rows = [...list.querySelectorAll<HTMLElement>(NATIVE_ROW_SELECTOR)];
  const usable =
    rows.length > 0 ? rows : [...list.querySelectorAll<HTMLElement>(LEGACY_ROW_SELECTOR)];
  return usable.filter((row) => !row.closest(`[${WORKBENCH_SECTION_ATTRIBUTE}]`));
}

export function highlightedNativeRow(rows: readonly HTMLElement[]): HTMLElement | null {
  return (
    rows.find((row) => row.getAttribute("aria-current") === "true") ??
    rows.find((row) => row.getAttribute("aria-selected") === "true") ??
    null
  );
}

export function clearNativeRowHighlight(row: HTMLElement): void {
  row.removeAttribute("aria-current");
  for (const name of HIGHLIGHT_CLASSES) row.classList.remove(name);
  row.classList.add(IDLE_CLASS);
}

export function restoreNativeRowHighlight(row: HTMLElement): void {
  row.setAttribute("aria-current", "true");
  for (const name of HIGHLIGHT_CLASSES) row.classList.add(name);
  row.classList.remove(IDLE_CLASS);
}

export type WorkbenchNavigation =
  | { kind: "none" }
  | { kind: "highlight"; row: HTMLElement; clearNative: boolean }
  | { kind: "native"; row: HTMLElement }
  | { kind: "choose"; row: HTMLElement };

/**
 * Arrow-key navigation across the native rows and every Workbench row.
 * `none` means the key belongs to Desktop and must not be intercepted.
 */
export function workbenchNavigation(input: {
  key: string;
  nativeRows: readonly HTMLElement[];
  workbenchRows: readonly HTMLElement[];
  highlightedNative: HTMLElement | null;
  highlightedWorkbench: HTMLElement | null;
}): WorkbenchNavigation {
  const { nativeRows, workbenchRows } = input;
  const current = input.highlightedWorkbench;
  const ownIndex = current ? workbenchRows.indexOf(current) : -1;
  if (input.key === "ArrowDown") {
    if (current) {
      const next = workbenchRows[Math.min(ownIndex + 1, workbenchRows.length - 1)];
      if (next) return { kind: "highlight", row: next, clearNative: false };
    }
    const first = workbenchRows[0];
    if (!first) return { kind: "none" };
    if (
      nativeRows.length === 0 ||
      input.highlightedNative === null ||
      input.highlightedNative === nativeRows.at(-1)
    ) {
      return { kind: "highlight", row: first, clearNative: true };
    }
    return { kind: "none" };
  }
  if (input.key === "ArrowUp" && current) {
    if (ownIndex > 0) {
      const previous = workbenchRows[ownIndex - 1];
      if (previous) return { kind: "highlight", row: previous, clearNative: false };
    }
    const last = nativeRows.at(-1);
    return last ? { kind: "native", row: last } : { kind: "none" };
  }
  if ((input.key === "Enter" || input.key === "Tab") && current) {
    return { kind: "choose", row: current };
  }
  return { kind: "none" };
}

interface WorkbenchNavigatorState {
  rows: Map<HTMLElement, () => void>;
  listener: ((event: KeyboardEvent) => void) | null;
}

const navigators = new WeakMap<Document, WorkbenchNavigatorState>();

function navigatorFor(ownerDocument: Document): WorkbenchNavigatorState {
  let state = navigators.get(ownerDocument);
  if (!state) {
    state = { rows: new Map(), listener: null };
    navigators.set(ownerDocument, state);
  }
  return state;
}

/** Register one Workbench row with the shared keyboard navigator. */
export function registerWorkbenchRow(
  ownerDocument: Document,
  row: HTMLElement,
  choose: () => void,
): () => void {
  const state = navigatorFor(ownerDocument);
  state.rows.set(row, choose);
  if (!state.listener) {
    state.listener = (event) => onWorkbenchKeyDown(ownerDocument, state, event);
    ownerDocument.defaultView?.addEventListener("keydown", state.listener, true);
  }
  return () => {
    state.rows.delete(row);
    if (state.rows.size > 0 || !state.listener) return;
    ownerDocument.defaultView?.removeEventListener("keydown", state.listener, true);
    state.listener = null;
  };
}

/** Highlight one Workbench row; every native row loses its highlight. */
export function highlightWorkbenchRow(ownerDocument: Document, row: HTMLElement | null): void {
  const state = navigators.get(ownerDocument);
  if (!state) return;
  for (const candidate of state.rows.keys()) setWorkbenchRowHighlight(candidate, candidate === row);
  if (!row) return;
  const list = row.closest(`[${WORKBENCH_SECTION_ATTRIBUTE}]`)?.parentElement;
  if (list) {
    for (const nativeRow of nativeMenuRows(list as HTMLElement)) {
      clearNativeRowHighlight(nativeRow);
    }
  }
  row.scrollIntoView({ block: "nearest" });
}

function onWorkbenchKeyDown(
  ownerDocument: Document,
  state: WorkbenchNavigatorState,
  event: KeyboardEvent,
): void {
  if (event.isComposing || event.defaultPrevented) return;
  if ((event.target as Element | null)?.closest?.("[data-codexhost-jarvis-mode]")) return;
  const workbenchRows = [...state.rows.keys()].filter(
    (row) => row.isConnected && row.getBoundingClientRect().height > 0,
  );
  if (workbenchRows.length === 0) return;
  const section = workbenchRows[0]?.closest(`[${WORKBENCH_SECTION_ATTRIBUTE}]`);
  const list = section?.parentElement;
  if (!list) return;
  const nativeRows = nativeMenuRows(list as HTMLElement);
  const action = workbenchNavigation({
    key: event.key,
    nativeRows,
    workbenchRows,
    highlightedNative: highlightedNativeRow(nativeRows),
    highlightedWorkbench:
      workbenchRows.find((row) => row.getAttribute("aria-current") === "true") ?? null,
  });
  if (action.kind === "none") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (action.kind === "highlight") {
    highlightWorkbenchRow(ownerDocument, action.row);
    if (action.clearNative) {
      for (const nativeRow of nativeRows) clearNativeRowHighlight(nativeRow);
    }
    return;
  }
  if (action.kind === "native") {
    highlightWorkbenchRow(ownerDocument, null);
    restoreNativeRowHighlight(action.row);
    action.row.scrollIntoView({ block: "nearest" });
    return;
  }
  state.rows.get(action.row)?.();
}
