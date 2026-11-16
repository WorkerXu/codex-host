/**
 * The 「钉钉」 row inside the shared 「工作台」 group of Desktop's native `@` menu.
 *
 * Desktop owns the menu; the row only opens the workbench page and removes the
 * typed trigger text. Selecting it never inserts a mention by itself — the
 * page's embed actions do that against the Composer remembered here.
 */
import {
  createWorkbenchRow,
  createWorkbenchSection,
  ensureWorkbenchSection,
  findNativeSuggestionList,
  highlightWorkbenchRow,
  registerWorkbenchRow,
  removeWorkbenchSectionIfEmpty,
  waitForNativeSuggestionList,
} from "./renderer-native-at-menu.js";
import { findJarvisTrigger } from "./renderer-jarvis-mention.js";
import { createDingTalkMark } from "./settings/dingtalk-icon.js";

const ROW_ATTRIBUTE = "data-codexhost-dingtalk-entry";

export interface RendererDingTalkEntryOptions {
  isComposerEditor(editor: HTMLElement): boolean;
  anchorForEditor(editor: HTMLElement): Element | null;
  /** Opens the workbench page; the editor survives until the page closes. */
  open(editor: HTMLElement): boolean;
}

export interface RendererDingTalkEntryControl {
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
  row: HTMLButtonElement;
  section: HTMLElement | null;
  unregister: () => void;
}

function matchesEntry(query: string): boolean {
  if (query.length === 0) return true;
  const value = query.toLowerCase();
  return "钉钉".startsWith(value) || "dingtalk".startsWith(value);
}

function buildRow(document: Document, locale: string): HTMLButtonElement {
  return createWorkbenchRow(document, {
    rowAttribute: ROW_ATTRIBUTE,
    icon: createDingTalkMark(document, 16),
    label: locale === "zh-CN" ? "钉钉" : "DingTalk",
    description: locale === "zh-CN" ? "打开钉钉工作台" : "Open the DingTalk workbench",
  });
}

/** The shared workbench section with only the DingTalk row; previews use it. */
export function createDingTalkEntrySection(
  document: Document,
  locale: string,
): { element: HTMLElement; row: HTMLElement } {
  const section = createWorkbenchSection(document, locale === "zh-CN" ? "zh-CN" : "en");
  const row = buildRow(document, locale);
  section.items.append(row);
  return { element: section.element, row };
}

/** The row alone; used by previews that own their section chrome. */
export function createDingTalkEntryRow(document: Document, locale: string): HTMLElement {
  return buildRow(document, locale);
}

