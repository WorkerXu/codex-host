/**
 * Jarvis rows in Codex Desktop's native `@` suggestion menu.
 *
 * Desktop owns the `@` menu: rows, keyboard navigation and selection stay
 * native. Once the query settles, the Host is asked for Jarvis suggestions and
 * the rows are appended below the native results in Desktop's own menu
 * container. When Desktop has no native results (or re-renders the container
 * away), the same rows move to a floating panel anchored to the Composer.
 * Selecting a row replaces `@query` with a native mention chip whose path is
 * `jarvis://…`; the Host expands that carrier on submission.
 */
import {
  formatJarvisMentionLink,
  jarvisMentionPath,
  type JarvisKind,
  type JarvisSuggestion,
} from "@codexhost/shared-contracts";

import {
  HEADER_CLASS,
  LIST_CLASS,
  MENU_CLASS,
  ROW_CLASS,
  ROW_CONTENT_CLASS,
  ROW_HIGHLIGHT_CLASSES,
  ROW_IDLE_CLASS,
} from "./renderer-delegation-mention.js";
import {
  insertNativeAgentMention,
  type NativeTextRange,
} from "./renderer-native-composer-controller.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

const SECTION_ATTRIBUTE = "data-codexhost-jarvis-section";
const PANEL_ATTRIBUTE = "data-codexhost-jarvis-panel";
const TRIGGER_PATTERN = /(?:^|\s)@([^\s@]{0,64})$/u;
const DEBOUNCE_MS = 300;
const MAX_QUERY_LENGTH = 64;
const MENU_MAX_HEIGHT = 420;
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 4;
const NATIVE_LIST_CLASS = "vertical-scroll-fade-mask";

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

const KIND_ORDER: readonly JarvisKind[] = ["project", "requirement", "task", "bug"];

export function jarvisKindLabel(kind: JarvisKind, locale: RendererSettingsLocale): string {
  if (locale === "zh-CN") {
    return kind === "project"
      ? "项目"
      : kind === "requirement"
        ? "需求"
        : kind === "task"
          ? "任务"
          : "Bug";
  }
  return kind === "project"
    ? "Project"
    : kind === "requirement"
      ? "Requirement"
      : kind === "task"
        ? "Task"
        : "Bug";
}

export function truncateJarvisText(value: string, limit: number): string {
  const text = value.trim().replace(/\s+/gu, " ");
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text;
}

/** Chip and row label, e.g. `Bug #928 填写已查码的序列号…`. */
export function jarvisSuggestionLabel(
  suggestion: JarvisSuggestion,
  locale: RendererSettingsLocale,
): string {
  return `${jarvisKindLabel(suggestion.kind, locale)} #${suggestion.id} ${truncateJarvisText(
    suggestion.title,
    28,
  )}`;
}

export function jarvisStatusText(
  suggestion: JarvisSuggestion,
  locale: RendererSettingsLocale,
): string {
  if (suggestion.statusLabel) return suggestion.statusLabel;
  if (suggestion.status === undefined) return "";
  if (suggestion.kind === "bug") {
    const labels =
      locale === "zh-CN"
        ? ({ 1: "待处理", 2: "已解决", 3: "已关闭" } as Record<number, string>)
        : ({ 1: "Open", 2: "Resolved", 3: "Closed" } as Record<number, string>);
    return (
      labels[suggestion.status] ??
      (locale === "zh-CN" ? `状态 ${suggestion.status}` : `Status ${suggestion.status}`)
    );
  }
  return locale === "zh-CN" ? `状态 ${suggestion.status}` : `Status ${suggestion.status}`;
}

export function groupJarvisSuggestions(
  suggestions: readonly JarvisSuggestion[],
): { kind: JarvisKind; suggestions: JarvisSuggestion[] }[] {
  return KIND_ORDER.flatMap((kind) => {
    const group = suggestions.filter((suggestion) => suggestion.kind === kind);
    return group.length > 0 ? [{ kind, suggestions: group }] : [];
  });
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
}

/**
 * Desktop's menu is a listbox with a scrollable `vertical-scroll-fade-mask`
 * child. Appending there keeps Jarvis rows in the native scroll area.
 */
