import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createJarvisConditionChip,
  createJarvisModeChrome,
} from "../src/renderer-jarvis-bug-view.js";
import {
  createWorkbenchRow,
  ensureWorkbenchSection,
  findNativeSuggestionList,
  nativeMenuRows,
  setWorkbenchRowHighlight,
  waitForNativeSuggestionList,
  workbenchNavigation,
} from "../src/renderer-native-at-menu.js";

/** Minimal DOM used by the shared section builder and detection helpers. */
class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  className = "";
  textContent = "";
  type = "";
  style: Record<string, string> = {};
  isDocumentRoot = false;
  readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get classList() {
    const names = () => this.className.split(/\s+/u).filter(Boolean);
    return {
      add: (...values: string[]) => {
        const set = new Set(names());
        for (const value of values) set.add(value);
        this.className = [...set].join(" ");
      },
      remove: (...values: string[]) => {
        const remove = new Set(values);
        this.className = names()
          .filter((name) => !remove.has(name))
          .join(" ");
      },
      contains: (value: string) => names().includes(value),
      toggle: (value: string, force?: boolean) => {
        const on = force ?? !names().includes(value);
        if (on) this.classList.add(value);
        else this.classList.remove(value);
        return on;
      },
    };
  }

  get isConnected(): boolean {
    return this.parentElement ? this.parentElement.isConnected : this.isDocumentRoot;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): FakeElement | null {
    return this.children.at(-1) ?? null;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement?.removeChild(node);
      node.parentElement = this;
      this.children.push(node);
    }
  }

  prepend(...nodes: FakeElement[]): void {
    for (const node of nodes.reverse()) {
      node.parentElement?.removeChild(node);
      node.parentElement = this;
      this.children.unshift(node);
    }
  }

  removeChild(node: FakeElement): void {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentElement = null;
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.className = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  contains(node: FakeElement | null): boolean {
    if (!node) return false;
    let current: FakeElement | null = node;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => this.matchesSimple(part.trim()));
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect(): DOMRect {
    return { top: 100, bottom: 300, left: 0, right: 320, width: 320, height: 200 } as DOMRect;
  }

  getClientRects(): DOMRect[] {
    return [this.getBoundingClientRect()];
  }

  scrollIntoView(): void {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  private matchesSimple(selector: string): boolean {
    if (!selector) return false;
    const attributeContains = /^\[([\w-]+)\*="([^"]*)"\]$/u.exec(selector);
    if (attributeContains) {
      const name = attributeContains[1] ?? "";
      const value = attributeContains[2] ?? "";
      return (this.getAttribute(name) ?? "").includes(value);
    }
    const attributeEquals = /^\[([\w-]+)="([^"]*)"\]$/u.exec(selector);
    if (attributeEquals) {
      const name = attributeEquals[1] ?? "";
      return this.getAttribute(name) === attributeEquals[2];
    }
    const attribute = /^\[([\w-]+)\]$/u.exec(selector);
    if (attribute) return this.hasAttribute(attribute[1] ?? "");
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const tagWithAttribute = /^([\w-]+)\[([\w-]+)\]$/u.exec(selector);
    if (tagWithAttribute) {
      return (
        this.tagName === (tagWithAttribute[1] ?? "").toUpperCase() &&
        this.hasAttribute(tagWithAttribute[2] ?? "")
      );
    }
    return this.tagName === selector.toUpperCase();
  }
}

class FakeDocument {
  readonly body = new FakeElement("body");
  defaultView: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    navigator: { language: string };
  } | null = null;

  constructor() {
    this.body.isDocumentRoot = true;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }
}

function documentWithView(): {
  document: FakeDocument;
  view: NonNullable<FakeDocument["defaultView"]>;
} {
  const document = new FakeDocument();
  const view = {
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    navigator: { language: "zh-CN" },
  };
  document.defaultView = view;
  return { document, view };
}

function element(tagName: string, className = ""): FakeElement {
  const node = new FakeElement(tagName);
  node.className = className;
  return node;
}

