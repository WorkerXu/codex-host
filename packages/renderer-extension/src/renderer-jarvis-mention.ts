/**
 * Jarvis inside Codex Desktop's native `@` menu.
 *
 * Typing after `@` only reveals one 「Jarvis」 row in the 「工作台」 group; it
 * never searches by itself. Selecting the row switches the same native popup
 * list into a bug search mode: a back header, a focused search field and the
 * complete matching set below. Choosing a bug inserts the native mention chip
 * whose `jarvis://bug/<projectId>/<bugId>` path the Host expands on submit.
 */
import {
  formatJarvisMentionLink,
  jarvisMentionPath,
  type JarvisBug,
  type JarvisBugCondition,
  type JarvisBugSearchParams,
  type JarvisBugSearchResult,
} from "@codexhost/shared-contracts";

import { ROW_HIGHLIGHT_CLASSES, ROW_IDLE_CLASS } from "./renderer-delegation-mention.js";
import {
  JARVIS_MODE_ATTRIBUTE,
  JARVIS_SECTION_ATTRIBUTE,
  createJarvisConditionChip,
  createJarvisEntryRow,
  createJarvisModeChrome,
  jarvisBugLabel,
  renderJarvisBugRows,
  renderJarvisEmpty,
  renderJarvisLoading,
} from "./renderer-jarvis-bug-view.js";
import { jarvisErrorText } from "./renderer-jarvis-client.js";
import {
  ensureWorkbenchSection,
  findNativeSuggestionList,
  highlightWorkbenchRow,
  registerWorkbenchRow,
  removeWorkbenchSectionIfEmpty,
  waitForNativeSuggestionList,
} from "./renderer-native-at-menu.js";
import {
  deleteNativeRange,
  insertNativeAgentMention,
  insertNativeAgentMentionAtSelection,
  type NativeTextRange,
} from "./renderer-native-composer-controller.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

export {
  createJarvisEntryRow,
  createJarvisEntrySection,
  jarvisBugLabel,
  jarvisPriorityText,
  jarvisRelativeTime,
  jarvisSeverityText,
  jarvisStatusText,
  truncateJarvisText,
} from "./renderer-jarvis-bug-view.js";

export { findNativeSuggestionList } from "./renderer-native-at-menu.js";

const SECTION_ATTRIBUTE = JARVIS_SECTION_ATTRIBUTE;
const MODE_ATTRIBUTE = JARVIS_MODE_ATTRIBUTE;
const TRIGGER_PATTERN = /(?:^|\s)@([^\s@]{0,64})$/u;
const DEBOUNCE_MS = 300;
const SLOW_NOTICE_MS = 8_000;
const MAX_QUERY_LENGTH = 64;

export interface RendererJarvisTrigger {
  query: string;
  start: number;
}

/** Detect an active `@query` token ending at the caret. */
export function findJarvisTrigger(textBeforeCaret: string): RendererJarvisTrigger | null {
  const match = TRIGGER_PATTERN.exec(textBeforeCaret);
  if (!match) return null;
  const query = match[1] ?? "";
  if (query.length > MAX_QUERY_LENGTH) return null;
  return { query, start: textBeforeCaret.length - query.length - 1 };
}

/** The row appears for an empty query or a prefix of its own name. */
export function matchesJarvisEntry(query: string): boolean {
  if (query.length === 0) return true;
  const value = query.toLocaleLowerCase();
  return "jarvis".startsWith(value) || "贾维斯".startsWith(value);
}

const WORKBENCH_PREFIXES = ["jarvis", "贾维斯", "钉钉", "dingtalk"] as const;

/**
 * `@<text>` that is not a Workbench name prefix is itself the Jarvis query.
 * The row then reads `Jarvis：<text>` and selecting it prefills the search.
 */
export function jarvisQueryEntry(query: string): string | null {
  if (!query) return null;
  const value = query.toLocaleLowerCase();
  if (WORKBENCH_PREFIXES.some((prefix) => prefix.startsWith(value))) return null;
  return query;
}