export function findNativeSuggestionList(
  document: Document,
  anchor: Element | null,
): HTMLElement | null {
  const anchorRect = anchor?.getBoundingClientRect();
  const lists = [...document.querySelectorAll<HTMLElement>('[role="listbox"]')]
    .filter(
      (element) =>
        !element.closest(
          `[${SECTION_ATTRIBUTE}],[${PANEL_ATTRIBUTE}],[data-codexhost-delegation-mention-menu]`,
        ),
    )
    .filter(isVisible)
    .map((element, order) => {
      const scroll =
        element.querySelector<HTMLElement>(`.${NATIVE_LIST_CLASS}`) ??
        (element.classList.contains(NATIVE_LIST_CLASS) ? element : element);
      const rect = element.getBoundingClientRect();
      const distance = anchorRect
        ? rect.top >= anchorRect.top
          ? rect.top - anchorRect.bottom
          : anchorRect.top - rect.bottom
        : 0;
      const preferred = scroll.classList.contains(NATIVE_LIST_CLASS) ? 1 : 0;
      return { scroll, distance, preferred, order };
    })
    .filter(({ distance }) => !anchorRect || Math.abs(distance) < 600);
  lists.sort(
    (left, right) =>
      right.preferred - left.preferred ||
      left.distance - right.distance ||
      right.order - left.order,
  );
  return lists[0]?.scroll ?? null;
}

export interface RendererJarvisMentionOptions {
  isComposerEditor(editor: HTMLElement): boolean;
  /** Desktop Host that runs the Composer's Thread; null while unknown. */
  readHostId(editor: HTMLElement): string | null;
  /** Classify, fetch candidates on the Host and rank on the local Host. */
  suggest(hostId: string, query: string): Promise<{ suggestions: JarvisSuggestion[] } | null>;
  readLocale(): RendererSettingsLocale;
  anchorForEditor(editor: HTMLElement): Element | null;
}

export interface RendererJarvisMentionControl {
  refresh(): void;
  dispose(): void;
}

interface ActiveTrigger {
  editor: HTMLElement;
  node: Text;
  start: number;
  end: number;
  query: string;
}

interface RenderedState {
  trigger: ActiveTrigger;
  section: HTMLElement;
  entries: { suggestion: JarvisSuggestion; row: HTMLElement }[];
  panel: HTMLElement | null;
}

