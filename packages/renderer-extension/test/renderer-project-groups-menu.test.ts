import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProjectGroupMenuProxy,
  watchNativeMenuClose,
} from "../src/renderer-project-groups-menu.js";

const ANCHOR_RECT = {
  left: 10,
  top: 20,
  right: 210,
  bottom: 40,
  width: 200,
  height: 20,
  x: 10,
  y: 20,
  toJSON: () => ({}),
} as DOMRect;

const MENU_RECT = {
  left: 10,
  top: 40,
  right: 130,
  bottom: 80,
  width: 120,
  height: 40,
  x: 10,
  y: 40,
  toJSON: () => ({}),
} as DOMRect;

class FakeMouseEvent {
  readonly defaultPrevented = false;
}

class FakeKeyboardEvent extends FakeMouseEvent {
  readonly key = "";
}

class FakeMutationObserver {
  static callbacks = new Set<() => void>();

  constructor(private readonly callback: () => void) {
    FakeMutationObserver.callbacks.add(callback);
  }

  observe(): void {}

  disconnect(): void {
    FakeMutationObserver.callbacks.delete(this.callback);
  }
}

function fakeWindow(): Window {
  return {
    setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    setInterval: (...args: Parameters<typeof setInterval>) => globalThis.setInterval(...args),
    clearInterval: (timer: ReturnType<typeof setInterval>) => globalThis.clearInterval(timer),
  } as unknown as Window;
}

function fakeDocument(menus: HTMLElement[]): Document {
  return {
    body: {},
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => menus,
    dispatchEvent: () => true,
  } as unknown as Document;
}

function fakeMenu(): HTMLElement {
  let connected = true;
  let state: string | null = null;
  return {
    get isConnected() {
      return connected;
    },
    set connected(value: boolean) {
      connected = value;
    },
    get state() {
      return state;
    },
    set state(value: string | null) {
      state = value;
    },
    getAttribute: (name: string) => (name === "data-state" ? state : null),
    getBoundingClientRect: () => MENU_RECT,
    closest: () => null,
  } as unknown as HTMLElement;
}

function fakeRow(document: Document, menus: HTMLElement[], showMenu: boolean): HTMLElement {
  const menu = fakeMenu();
  const row = {
    ownerDocument: document,
    style: { cssText: "" },
    dispatchEvent: () => {
      if (showMenu) menus.push(menu);
      return true;
    },
    getBoundingClientRect: () => ANCHOR_RECT,
  } as unknown as HTMLElement;
  Object.defineProperty(row, "__reactFiber$test", {
    value: { memoizedProps: { onContextMenu: () => undefined }, return: null },
  });
  return row;
}

const anchor = {
  getBoundingClientRect: () => ANCHOR_RECT,
} as unknown as HTMLElement;

async function failOpen(proxy: ProjectGroupMenuProxy, row: HTMLElement): Promise<void> {
  const pending = proxy.open(row, anchor);
  await vi.advanceTimersByTimeAsync(1_500);
  await expect(pending).resolves.toBe(false);
}

function stubBrowserGlobals(): void {
  vi.useFakeTimers();
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  vi.stubGlobal("MouseEvent", FakeMouseEvent);
  vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
}

describe("project group native menu close watcher", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeMutationObserver.callbacks.clear();
  });

  it("never restores an open menu on the old 15s timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    const menu = fakeMenu();
    const onClosed = vi.fn();
    watchNativeMenuClose({
      menu,
      document: fakeDocument([]),
      window: fakeWindow(),
      onClosed,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onClosed).not.toHaveBeenCalled();
    (menu as HTMLElement & { state: string | null }).state = "closed";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

describe("project group native menu failure handling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeMutationObserver.callbacks.clear();
  });

  it("allows a retry after one transient positioning failure", async () => {
    stubBrowserGlobals();
    const menus: HTMLElement[] = [];
    const document = fakeDocument(menus);
    const onFailure = vi.fn();
    const onUnsupported = vi.fn();
    const proxy = new ProjectGroupMenuProxy({
      document,
      window: fakeWindow(),
      onFailure,
      onUnsupported,
    });
    const row = fakeRow(document, menus, false);
    await failOpen(proxy, row);
    expect(proxy.state()).toBe("unknown");
    expect(proxy.isAvailable()).toBe(true);
    expect(proxy.consecutiveFailures()).toBe(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onUnsupported).not.toHaveBeenCalled();
    await failOpen(proxy, row);
    expect(proxy.isAvailable()).toBe(true);
    expect(proxy.consecutiveFailures()).toBe(2);
    await failOpen(proxy, row);
    expect(proxy.state()).toBe("unsupported");
    expect(proxy.isAvailable()).toBe(false);
    expect(onUnsupported).toHaveBeenCalledWith("native-context-menu-position-unreliable");
    proxy.dispose();
  });

  it("clears the failure count after a successful open", async () => {
    stubBrowserGlobals();
    const menus: HTMLElement[] = [];
    const document = fakeDocument(menus);
    const proxy = new ProjectGroupMenuProxy({
      document,
      window: fakeWindow(),
      onFailure: () => undefined,
    });
    const failing = fakeRow(document, menus, false);
    await failOpen(proxy, failing);
    await failOpen(proxy, failing);
    expect(proxy.consecutiveFailures()).toBe(2);

    const succeeding = fakeRow(document, menus, true);
    await expect(proxy.open(succeeding, anchor)).resolves.toBe(true);
    expect(proxy.state()).toBe("native");
    expect(proxy.consecutiveFailures()).toBe(0);
    proxy.dispose();

    const after = new ProjectGroupMenuProxy({
      document,
      window: fakeWindow(),
      onFailure: () => undefined,
    });
    await failOpen(after, failing);
    await failOpen(after, failing);
    expect(after.isAvailable()).toBe(true);
    await failOpen(after, failing);
    expect(after.state()).toBe("unsupported");
    after.dispose();
  });

  it("re-probes after the host resets an unsupported session", async () => {
    stubBrowserGlobals();
    const menus: HTMLElement[] = [];
    const document = fakeDocument(menus);
    const proxy = new ProjectGroupMenuProxy({ document, window: fakeWindow() });
    const row = fakeRow(document, menus, false);
    await failOpen(proxy, row);
    await failOpen(proxy, row);
    await failOpen(proxy, row);
    expect(proxy.state()).toBe("unsupported");
    proxy.reprobe();
    expect(proxy.state()).toBe("unknown");
    expect(proxy.consecutiveFailures()).toBe(0);
    expect(proxy.isAvailable()).toBe(true);
    await failOpen(proxy, row);
    expect(proxy.consecutiveFailures()).toBe(1);
    expect(proxy.isAvailable()).toBe(true);
    proxy.dispose();
  });
});