export function showsJarvisEntry(query: string): boolean {
  return matchesJarvisEntry(query) || jarvisQueryEntry(query) !== null;
}

export type JarvisEntryAction = "none" | "entry" | "search";

/**
 * Entry gating policy. Typing after `@` can only reveal the row; a search
 * request is possible only after the row was selected.
 */
export function jarvisEntryAction(input: {
  query: string;
  selectedEntry: boolean;
}): JarvisEntryAction {
  if (!showsJarvisEntry(input.query)) return "none";
  return input.selectedEntry ? "search" : "entry";
}

export interface RendererJarvisMentionOptions {
  isComposerEditor(editor: HTMLElement): boolean;
  /** Desktop Host that runs the Composer's Thread; null while unknown. */
  readHostId(editor: HTMLElement): string | null;
  /** Runs the structured Host search; only called after Jarvis was selected. */
  search(hostId: string, params: JarvisBugSearchParams): Promise<JarvisBugSearchResult>;
  readLocale(): RendererSettingsLocale;
  anchorForEditor(editor: HTMLElement): Element | null;
  /** Opens the Jarvis settings page from an error state. */
  openSettings?(opener: HTMLElement): void;
}

export interface RendererJarvisMentionControl {
  refresh(): void;
  dispose(): void;
}

interface Trigger {
  editor: HTMLElement;
  node: Text;
  start: number;
  end: number;
  query: string;
}

interface EntryState {
  trigger: Trigger;
  row: HTMLElement;
  section: HTMLElement;
  unregister: () => void;
}

interface ModeState {
  trigger: Trigger;
  section: HTMLElement;
  back: HTMLButtonElement;
  input: HTMLInputElement;
  clear: HTMLButtonElement;
  chips: HTMLElement;
  summary: HTMLElement;
  results: HTMLElement;
  entries: { bug: JarvisBug; row: HTMLElement }[];
  selected: number;
  generation: number;
  loading: boolean;
  omit: Set<string>;
  lastQuery: string;
  hidden: Map<HTMLElement, string>;
  locale: RendererSettingsLocale;
  timer: number | null;
  slowTimer: number | null;
  /** The `@query` text was already removed; insert the mention at the caret. */
  insertAtSelection: boolean;
  /** Native popup bounds, reused if focus makes the popup close. */
  lastRect: { left: number; top: number; width: number; height: number } | null;
  detachedHost: HTMLElement | null;
}