export function installRendererDingTalkEntry(
  ownerDocument: Document,
  options: RendererDingTalkEntryOptions,
): RendererDingTalkEntryControl {
  const view = ownerDocument.defaultView;
  if (!view) return { refresh: () => undefined, dispose: () => undefined };
  let current: EntryState | null = null;
  let pending: Trigger | null = null;
  let cancelWait: (() => void) | null = null;
  let suppressed: string | null = null;

  const locale = (): string => ownerDocument.documentElement.lang || view.navigator.language;

  const stopWait = (): void => {
    cancelWait?.();
    cancelWait = null;
  };

  const remove = (): void => {
    stopWait();
    pending = null;
    current?.unregister();
    current?.row.remove();
    removeWorkbenchSectionIfEmpty(current?.section ?? null);
    current = null;
  };

  const attachRow = (state: EntryState, list: HTMLElement): void => {
    const section = ensureWorkbenchSection(
      ownerDocument,
      list,
      locale().startsWith("zh") ? "zh-CN" : "en",
    );
    if (state.row.parentElement !== section.items) section.items.append(state.row);
    state.section = section.element;
  };

  const listFor = (trigger: Trigger): HTMLElement | null =>
    findNativeSuggestionList(ownerDocument, options.anchorForEditor(trigger.editor));

  const attach = (trigger: Trigger): void => {
    const list = listFor(trigger);
    if (!list) {
      // The popup mounts after `input`; wait for it instead of drawing a panel.
      pending = trigger;
      stopWait();
      cancelWait = waitForNativeSuggestionList(
        ownerDocument,
        () => options.anchorForEditor(trigger.editor),
        () => {
          cancelWait = null;
          if (current || pending !== trigger) return;
          attach(trigger);
        },
      );
      return;
    }
    stopWait();
    pending = null;
    const row = buildRow(ownerDocument, locale());
    const state: EntryState = { trigger, row, section: null, unregister: () => undefined };
    attachRow(state, list);
    current = state;

    const choose = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      const expected = `@${trigger.query}`;
      if (trigger.node.data.slice(trigger.start, trigger.end) !== expected) {
        remove();
        return;
      }
      suppressed = trigger.query;
      remove();
      const selection = ownerDocument.getSelection();
      if (selection) {
        const range = ownerDocument.createRange();
        range.setStart(trigger.node, trigger.start);
        range.setEnd(trigger.node, trigger.end);
        selection.removeAllRanges();
        selection.addRange(range);
        ownerDocument.execCommand("delete");
      }
      options.open(trigger.editor);
    };
    row.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    row.addEventListener("pointermove", (event) => {
      event.stopPropagation();
      highlightWorkbenchRow(ownerDocument, state.row);
    });
    row.addEventListener("click", choose);
    state.unregister = registerWorkbenchRow(ownerDocument, row, () => row.click());
  };

  const readTrigger = (): Trigger | null => {
    const selection = ownerDocument.getSelection();
    if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
    const node = selection.anchorNode;
    if (!node || node.nodeType !== node.TEXT_NODE) return null;
    const editor = node.parentElement?.closest<HTMLElement>('[contenteditable="true"]');
    if (!editor || !options.isComposerEditor(editor)) return null;
    const found = findJarvisTrigger((node as Text).data.slice(0, selection.anchorOffset));
    if (!found || !matchesEntry(found.query)) return null;
    return {
      editor,
      node: node as Text,
      start: found.start,
      end: selection.anchorOffset,
      query: found.query,
    };
  };

  const schedule = (): void => {
    const trigger = readTrigger();
    if (!trigger) {
      suppressed = null;
      remove();
      return;
    }
    if (suppressed !== null && suppressed === trigger.query) return;
    suppressed = null;
    if (
      current &&
      current.trigger.query === trigger.query &&
      current.trigger.node === trigger.node
    ) {
      current.trigger = trigger;
      return;
    }
    if (pending && pending.query === trigger.query && pending.node === trigger.node) return;
    remove();
    attach(trigger);
  };

  const reattach = (): void => {
    if (current) {
      const list = listFor(current.trigger);
      if (!list) {
        remove();
        return;
      }
      attachRow(current, list);
      return;
    }
    if (!pending) return;
    const trigger = pending;
    const list = listFor(trigger);
    if (list) attach(trigger);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!current) return;
    const target = event.target as Node;
    if (current.row.contains(target)) return;
    const native = listFor(current.trigger);
    if (native?.contains(target)) return;
    remove();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (event.key === "Escape" && !current) {
      suppressed = readTrigger()?.query ?? null;
      return;
    }
    if (!current || event.key !== "Escape") return;
    const selected = current.row.getAttribute("aria-current") === "true";
    suppressed = current.trigger.query;
    remove();
    if (!selected) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const observer = new MutationObserver(reattach);
  observer.observe(ownerDocument.body, { childList: true, subtree: true });

  ownerDocument.addEventListener("input", schedule, true);
  ownerDocument.addEventListener("selectionchange", schedule);
  ownerDocument.addEventListener("pointerdown", onPointerDown, true);
  view.addEventListener("keydown", onKeyDown, true);

  return {
    refresh: schedule,
    dispose() {
      remove();
      observer.disconnect();
      ownerDocument.removeEventListener("input", schedule, true);
      ownerDocument.removeEventListener("selectionchange", schedule);
      ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
      view.removeEventListener("keydown", onKeyDown, true);
    },
  };
}