function nativeScroll(document: FakeDocument): FakeElement {
  const panel = element("div", "suggestionMenu-EeXWU_ max-h-[inherit]");
  const shell = element("div", "ComposerTopMenuShell-ZaKxCC max-h-[inherit]");
  const scroll = element(
    "div",
    "vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto",
  );
  scroll.setAttribute("data-mention-list-scroll-area", "");
  shell.append(scroll);
  panel.append(shell);
  document.body.append(panel);
  return scroll;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("native @ menu detection", () => {
  it("prefers the explicit mention scroll area of the current Desktop DOM", () => {
    const { document } = documentWithView();
    const scroll = nativeScroll(document);
    const legacy = element("div", "vertical-scroll-fade-mask flex flex-col");
    legacy.setAttribute("role", "listbox");
    document.body.append(legacy);

    expect(findNativeSuggestionList(document as unknown as Document, null)).toBe(
      scroll as unknown as HTMLElement,
    );
  });

  it("falls back to the legacy listbox shape", () => {
    const { document } = documentWithView();
    const listbox = element("div", "rounded border");
    listbox.setAttribute("role", "listbox");
    const scroll = element("div", "vertical-scroll-fade-mask flex flex-col");
    listbox.append(scroll);
    document.body.append(listbox);

    expect(findNativeSuggestionList(document as unknown as Document, null)).toBe(
      scroll as unknown as HTMLElement,
    );
  });

  it("ignores lists that belong to our own menus", () => {
    const { document } = documentWithView();
    const own = element("div");
    own.setAttribute("data-codexhost-workbench-section", "true");
    const listbox = element("div");
    listbox.setAttribute("role", "listbox");
    own.append(listbox);
    document.body.append(own);

    expect(findNativeSuggestionList(document as unknown as Document, null)).toBeNull();
  });

  it("waits for a native list that appears after the input event", () => {
    vi.useFakeTimers();
    const { document } = documentWithView();
    const found: HTMLElement[] = [];
    waitForNativeSuggestionList(
      document as unknown as Document,
      () => null,
      (list) => found.push(list),
    );
    expect(found).toHaveLength(0);

    const scroll = nativeScroll(document);
    vi.advanceTimersByTime(120);
    expect(found).toEqual([scroll as unknown as HTMLElement]);
  });
});

describe("shared workbench section", () => {
  it("creates one section and reuses it for the second controller", () => {
    const { document } = documentWithView();
    const list = nativeScroll(document);
    list.append(element("div", ""));

    const first = ensureWorkbenchSection(
      document as unknown as Document,
      list as unknown as HTMLElement,
      "zh-CN",
    );
    first.items.append(
      createWorkbenchRow(document as unknown as Document, {
        rowAttribute: "data-codexhost-dingtalk-entry",
        icon: element("span") as unknown as Element,
        label: "钉钉",
        description: "打开钉钉工作台",
      }),
    );

    const second = ensureWorkbenchSection(
      document as unknown as Document,
      list as unknown as HTMLElement,
      "zh-CN",
    );
    expect(second.element).toBe(first.element);
    expect(list.lastElementChild).toBe(first.element);
    expect(document.querySelectorAll("[data-codexhost-workbench-section]")).toHaveLength(1);
    expect(
      [...first.element.children].filter((child) => child.textContent === "工作台"),
    ).toHaveLength(1);
  });

  it("builds native button rows with menu content and an icon slot", () => {
    const { document } = documentWithView();
    const row = createWorkbenchRow(document as unknown as Document, {
      rowAttribute: "data-codexhost-dingtalk-entry",
      icon: element("span") as unknown as Element,
      label: "钉钉",
      description: "打开钉钉工作台",
    });
    expect(row.tagName).toBe("BUTTON");
    expect(row.type).toBe("button");
    expect(row.getAttribute("data-list-navigation-item")).toBe("true");
    expect(row.getAttribute("data-codexhost-workbench-row")).toBe("true");
    expect(row.querySelector("[data-menu-row-content]")).not.toBeNull();
    expect(row.querySelector('[data-leading-icon-slot="menu"]')).not.toBeNull();
    expect([...row.querySelectorAll("span")].some((node) => node.textContent === "钉钉")).toBe(
      true,
    );
  });
});

describe("focus-safe press", () => {
  const press = (): Event & { preventDefault: ReturnType<typeof vi.fn> } => {
    const event = {
      type: "mousedown",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    return event as unknown as Event & { preventDefault: ReturnType<typeof vi.fn> };
  };

  it("keeps the editor focused when a workbench row is pressed with the mouse", () => {
    const { document } = documentWithView();
    const row = createWorkbenchRow(document as unknown as Document, {
      rowAttribute: "data-codexhost-dingtalk-entry",
      icon: element("span") as unknown as Element,
      label: "钉钉",
      description: "打开钉钉工作台",
    }) as unknown as FakeElement;
    const event = press();
    row.dispatch("mousedown", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("keeps focus for the Jarvis back button and condition chips", () => {
    const { document } = documentWithView();
    const chrome = createJarvisModeChrome(document as unknown as Document, "zh-CN");
    const backEvent = press();
    (chrome.back as unknown as FakeElement).dispatch("mousedown", backEvent);
    expect(backEvent.preventDefault).toHaveBeenCalled();

    const chip = createJarvisConditionChip(document as unknown as Document, {
      key: "status:1",
      kind: "status",
      label: "未解决",
    }) as unknown as FakeElement;
    const chipEvent = press();
    chip.dispatch("mousedown", chipEvent);
    expect(chipEvent.preventDefault).toHaveBeenCalled();
    expect(chipEvent.stopPropagation).toHaveBeenCalled();
  });
});

describe("keyboard hand-off", () => {
  const nativeRows = [element("button"), element("button")];
  const workbenchRows = [element("button"), element("button")];
  const asElements = (rows: FakeElement[]) => rows as unknown as HTMLElement[];

  it("walks from the last native row through every Workbench row and back", () => {
    expect(
      workbenchNavigation({
        key: "ArrowDown",
        nativeRows: asElements(nativeRows),
        workbenchRows: asElements(workbenchRows),
        highlightedNative: nativeRows[1] as unknown as HTMLElement,
        highlightedWorkbench: null,
      }),
    ).toEqual({ kind: "highlight", row: workbenchRows[0], clearNative: true });

    expect(
      workbenchNavigation({
        key: "ArrowDown",
        nativeRows: asElements(nativeRows),
        workbenchRows: asElements(workbenchRows),
        highlightedNative: null,
        highlightedWorkbench: workbenchRows[0] as unknown as HTMLElement,
      }),
    ).toEqual({ kind: "highlight", row: workbenchRows[1], clearNative: false });

    expect(
      workbenchNavigation({
        key: "ArrowUp",
        nativeRows: asElements(nativeRows),
        workbenchRows: asElements(workbenchRows),
        highlightedNative: null,
        highlightedWorkbench: workbenchRows[1] as unknown as HTMLElement,
      }),
    ).toEqual({ kind: "highlight", row: workbenchRows[0], clearNative: false });

    expect(
      workbenchNavigation({
        key: "ArrowUp",
        nativeRows: asElements(nativeRows),
        workbenchRows: asElements(workbenchRows),
        highlightedNative: null,
        highlightedWorkbench: workbenchRows[0] as unknown as HTMLElement,
      }),
    ).toEqual({ kind: "native", row: nativeRows[1] });

    expect(
      workbenchNavigation({
        key: "ArrowDown",
        nativeRows: asElements(nativeRows),
        workbenchRows: asElements(workbenchRows),
        highlightedNative: nativeRows[0] as unknown as HTMLElement,
        highlightedWorkbench: null,
      }),
    ).toEqual({ kind: "none" });

    expect(
      workbenchNavigation({
        key: "Enter",
        nativeRows: asElements(nativeRows),
        workbenchRows: asElements(workbenchRows),
        highlightedNative: null,
        highlightedWorkbench: workbenchRows[1] as unknown as HTMLElement,
      }),
    ).toEqual({ kind: "choose", row: workbenchRows[1] });
  });

  it("lists only native rows and applies the native selected state", () => {
    const { document } = documentWithView();
    const list = nativeScroll(document);
    const first = element("button");
    first.setAttribute("data-list-navigation-item", "true");
    const second = element("button");
    second.setAttribute("data-list-navigation-item", "true");
    list.append(first, second);
    const section = ensureWorkbenchSection(
      document as unknown as Document,
      list as unknown as HTMLElement,
      "zh-CN",
    );
    const own = createWorkbenchRow(document as unknown as Document, {
      rowAttribute: "data-codexhost-dingtalk-entry",
      icon: element("span") as unknown as Element,
      label: "钉钉",
      description: "打开钉钉工作台",
    });
    section.items.append(own);

    const native = nativeMenuRows(list as unknown as HTMLElement);
    expect(native).toEqual([first, second] as unknown as HTMLElement[]);

    setWorkbenchRowHighlight(own as unknown as HTMLElement, true);
    expect(own.getAttribute("aria-current")).toBe("true");
    expect(own.classList.contains("bg-secondary-ghost-hover")).toBe(true);
    expect(own.classList.contains("menu-row-opacity")).toBe(false);
  });
});
