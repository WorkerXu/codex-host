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

class FakeMutationObserver {
  constructor(private readonly callback: () => void) {}

  observe(): void {}

  disconnect(): void {}
}

function fakeWindow(): Window {
  return {
    setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    setInterval: (...args: Parameters<typeof setInterval>) => globalThis.setInterval(...args),
    clearInterval: (timer: ReturnType<typeof setInterval>) => globalThis.clearInterval(timer),
  } as unknown as Window;
}

function fakeDocument(): Document {
  return {
    body: {},
    documentElement: {},
    querySelectorAll: () => [],
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

describe("project group native menu close watcher", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never restores an open menu on the old 15s timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    const menu = fakeMenu();
    const onClosed = vi.fn();
    watchNativeMenuClose({
      menu,
      document: fakeDocument(),
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

describe("Project group native menu proxy", () => {
  it("degrades once when the native row has no context-menu handler", async () => {
    const reasons: string[] = [];
    const proxy = new ProjectGroupMenuProxy({
      document: fakeDocument(),
      window: fakeWindow(),
      onUnsupported: (reason) => reasons.push(reason),
    });
    const anchor = {
      getBoundingClientRect: () => ANCHOR_RECT,
    } as unknown as HTMLElement;
    await expect(proxy.open({} as HTMLElement, anchor)).resolves.toBe(false);
    expect(proxy.state()).toBe("unsupported");
    expect(proxy.isAvailable()).toBe(false);
    expect(reasons).toEqual(["native-context-menu-missing"]);
    await expect(proxy.open({} as HTMLElement, anchor)).resolves.toBe(false);
    expect(reasons).toHaveLength(1);
  });
});
