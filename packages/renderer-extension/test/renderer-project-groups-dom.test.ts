import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findProjectsShowMoreButton,
  hasNativeContextMenu,
  nativeThreadActionButton,
  newChatButton,
  probeProjectGroupsContract,
  readThreadSnapshots,
  restoreSidebarScrollAfterThreadClick,
  statusIconState,
} from "../src/renderer-project-groups-dom.js";

function fiberRow(withContextMenu: boolean): HTMLElement {
  const row = {} as HTMLElement;
  Object.defineProperty(row, "__reactFiber$test", {
    value: {
      memoizedProps: withContextMenu ? { onContextMenu: () => undefined } : {},
      return: null,
    },
  });
  return row;
}

function statusRow(className: string, label: string): HTMLElement {
  return {
    querySelector: () => ({
      className,
      getAttribute: () => label,
    }),
  } as unknown as HTMLElement;
}

describe("Project group DOM contract", () => {
  it("detects the native thread context-menu handler through the committed fiber", () => {
    expect(hasNativeContextMenu(fiberRow(true))).toBe(true);
    expect(hasNativeContextMenu(fiberRow(false))).toBe(false);
    expect(hasNativeContextMenu({} as HTMLElement)).toBe(false);
  });

  it("maps native connection status icons", () => {
    expect(statusIconState(statusRow("icon text-chart-green", "已连接"))).toBe("connected");
    expect(statusIconState(statusRow("icon text-chart-red", "连接失败"))).toBe("error");
    expect(statusIconState(statusRow("icon text-chart-yellow", "连接中"))).toBe("connecting");
    expect(statusIconState(statusRow("icon", "未连接"))).toBe("disconnected");
    expect(statusIconState(statusRow("icon", "自定义"))).toBe("unknown");
    expect(statusIconState({ querySelector: () => null } as unknown as HTMLElement)).toBe(
      "unknown",
    );
  });
});

describe("New chat target", () => {
  it("requires exactly one native new-chat button in a project row", () => {
    const button = { disabled: false } as HTMLButtonElement;
    expect(
      newChatButton({
        querySelectorAll: () => [button],
      } as unknown as HTMLElement),
    ).toBe(button);
    expect(
      newChatButton({
        querySelectorAll: () => [],
      } as unknown as HTMLElement),
    ).toBeNull();
    expect(
      newChatButton({
        querySelectorAll: () => [button, button],
      } as unknown as HTMLElement),
    ).toBeNull();
  });
});

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly textContent: string;
  readonly #attributes: Record<string, string>;

  constructor(
    attributes: Record<string, string> = {},
    textContent = "",
    children: FakeElement[] = [],
  ) {
    this.#attributes = attributes;
    this.textContent = textContent;
    this.children = children;
  }

  getAttribute(name: string): string | null {
    return this.#attributes[name] ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector.includes("data-app-action-sidebar-project-row"))
      return (
        this.children.find((child) => "data-app-action-sidebar-project-row" in child.#attributes) ??
        null
      );
    if (selector.includes("data-app-action-sidebar-project-list-id"))
      return (
        this.children.find(
          (child) => "data-app-action-sidebar-project-list-id" in child.#attributes,
        ) ?? null
      );
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector.includes("button"))
      return this.children.filter((child) => "button" in child.#attributes);
    return [];
  }
}

function projectRow(label: string): FakeElement {
  return new FakeElement({
    "data-app-action-sidebar-project-row": "",
    "data-app-action-sidebar-project-id": `local-${label}`,
    "data-app-action-sidebar-project-label": label,
  });
}

describe("Thread snapshots", () => {
  it("captures the native provider icon for cloning", () => {
    const icon = {} as Element;
    const row = {
      getAttribute: (name: string) =>
        name === "data-app-action-sidebar-thread-id"
          ? "local:thread-1"
          : name === "data-app-action-sidebar-thread-host-id"
            ? "local"
            : name === "data-app-action-sidebar-thread-title"
              ? "Thread"
              : null,
      querySelector: (selector: string) => (selector.includes("agent-icon") ? icon : null),
    } as unknown as HTMLElement;
    const list = { querySelectorAll: () => [row] } as unknown as HTMLElement;
    expect(readThreadSnapshots(list)[0]?.providerIcon).toBe(icon);
  });
});

