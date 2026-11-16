/**
 * A single 「钉钉」row appended to Codex Desktop's native `@` menu.
 *
 * Desktop owns the menu; the row only opens the workbench page and removes the
 * typed trigger text. Selecting it never inserts a mention by itself — the
 * page's embed actions do that against the Composer remembered here.
 */
import {
  HEADER_CLASS,
  LIST_CLASS,
  MENU_CLASS,
  ROW_CLASS,
  ROW_CONTENT_CLASS,
  ROW_HIGHLIGHT_CLASSES,
  ROW_IDLE_CLASS,
} from "./renderer-delegation-mention.js";
import { findJarvisTrigger, findNativeSuggestionList } from "./renderer-jarvis-mention.js";
import { createDingTalkMark } from "./settings/dingtalk-icon.js";

const SECTION_ATTRIBUTE = "data-codexhost-dingtalk-section";
const PANEL_ATTRIBUTE = "data-codexhost-dingtalk-panel";
const MENU_MAX_HEIGHT = 120;
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 4;

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

function matchesEntry(query: string): boolean {
  if (query.length === 0) return true;
  const value = query.toLowerCase();
  return "钉钉".startsWith(value) || "dingtalk".startsWith(value);
}

function buildRow(document: Document, locale: string): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.setAttribute("data-codexhost-dingtalk-entry", "true");
  row.className = ROW_CLASS;
  const content = document.createElement("div");
  content.className = ROW_CONTENT_CLASS;
  const mark = createDingTalkMark(document, 16);
  const label = document.createElement("span");
  label.className = "min-w-0 shrink truncate";
  label.textContent = locale === "zh-CN" ? "钉钉" : "DingTalk";
  const meta = document.createElement("span");
  meta.className = "flex-1 truncate text-codex-description";
  meta.textContent = locale === "zh-CN" ? "打开钉钉工作台" : "Open the DingTalk workbench";
  content.append(mark, label, meta);
  row.append(content);
  row.classList.add(ROW_IDLE_CLASS);
  return row;
}

/** The single Workbench section appended to the native `@` menu. */
export function createDingTalkEntrySection(
  document: Document,
  locale: string,
): { element: HTMLElement; row: HTMLElement } {
  const section = document.createElement("div");
  section.setAttribute(SECTION_ATTRIBUTE, "true");
  section.className = "flex w-full flex-col";
  const header = document.createElement("div");
  header.className = HEADER_CLASS;
  header.textContent = locale === "zh-CN" ? "工作台" : "Workbench";
  const row = buildRow(document, locale);
  section.append(header, row);
  return { element: section, row };
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
  let current: {
    trigger: Trigger;
    section: HTMLElement;
    row: HTMLElement;
    panel: HTMLElement | null;
  } | null = null;
  let suppressed: string | null = null;
  let selected = false;

  const remove = (): void => {
    current?.section.remove();
    current?.panel?.remove();
    current = null;
    selected = false;
  };

  const highlight = (): void => {
    if (!current) return;
    current.row.setAttribute("aria-selected", String(selected));
    for (const name of ROW_HIGHLIGHT_CLASSES) {
      current.row.classList.toggle(name, selected);
    }
    current.row.classList.toggle(ROW_IDLE_CLASS, !selected);
    if (selected) current.row.scrollIntoView({ block: "nearest" });
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

  const positionPanel = (panel: HTMLElement, editor: HTMLElement): void => {
    const anchor = options.anchorForEditor(editor) ?? editor;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(rect.width, view.innerWidth - VIEWPORT_MARGIN * 2);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, view.innerWidth - width - VIEWPORT_MARGIN),
    )}px`;
    const height = panel.getBoundingClientRect().height;
    panel.style.top = `${
      rect.top >= height + MENU_GAP + VIEWPORT_MARGIN
        ? rect.top - height - MENU_GAP
        : Math.min(view.innerHeight - height - VIEWPORT_MARGIN, rect.bottom + MENU_GAP)
    }px`;
  };

  const attach = (trigger: Trigger): void => {
    const locale = ownerDocument.documentElement.lang || view.navigator.language;
    const { element: section, row } = createDingTalkEntrySection(ownerDocument, locale);
    let panel: HTMLElement | null = null;
    const anchor = options.anchorForEditor(trigger.editor);
    const native = findNativeSuggestionList(ownerDocument, anchor);
    if (native) {
      native.append(section);
    } else {
      panel = ownerDocument.createElement("div");
      panel.setAttribute(PANEL_ATTRIBUTE, "true");
      panel.className = MENU_CLASS;
      Object.assign(panel.style, {
        position: "fixed",
        zIndex: "2147483647",
        maxHeight: `${MENU_MAX_HEIGHT}px`,
        padding: "var(--spacing)",
      } satisfies Partial<CSSStyleDeclaration>);
      const list = ownerDocument.createElement("div");
      list.className = LIST_CLASS;
      list.setAttribute("role", "listbox");
      list.append(section);
      panel.append(list);
      ownerDocument.body.append(panel);
      positionPanel(panel, trigger.editor);
    }
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
      selected = true;
      highlight();
    });
    row.addEventListener("click", choose);
    current = { trigger, section, row, panel };
    selected = false;
    highlight();
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
    remove();
    attach(trigger);
  };

  const nativeRows = (): HTMLElement[] => {
    if (!current) return [];
    const native = findNativeSuggestionList(
      ownerDocument,
      options.anchorForEditor(current.trigger.editor),
    );
    if (!native) return [];
    return [...native.querySelectorAll<HTMLElement>('[role="option"]')].filter(
      (row) => !row.closest(`[${SECTION_ATTRIBUTE}]`),
    );
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!current) return;
    const target = event.target as Node;
    if (current.section.contains(target) || current.panel?.contains(target)) return;
    const native = findNativeSuggestionList(
      ownerDocument,
      options.anchorForEditor(current.trigger.editor),
    );
    if (native?.contains(target)) return;
    remove();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (event.key === "Escape" && !current) {
      suppressed = readTrigger()?.query ?? null;
      return;
    }
    if (!current) return;
    let handled = true;
    if (event.key === "ArrowDown") {
      if (!selected) {
        const rows = nativeRows();
        const last = rows.at(-1);
        if (rows.length === 0 || last?.getAttribute("aria-selected") === "true") {
          selected = true;
          highlight();
        } else {
          handled = false;
        }
      }
    } else if (event.key === "ArrowUp") {
      if (selected) {
        selected = false;
        highlight();
        handled = false;
      } else {
        handled = false;
      }
    } else if (event.key === "Enter" || event.key === "Tab") {
      if (selected) current.row.click();
      else handled = false;
    } else if (event.key === "Escape") {
      suppressed = current.trigger.query;
      remove();
    } else {
      handled = false;
    }
    if (!handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const observer = new MutationObserver(() => {
    if (!current) return;
    if (current.section.isConnected) return;
    const native = findNativeSuggestionList(
      ownerDocument,
      options.anchorForEditor(current.trigger.editor),
    );
    if (native) {
      native.append(current.section);
      current.panel?.remove();
      current.panel = null;
    } else {
      remove();
    }
  });
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