export function installRendererJarvisMention(
  ownerDocument: Document,
  options: RendererJarvisMentionOptions,
): RendererJarvisMentionControl {
  const view = ownerDocument.defaultView;
  if (!view) return { refresh: () => undefined, dispose: () => undefined };

  let entry: EntryState | null = null;
  let entryPending: Trigger | null = null;
  let cancelEntryWait: (() => void) | null = null;
  let mode: ModeState | null = null;
  let suppressed: string | null = null;
  let composing = false;
  let inserting = false;
  let reattachScheduled = false;

  const isInside = (node: Node | null, element: Element | null): boolean =>
    node !== null && element !== null && element.contains(node);

  const nativeList = (editor: HTMLElement): HTMLElement | null =>
    findNativeSuggestionList(ownerDocument, options.anchorForEditor(editor));

  const removeEntry = (): void => {
    cancelEntryWait?.();
    cancelEntryWait = null;
    entryPending = null;
    entry?.unregister();
    entry?.row.remove();
    // The section is shared with the DingTalk row; drop it only when empty.
    removeWorkbenchSectionIfEmpty(entry?.section ?? null);
    entry = null;
  };

  const removeMode = (): void => {
    if (!mode) return;
    if (mode.timer !== null) view.clearTimeout(mode.timer);
    stopSlowTimer(mode);
    mode.section.remove();
    mode.detachedHost?.remove();
    mode.detachedHost = null;
    for (const [element, display] of mode.hidden) {
      if (!element.isConnected) continue;
      element.style.display = display;
    }
    mode.hidden.clear();
    mode = null;
  };

  const hideNativeChildren = (state: ModeState, list: HTMLElement): void => {
    for (const child of [...list.children]) {
      if (!(child instanceof HTMLElement)) continue;
      if (child === state.section) continue;
      if (child.hasAttribute(SECTION_ATTRIBUTE) || child.hasAttribute(MODE_ATTRIBUTE)) continue;
      if (state.hidden.has(child)) continue;
      state.hidden.set(child, child.style.display);
      child.style.display = "none";
    }
  };

  const readTrigger = (): Trigger | null => {
    const selection = ownerDocument.getSelection();
    if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
    const node = selection.anchorNode;
    if (!node || node.nodeType !== node.TEXT_NODE) return null;
    const editor = node.parentElement?.closest<HTMLElement>('[contenteditable="true"]');
    if (!editor || !options.isComposerEditor(editor)) return null;
    const text = node as Text;
    const found = findJarvisTrigger(text.data.slice(0, selection.anchorOffset));
    if (!found) return null;
    return {
      editor,
      node: text,
      start: found.start,
      end: selection.anchorOffset,
      query: found.query,
    };
  };

  const triggerIntact = (trigger: Trigger): boolean =>
    trigger.node.isConnected &&
    trigger.node.data.slice(trigger.start, trigger.end) === `@${trigger.query}`;

  const attachEntry = (trigger: Trigger): void => {
    const queryText = jarvisQueryEntry(trigger.query);
    if (!matchesJarvisEntry(trigger.query) && queryText === null) return;
    const list = nativeList(trigger.editor);
    if (!list) return;
    cancelEntryWait?.();
    cancelEntryWait = null;
    entryPending = null;
    const locale = options.readLocale();
    const row = createJarvisEntryRow(ownerDocument, locale, queryText ?? undefined);
    const section = ensureWorkbenchSection(ownerDocument, list, locale);
    if (row.parentElement !== section.items) section.items.append(row);
    const state: EntryState = {
      trigger,
      row,
      section: section.element,
      unregister: () => undefined,
    };
    entry = state;

    row.addEventListener("pointermove", (event) => {
      event.stopPropagation();
      highlightWorkbenchRow(ownerDocument, state.row);
    });
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (entry !== state) return;
      if (queryText !== null) enterMode(state.trigger, queryText, true);
      else enterMode(state.trigger);
    });
    state.unregister = registerWorkbenchRow(ownerDocument, row, () => row.click());
  };

  /** Wait for the native popup instead of drawing our own panel. */
  const scheduleEntry = (trigger: Trigger): void => {
    if (!showsJarvisEntry(trigger.query)) return;
    const list = nativeList(trigger.editor);
    if (list) {
      attachEntry(trigger);
      return;
    }
    entryPending = trigger;
    cancelEntryWait?.();
    cancelEntryWait = waitForNativeSuggestionList(
      ownerDocument,
      () => options.anchorForEditor(trigger.editor),
      () => {
        cancelEntryWait = null;
        if (entry || entryPending !== trigger) return;
        attachEntry(trigger);
      },
    );
  };

  const buildMode = (trigger: Trigger): ModeState => {
    const locale = options.readLocale();
    const chrome = createJarvisModeChrome(ownerDocument, locale);
    chrome.section.setAttribute(MODE_ATTRIBUTE, "true");
    return {
      ...chrome,
      trigger,
      entries: [],
      selected: -1,
      generation: 0,
      loading: false,
      omit: new Set(),
      lastQuery: "",
      hidden: new Map(),
      locale,
      timer: null,
      slowTimer: null,
      insertAtSelection: false,
      lastRect: null,
      detachedHost: null,
    };
  };

  const stopSlowTimer = (state: ModeState): void => {
    if (state.slowTimer === null) return;
    view.clearTimeout(state.slowTimer);
    state.slowTimer = null;
  };

  const renderLoading = (state: ModeState): void => {
    state.loading = true;
    state.section.setAttribute("aria-busy", "true");
    state.entries = [];
    state.selected = -1;
    state.summary.textContent = state.locale === "zh-CN" ? "搜索中…" : "Searching…";
    state.chips.replaceChildren();
    state.chips.hidden = true;
    renderJarvisLoading(ownerDocument, state.results);
    stopSlowTimer(state);
    const generation = state.generation;
    state.slowTimer = view.setTimeout(() => {
      state.slowTimer = null;
      if (mode !== state || !state.loading || state.generation !== generation) return;
      state.summary.textContent =
        state.locale === "zh-CN"
          ? "Jarvis 响应较慢，仍在查询…"
          : "Jarvis is slow, still searching…";
    }, SLOW_NOTICE_MS);
  };

  const selectRow = (state: ModeState, index: number): void => {
    state.selected = index >= 0 && index < state.entries.length ? index : -1;
    state.entries.forEach(({ row }, current) => {
      const selected = current === state.selected;
      row.setAttribute("aria-selected", String(selected));
      for (const name of ROW_HIGHLIGHT_CLASSES) row.classList.toggle(name, selected);
      row.classList.toggle(ROW_IDLE_CLASS, !selected);
      if (selected) row.scrollIntoView({ block: "nearest" });
    });
  };

  const renderChips = (state: ModeState, conditions: readonly JarvisBugCondition[]): void => {
    state.chips.replaceChildren();
    for (const condition of conditions) {
      const chip = createJarvisConditionChip(ownerDocument, condition);
      chip.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.omit.add(condition.key);
        state.input.focus({ preventScroll: true });
        void requestSearch(state, state.input.value);
      });
      state.chips.append(chip);
    }
    state.chips.hidden = conditions.length === 0;
  };

  const renderRows = (state: ModeState, bugs: readonly JarvisBug[]): void => {
    state.selected = -1;
    state.entries = renderJarvisBugRows(ownerDocument, state.results, bugs, state.locale, {
      onSelect: (index) => selectRow(state, index),
      onChoose: (bug) => void choose(state, bug),
    });
  };

  const renderEmpty = (state: ModeState, result: JarvisBugSearchResult): void => {
    state.entries = [];
    state.selected = -1;
    let message: string;
    if (!result.available) {
      message =
        result.errorCode === "not_logged_in"
          ? state.locale === "zh-CN"
            ? "Jarvis 未安装或未登录"
            : "Jarvis is not installed or signed in"
          : jarvisErrorText(result.errorCode, state.locale);
    } else if (result.errorCode) {
      message = jarvisErrorText(result.errorCode, state.locale);
    } else {
      message =
        state.locale === "zh-CN"
          ? "没有符合条件的 Bug。试试去掉一个条件或换个说法。"
          : "No matching bugs. Try removing a condition or rephrasing.";
    }
    const action =
      !result.available &&
      (result.errorCode === "not_installed" || result.errorCode === "not_logged_in") &&
      options.openSettings
        ? {
            label: state.locale === "zh-CN" ? "去设置" : "Open settings",
            onSelect: (opener: HTMLElement) => {
              options.openSettings?.(opener);
              exitMode(false);
            },
          }
        : undefined;
    renderJarvisEmpty(ownerDocument, state.results, message, action);
  };

  const renderResult = (state: ModeState, result: JarvisBugSearchResult): void => {
    state.loading = false;
    stopSlowTimer(state);
    state.section.removeAttribute("aria-busy");
    state.lastQuery = state.input.value.trim();
    renderChips(state, result.conditions);
    if (!result.available || result.errorCode) {
      state.summary.textContent = "";
    } else if (result.capped) {
      state.summary.textContent =
        state.locale === "zh-CN"
          ? `已显示前 ${result.bugs.length} 条`
          : `Showing the first ${result.bugs.length}`;
    } else {
      state.summary.textContent =
        state.locale === "zh-CN" ? `${result.total} 条` : `${result.total} bugs`;
    }
    if (result.bugs.length === 0) {
      renderEmpty(state, result);
    } else {
      renderRows(state, result.bugs);
    }
  };

  const requestSearch = async (state: ModeState, query: string): Promise<void> => {
    state.generation += 1;
    const generation = state.generation;
    renderLoading(state);
    const hostId = options.readHostId(state.trigger.editor);
    if (!hostId) {
      state.loading = false;
      stopSlowTimer(state);
      state.section.removeAttribute("aria-busy");
      state.summary.textContent = "";
      renderEmpty(state, {
        available: false,
        errorCode: "jarvis_failed",
        conditions: [],
        bugs: [],
        total: 0,
        capped: false,
      });
      return;
    }
    const result = await options
      .search(hostId, { query, omit: [...state.omit] })
      .catch((): JarvisBugSearchResult => ({
        available: false,
        errorCode: "jarvis_failed",
        conditions: [],
        bugs: [],
        total: 0,
        capped: false,
      }));
    if (mode !== state || generation !== state.generation || !state.section.isConnected) return;
    renderResult(state, result);
  };

  const scheduleSearch = (state: ModeState): void => {
    if (state.timer !== null) view.clearTimeout(state.timer);
    state.timer = view.setTimeout(() => {
      state.timer = null;
      if (mode !== state) return;
      void requestSearch(state, state.input.value.trim());
    }, DEBOUNCE_MS);
  };

  const deleteTriggerText = async (trigger: Trigger): Promise<boolean> => {
    const range: NativeTextRange = {
      node: trigger.node,
      start: trigger.start,
      end: trigger.end,
      expected: `@${trigger.query}`,
    };
    if (deleteNativeRange(trigger.editor, range)) return true;
    if (!(await selectTriggerText(trigger))) return false;
    ownerDocument.execCommand("delete");
    await new Promise<void>((resolve) => view.setTimeout(resolve, 0));
    return true;
  };

  const panelRectOf = (
    list: HTMLElement,
  ): { left: number; top: number; width: number; height: number } => {
    const panel =
      list.closest<HTMLElement>('[class*="suggestionMenu"]') ?? list.parentElement ?? list;
    const rect = panel.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };

  /** Keep the mode visible at the popup's old position if the popup closes. */
  const detachMode = (state: ModeState): void => {
    if (state.detachedHost) return;
    const rect = state.lastRect ?? { left: 24, top: 120, width: 360, height: 320 };
    const host = ownerDocument.createElement("div");
    host.setAttribute("data-codexhost-jarvis-detached", "true");
    host.className =
      "fixed z-[2147483647] flex flex-col overflow-hidden rounded-[var(--radius-suggestion-menu,var(--radius-2xl))] border border-default bg-surface-elevated-secondary text-sm shadow-lg";
    host.style.left = `${Math.max(8, rect.left)}px`;
    host.style.top = `${Math.max(8, rect.top)}px`;
    host.style.width = `${Math.max(240, rect.width)}px`;
    host.style.maxHeight = `${Math.max(160, rect.height)}px`;
    host.append(state.section);
    ownerDocument.body.append(host);
    state.detachedHost = host;
    state.input.focus({ preventScroll: true });
  };

  const startMode = (
    trigger: Trigger,
    prefill: string,
    insertAtSelection: boolean,
    fallbackRect: { left: number; top: number; width: number; height: number } | null = null,
  ): void => {
    const list = nativeList(trigger.editor);
    if (!list && !fallbackRect) return;
    const state = buildMode(trigger);
    state.insertAtSelection = insertAtSelection;
    if (prefill) state.input.value = prefill;
    state.clear.style.display = state.input.value.length === 0 ? "none" : "inline-flex";
    if (list) {
      state.lastRect = panelRectOf(list);
      list.append(state.section);
      hideNativeChildren(state, list);
      list.scrollTop = 0;
    } else {
      state.lastRect = fallbackRect;
      detachMode(state);
    }
    mode = state;

    state.back.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      exitMode(true);
    });
    state.input.addEventListener("pointerdown", (event) => event.stopPropagation());
    state.input.addEventListener("input", () => {
      state.clear.style.display = state.input.value.length === 0 ? "none" : "inline-flex";
      if (state.input.value.trim() !== state.lastQuery) state.omit.clear();
      scheduleSearch(state);
    });
    state.clear.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.input.value.length === 0) return;
      state.input.value = "";
      state.clear.style.display = "none";
      state.omit.clear();
      state.input.focus({ preventScroll: true });
      void requestSearch(state, "");
    });
    state.input.addEventListener("keydown", (event) => event.stopPropagation());
    state.input.focus({ preventScroll: true });
    void requestSearch(state, prefill);
  };

  function enterMode(trigger: Trigger, prefill = "", consumeTrigger = false): void {
    if (!consumeTrigger && !triggerIntact(trigger)) {
      removeEntry();
      return;
    }
    const list = nativeList(trigger.editor);
    const fallbackRect = list ? panelRectOf(list) : null;
    removeEntry();
    removeMode();
    if (!consumeTrigger) {
      startMode(trigger, prefill, false, fallbackRect);
      return;
    }
    void deleteTriggerText(trigger).then((removed) => {
      if (mode || !trigger.editor.isConnected) return;
      startMode(trigger, prefill, removed, fallbackRect);
    });
  }

  function exitMode(refocusComposer: boolean): void {
    if (!mode) return;
    const trigger = mode.trigger;
    suppressed = trigger.query;
    removeMode();
    if (refocusComposer && trigger.editor.isConnected) {
      trigger.editor.focus({ preventScroll: true });
    }
  }

  const selectTriggerText = async (trigger: Trigger): Promise<boolean> => {
    const selection = ownerDocument.getSelection();
    if (!selection) return false;
    const range = ownerDocument.createRange();
    range.setStart(trigger.node, trigger.start);
    range.setEnd(trigger.node, trigger.end);
    trigger.editor.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    await new Promise<void>((resolve) => view.setTimeout(resolve, 0));
    return true;
  };

  async function choose(state: ModeState, bug: JarvisBug): Promise<void> {
    if (mode !== state || inserting) return;
    const trigger = state.trigger;
    if (!state.insertAtSelection && !triggerIntact(trigger)) {
      exitMode(false);
      return;
    }
    const expected = `@${trigger.query}`;
    const label = jarvisBugLabel(bug);
    const path = jarvisMentionPath({ kind: "bug", id: bug.id, projectId: bug.projectId });
    const mention = { name: `jarvis-bug-${bug.id}`, displayName: label, path };
    const carrier = `${formatJarvisMentionLink({
      kind: "bug",
      id: bug.id,
      projectId: bug.projectId,
      label,
    })} `;
    if (state.insertAtSelection) {
      suppressed = trigger.query;
      removeMode();
      inserting = true;
      try {
        if (insertNativeAgentMentionAtSelection(trigger.editor, mention)) return;
        const pasted = dispatchPlainTextPaste(trigger.editor, carrier);
        if (!pasted) ownerDocument.execCommand("insertText", false, carrier);
      } finally {
        inserting = false;
      }
      return;
    }
    const range: NativeTextRange = {
      node: trigger.node,
      start: trigger.start,
      end: trigger.end,
      expected,
    };
    suppressed = trigger.query;
    removeMode();
    inserting = true;
    try {
      if (insertNativeAgentMention(trigger.editor, range, mention)) return;
      if (!(await selectTriggerText(trigger))) return;
      const pasted = dispatchPlainTextPaste(trigger.editor, carrier);
      if (!pasted) ownerDocument.execCommand("insertText", false, carrier);
    } finally {
      inserting = false;
    }
  }

  const schedule = (event?: Event): void => {
    if (inserting || composing) return;
    if (mode) {
      const target = event?.target ?? null;
      if (target && isInside(target as Node, mode.section)) return;
      if (event?.type === "input") {
        // Focus moved back to the Composer; the search field is no longer the
        // active surface, so leave the submenu.
        exitMode(false);
      }
      return;
    }
    const trigger = readTrigger();
    if (!trigger) {
      suppressed = null;
      removeEntry();
      return;
    }
    if (suppressed !== null && suppressed === trigger.query) return;
    suppressed = null;
    if (entry && entry.trigger.query === trigger.query && entry.trigger.node === trigger.node) {
      entry.trigger = trigger;
      return;
    }
    removeEntry();
    scheduleEntry(trigger);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (mode) {
      const state = mode;
      let handled = true;
      if (event.key === "Escape") {
        exitMode(true);
      } else if (event.key === "ArrowDown") {
        if (state.entries.length === 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        selectRow(state, state.selected < 0 ? 0 : (state.selected + 1) % state.entries.length);
      } else if (event.key === "ArrowUp") {
        if (state.entries.length === 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        selectRow(state, state.selected <= 0 ? state.entries.length - 1 : state.selected - 1);
      } else if (event.key === "Enter" || event.key === "Tab") {
        const picked = state.selected >= 0 ? state.entries[state.selected] : undefined;
        if (picked) void choose(state, picked.bug);
      } else {
        handled = false;
      }
      if (!handled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!entry) return;
    if (event.key !== "Escape") return;
    const selected = entry.row.getAttribute("aria-current") === "true";
    suppressed = entry.trigger.query;
    removeEntry();
    if (!selected) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (mode) {
      if (isInside(target, mode.section)) return;
      exitMode(false);
      return;
    }
    if (!entry) return;
    if (isInside(target, entry.section)) return;
    const list = nativeList(entry.trigger.editor);
    if (list?.contains(target)) return;
    removeEntry();
  };

  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    schedule();
  };

  const ensureAttached = (): void => {
    if (reattachScheduled) return;
    reattachScheduled = true;
    view.setTimeout(() => {
      reattachScheduled = false;
      if (mode) {
        if (mode.detachedHost) return;
        const list = nativeList(mode.trigger.editor);
        if (list) {
          mode.lastRect = panelRectOf(list);
          if (mode.section.parentElement !== list) list.append(mode.section);
          hideNativeChildren(mode, list);
          return;
        }
        // Focusing the icon-less search input can blur the Composer and close
        // the native popup; keep the mode at the popup's last position.
        detachMode(mode);
        return;
      }
      if (!entry) {
        if (!entryPending) return;
        const pending = entryPending;
        const list = nativeList(pending.editor);
        if (list) attachEntry(pending);
        return;
      }
      const list = nativeList(entry.trigger.editor);
      if (!list) {
        removeEntry();
        return;
      }
      const section = ensureWorkbenchSection(ownerDocument, list, options.readLocale());
      if (entry.row.parentElement !== section.items) section.items.append(entry.row);
      entry.section = section.element;
    }, 60);
  };

  const observer = new MutationObserver(ensureAttached);
  observer.observe(ownerDocument.body, { childList: true, subtree: true });

  view.addEventListener("keydown", onKeyDown, true);
  ownerDocument.addEventListener("input", schedule, true);
  ownerDocument.addEventListener("selectionchange", schedule);
  ownerDocument.addEventListener("compositionstart", onCompositionStart, true);
  ownerDocument.addEventListener("compositionend", onCompositionEnd, true);
  ownerDocument.addEventListener("pointerdown", onPointerDown, true);

  return {
    refresh: schedule,
    dispose() {
      removeMode();
      removeEntry();
      observer.disconnect();
      view.removeEventListener("keydown", onKeyDown, true);
      ownerDocument.removeEventListener("input", schedule, true);
      ownerDocument.removeEventListener("selectionchange", schedule);
      ownerDocument.removeEventListener("compositionstart", onCompositionStart, true);
      ownerDocument.removeEventListener("compositionend", onCompositionEnd, true);
      ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
    },
  };
}

/** Mirrors Desktop's restore path when its controller is unavailable. */
function dispatchPlainTextPaste(editor: HTMLElement, text: string): boolean {
  const view = editor.ownerDocument.defaultView;
  if (!view?.DataTransfer || !view.ClipboardEvent) return false;
  const data = new view.DataTransfer();
  data.setData("text/plain", text);
  const event = new view.ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: data,
  });
  editor.dispatchEvent(event);
  return event.defaultPrevented;
}