export function installRendererJarvisMention(
  ownerDocument: Document,
  options: RendererJarvisMentionOptions,
): RendererJarvisMentionControl {
  const view = ownerDocument.defaultView;
  if (!view) return { refresh: () => undefined, dispose: () => undefined };

  let active: RenderedState | null = null;
  let timer: number | null = null;
  let generation = 0;
  let selected = -1;
  let composing = false;
  let inserting = false;
  let reattachScheduled = false;
  let reattachAttempts = 0;
  let suppressedQuery: string | null = null;

  const clearTimer = (): void => {
    if (timer !== null) view.clearTimeout(timer);
    timer = null;
  };

  const removeSection = (): void => {
    active?.section.remove();
    active?.panel?.remove();
    active = null;
    selected = -1;
  };

  const close = (): void => {
    clearTimer();
    generation += 1;
    removeSection();
  };

  const rowMeta = (suggestion: JarvisSuggestion, locale: RendererSettingsLocale): string => {
    const parts = [`#${suggestion.id}`];
    const status = jarvisStatusText(suggestion, locale);
    if (status) parts.push(status);
    if (suggestion.kind === "bug") {
      if (suggestion.assigneeName) {
        parts.push(
          locale === "zh-CN"
            ? `指派 ${suggestion.assigneeName}`
            : `Assigned ${suggestion.assigneeName}`,
        );
      }
      if (suggestion.creatorName) {
        parts.push(
          locale === "zh-CN" ? `创建 ${suggestion.creatorName}` : `By ${suggestion.creatorName}`,
        );
      }
    }
    return parts.join(" · ");
  };

  const buildSection = (
    trigger: ActiveTrigger,
    suggestions: readonly JarvisSuggestion[],
  ): RenderedState => {
    const locale = options.readLocale();
    const section = ownerDocument.createElement("div");
    section.setAttribute(SECTION_ATTRIBUTE, "true");
    section.className = "flex w-full flex-col";
    const header = ownerDocument.createElement("div");
    header.className = HEADER_CLASS;
    header.textContent = "Jarvis";
    section.append(header);
    const entries: RenderedState["entries"] = [];
    for (const group of groupJarvisSuggestions(suggestions)) {
      const groupHeader = ownerDocument.createElement("div");
      groupHeader.className = "text-codex-description px-row-x py-1 text-xs";
      groupHeader.textContent = jarvisKindLabel(group.kind, locale);
      section.append(groupHeader);
      for (const suggestion of group.suggestions) {
        if (suggestion.kind === "bug" && !suggestion.projectId) continue;
        const row = ownerDocument.createElement("div");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");
        row.setAttribute("data-jarvis-kind", suggestion.kind);
        row.setAttribute("data-jarvis-id", String(suggestion.id));
        row.className = ROW_CLASS;
        const content = ownerDocument.createElement("div");
        content.className = ROW_CONTENT_CLASS;
        const label = ownerDocument.createElement("span");
        label.className = "min-w-0 shrink truncate";
        label.textContent = suggestion.title;
        const meta = ownerDocument.createElement("span");
        meta.className = "flex-1 truncate text-codex-description";
        meta.textContent = rowMeta(suggestion, locale);
        content.append(label, meta);
        row.append(content);
        const index = entries.length;
        row.addEventListener("pointermove", (event) => {
          event.stopPropagation();
          select(index);
        });
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        row.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const entry = entries.find((candidate) => candidate.row === row);
          if (entry) void choose(entry.suggestion);
        });
        entries.push({ suggestion, row });
        row.dataset.jarvisIndex = String(index);
        section.append(row);
      }
    }
    return { trigger, section, entries, panel: null };
  };

  const highlight = (): void => {
    if (!active) return;
    active.entries.forEach(({ row }, index) => {
      const isSelected = index === selected;
      row.setAttribute("aria-selected", String(isSelected));
      for (const name of ROW_HIGHLIGHT_CLASSES) row.classList.toggle(name, isSelected);
      row.classList.toggle(ROW_IDLE_CLASS, !isSelected);
      if (isSelected) row.scrollIntoView({ block: "nearest" });
    });
  };

  const select = (index: number): void => {
    if (!active) return;
    selected = index >= 0 && index < active.entries.length ? index : -1;
    highlight();
  };

  const attachSection = (state: RenderedState, allowFallback: boolean): void => {
    const anchor = options.anchorForEditor(state.trigger.editor);
    const native = findNativeSuggestionList(ownerDocument, anchor);
    if (native) {
      native.append(state.section);
      state.panel?.remove();
      state.panel = null;
      return;
    }
    if (!allowFallback) {
      close();
      return;
    }
    // Desktop's menu has no native rows (or closed); keep Jarvis results
    // visible in a panel attached to the Composer.
    if (!state.panel) {
      state.panel = ownerDocument.createElement("div");
      state.panel.setAttribute(PANEL_ATTRIBUTE, "true");
      state.panel.className = MENU_CLASS;
      Object.assign(state.panel.style, {
        display: "flex",
        position: "fixed",
        zIndex: "2147483647",
        maxHeight: `min(${MENU_MAX_HEIGHT}px, calc(100vh - ${VIEWPORT_MARGIN * 2}px))`,
        padding: "var(--spacing)",
      } satisfies Partial<CSSStyleDeclaration>);
      const list = ownerDocument.createElement("div");
      list.className = LIST_CLASS;
      list.setAttribute("role", "listbox");
      state.panel.append(list);
      ownerDocument.body.append(state.panel);
    }
    const list = state.panel.querySelector(`.${NATIVE_LIST_CLASS.split(" ")[0]}`) ?? state.panel;
    list.append(state.section);
    positionPanel(state);
  };

  const positionPanel = (state: RenderedState): void => {
    const panelElement = state.panel;
    if (!panelElement) return;
    const anchor = options.anchorForEditor(state.trigger.editor) ?? state.trigger.editor;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(rect.width, view.innerWidth - VIEWPORT_MARGIN * 2);
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, view.innerWidth - width - VIEWPORT_MARGIN),
    );
    panelElement.style.width = `${width}px`;
    panelElement.style.left = `${left}px`;
    const height = panelElement.getBoundingClientRect().height;
    const above = rect.top >= height + MENU_GAP + VIEWPORT_MARGIN;
    panelElement.style.top = above
      ? `${rect.top - height - MENU_GAP}px`
      : `${Math.min(view.innerHeight - height - VIEWPORT_MARGIN, rect.bottom + MENU_GAP)}px`;
  };

  const readTrigger = (): ActiveTrigger | null => {
    const selection = ownerDocument.getSelection();
    if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
    const node = selection.anchorNode;
    if (!node || node.nodeType !== node.TEXT_NODE) return null;
    const editor = node.parentElement?.closest<HTMLElement>('[contenteditable="true"]');
    if (!editor || !options.isComposerEditor(editor)) return null;
    const text = node as Text;
    const found = findJarvisTrigger(text.data.slice(0, selection.anchorOffset));
    if (!found || found.query.length === 0) return null;
    return {
      editor,
      node: text,
      start: found.start,
      end: selection.anchorOffset,
      query: found.query,
    };
  };

  const schedule = (): void => {
    if (inserting || composing) return;
    const trigger = readTrigger();
    if (!trigger) {
      suppressedQuery = null;
      close();
      return;
    }
    if (suppressedQuery !== null && suppressedQuery === trigger.query) return;
    suppressedQuery = null;
    if (active?.trigger.query === trigger.query && active.trigger.node === trigger.node) {
      active.trigger = trigger;
      return;
    }
    close();
    const requestGeneration = generation;
    const hostId = options.readHostId(trigger.editor);
    if (!hostId) return;
    timer = view.setTimeout(() => {
      timer = null;
      if (requestGeneration !== generation) return;
      const query = trigger.query;
      void Promise.resolve(options.suggest(hostId, query))
        .then((result) => {
          if (requestGeneration !== generation || !trigger.node.isConnected) return;
          if (!result || result.suggestions.length === 0) return;
          const state = buildSection(trigger, result.suggestions);
          active = state;
          selected = -1;
          attachSection(state, true);
          highlight();
        })
        .catch(() => undefined);
    }, DEBOUNCE_MS);
  };

  const runWithInsertionGuard = async (operation: () => Promise<void>): Promise<void> => {
    inserting = true;
    try {
      await operation();
    } finally {
      inserting = false;
    }
  };

  const choose = async (suggestion: JarvisSuggestion): Promise<void> => {
    const state = active;
    if (!state) return;
    const trigger = state.trigger;
    const expected = `@${trigger.query}`;
    if (trigger.node.data.slice(trigger.start, trigger.end) !== expected) {
      close();
      return;
    }
    const label = jarvisSuggestionLabel(suggestion, options.readLocale());
    const target = {
      kind: suggestion.kind,
      id: suggestion.id,
      ...(suggestion.projectId ? { projectId: suggestion.projectId } : {}),
    };
    const path = jarvisMentionPath(target);
    const range: NativeTextRange = {
      node: trigger.node,
      start: trigger.start,
      end: trigger.end,
      expected,
    };
    close();
    await runWithInsertionGuard(async () => {
      if (
        insertNativeAgentMention(trigger.editor, range, {
          name: `jarvis-${suggestion.kind}-${suggestion.id}`,
          displayName: label,
          path,
        })
      ) {
        return;
      }
      if (!(await selectTriggerText(trigger))) return;
      const carrier = `${formatJarvisMentionLink({ ...target, label })} `;
      const pasted = dispatchPlainTextPaste(trigger.editor, carrier);
      if (!pasted) ownerDocument.execCommand("insertText", false, carrier);
    });
  };

  const selectTriggerText = async (trigger: ActiveTrigger): Promise<boolean> => {
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

  const nativeRows = (): HTMLElement[] => {
    if (!active) return [];
    const native = findNativeSuggestionList(
      ownerDocument,
      options.anchorForEditor(active.trigger.editor),
    );
    if (!native) return [];
    return [...native.querySelectorAll<HTMLElement>('[role="option"]')].filter(
      (element) => !element.closest(`[${SECTION_ATTRIBUTE}]`),
    );
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (event.key === "Escape" && !active) {
      // Native Esc closes its menu; do not reopen Jarvis for the same text.
      suppressedQuery = readTrigger()?.query ?? null;
      return;
    }
    if (!active) return;
    const count = active.entries.length;
    if (count === 0) return;
    let handled = true;
    if (event.key === "ArrowDown") {
      if (selected < 0) {
        const rows = nativeRows();
        const current = rows.findIndex((row) => row.getAttribute("aria-selected") === "true");
        if (rows.length === 0 || current === rows.length - 1) select(0);
        else handled = false;
      } else {
        select((selected + 1) % count);
      }
    } else if (event.key === "ArrowUp") {
      if (selected > 0) select(selected - 1);
      else if (selected === 0) {
        select(-1);
        handled = false;
      } else handled = false;
    } else if (event.key === "Enter" || event.key === "Tab") {
      const entry = selected >= 0 ? active.entries[selected] : undefined;
      if (entry) void choose(entry.suggestion);
      else handled = false;
    } else if (event.key === "Escape") {
      if (selected >= 0) {
        select(-1);
        suppressedQuery = active.trigger.query;
        close();
      } else {
        suppressedQuery = active.trigger.query;
        handled = false;
      }
    } else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!active) return;
    const target = event.target as Node;
    if (active.panel?.contains(target) || active.section.contains(target)) return;
    const native = findNativeSuggestionList(
      ownerDocument,
      options.anchorForEditor(active.trigger.editor),
    );
    if (native?.contains(target)) return;
    suppressedQuery = active.trigger.query;
    close();
  };

  const onViewportChange = (): void => {
    if (active?.panel) positionPanel(active);
  };

  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    schedule();
  };

  const ensureAttached = (): void => {
    if (!active || reattachScheduled) return;
    reattachScheduled = true;
    view.setTimeout(() => {
      reattachScheduled = false;
      if (!active) return;
      if (active.panel) {
        reattachAttempts = 0;
        const native = findNativeSuggestionList(
          ownerDocument,
          options.anchorForEditor(active.trigger.editor),
        );
        if (native) {
          native.append(active.section);
          active.panel.remove();
          active.panel = null;
          highlight();
        } else if (!active.panel.isConnected) {
          close();
        } else if (!active.panel.contains(active.section)) {
          active.panel.append(active.section);
        }
        return;
      }
      if (active.section.isConnected) {
        reattachAttempts = 0;
        return;
      }
      // Desktop may briefly replace its menu subtree. Retry a few frames before
      // treating the menu as dismissed; a closed menu stays closed.
      const native = findNativeSuggestionList(
        ownerDocument,
        options.anchorForEditor(active.trigger.editor),
      );
      if (native) {
        native.append(active.section);
        reattachAttempts = 0;
        highlight();
        return;
      }
      if (reattachAttempts < 3) {
        reattachAttempts += 1;
        ensureAttached();
        return;
      }
      reattachAttempts = 0;
      close();
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
  view.addEventListener("resize", onViewportChange);
  view.addEventListener("scroll", onViewportChange, true);

  return {
    refresh: schedule,
    dispose() {
      close();
      observer.disconnect();
      view.removeEventListener("keydown", onKeyDown, true);
      ownerDocument.removeEventListener("input", schedule, true);
      ownerDocument.removeEventListener("selectionchange", schedule);
      ownerDocument.removeEventListener("compositionstart", onCompositionStart, true);
      ownerDocument.removeEventListener("compositionend", onCompositionEnd, true);
      ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
      view.removeEventListener("resize", onViewportChange);
      view.removeEventListener("scroll", onViewportChange, true);
    },
  };
}

/** Returns true when the editor consumed the paste. */
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