describe("Native thread actions", () => {
  it("finds pin and archive buttons by their localized labels", () => {
    const pin = { getAttribute: () => "取消置顶聊天" } as unknown as HTMLElement;
    const archive = { getAttribute: () => "归档聊天" } as unknown as HTMLElement;
    const row = { querySelectorAll: () => [pin, archive] } as unknown as HTMLElement;
    expect(nativeThreadActionButton(row, "pin")).toBe(pin);
    expect(nativeThreadActionButton(row, "archive")).toBe(archive);
  });

  it("returns null when the native action is absent", () => {
    const row = { querySelectorAll: () => [] } as unknown as HTMLElement;
    expect(nativeThreadActionButton(row, "pin")).toBeNull();
    expect(nativeThreadActionButton(row, "archive")).toBeNull();
  });
});

describe("Project projects list compaction", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts the native Show more row without treating it as a project row", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    const row = projectRow("alpha");
    const newChat = new FakeElement({ button: "" });
    row.children.push(newChat);
    const projectUnit = new FakeElement({ role: "listitem" }, "", [row]);
    const showMore = new FakeElement({ role: "listitem" }, "展开显示", [
      new FakeElement({ button: "" }, "展开显示"),
    ]);
    const list = new FakeElement({ role: "list" }, "", [projectUnit, showMore]);
    const section = new FakeElement({}, "", [list]);
    section.querySelectorAll = (selector: string) =>
      selector.includes("thread-row") ? [] : [list];

    const contract = probeProjectGroupsContract(section as unknown as HTMLElement);
    expect(contract.missing).toEqual([]);
    expect(contract.ok).toBe(true);
    expect(contract.projectCount).toBe(1);
  });

  it("finds the native Projects Show more button", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    const row = projectRow("alpha");
    const projectUnit = new FakeElement({ role: "listitem" }, "", [row]);
    const showMore = new FakeElement({ role: "listitem" }, "展开显示", [
      new FakeElement({ button: "" }, "展开显示"),
    ]);
    const list = new FakeElement({ role: "list" }, "", [projectUnit, showMore]);
    const section = new FakeElement({}, "", [list]);
    section.querySelectorAll = () => [list];

    expect(findProjectsShowMoreButton(section as unknown as HTMLElement)).toBe(
      showMore.children[0],
    );
  });
});

class FakeScrollObserver {
  static last: FakeScrollObserver | null = null;
  readonly callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
    FakeScrollObserver.last = this;
  }

  observe(): void {}

  disconnect(): void {
    if (FakeScrollObserver.last === this) FakeScrollObserver.last = null;
  }

  trigger(): void {
    this.callback();
  }
}

describe("Project group sidebar scroll restore", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeScrollObserver.last = null;
  });

  it("restores the captured scroll when navigation settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MutationObserver", FakeScrollObserver);
    let scrollTop = 500;
    const scroll = {
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(value: number) {
        scrollTop = value;
      },
    };
    const document = {
      body: {},
      documentElement: {},
      querySelector: () => scroll,
    } as unknown as Document;
    const target = { getAttribute: () => "false" } as unknown as HTMLElement;
    restoreSidebarScrollAfterThreadClick({
      document,
      window: {
        setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
        clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
      } as unknown as Window,
      target,
      top: 120,
      timeoutMs: 700,
    });
    await vi.advanceTimersByTimeAsync(699);
    expect(scrollTop).toBe(500);
    await vi.advanceTimersByTimeAsync(1);
    expect(scrollTop).toBe(120);
  });

  it("restores earlier when the target becomes active", () => {
    vi.useFakeTimers();
    vi.stubGlobal("MutationObserver", FakeScrollObserver);
    let scrollTop = 500;
    const scroll = {
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(value: number) {
        scrollTop = value;
      },
    };
    const document = {
      body: {},
      documentElement: {},
      querySelector: () => scroll,
    } as unknown as Document;
    let active = false;
    const target = {
      getAttribute: (name: string) =>
        name === "data-app-action-sidebar-thread-active" && active ? "true" : "false",
    } as unknown as HTMLElement;
    restoreSidebarScrollAfterThreadClick({
      document,
      window: {
        setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
        clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
      } as unknown as Window,
      target,
      top: 120,
    });
    active = true;
    FakeScrollObserver.last?.trigger();
    expect(scrollTop).toBe(120);
  });
});
