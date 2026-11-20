import { describe, expect, it } from "vitest";

import {
  findCodexAppScope,
  loadCodexNativeSections,
  type NativeSectionScope,
} from "../src/codex-native-sections.js";

function ownerWindow(urls = ["app://-/assets/runtime.js"]) {
  return {
    location: { href: "app://-/index.html" },
    document: { querySelectorAll: () => [] },
    __codexhostLoadedModulesV1: {
      complete: true,
      documentUrl: "app://-/index.html",
      urls,
    },
  } as unknown as Window;
}

function sectionModule() {
  return {
    Jn() {},
    f2() {},
    qF() {},
    B_() {},
    HW() {},
    Cd() {},
    Vk() {},
    Ub() {},
    QV: {},
    uu: {},
    pp: {},
  };
}

function bundledModule(exportsById: Record<string, unknown>) {
  const cache: Record<string, { exports: unknown }> = {};
  for (const [id, value] of Object.entries(exportsById)) cache[id] = { exports: value };
  return {
    __webpack_require__: Object.assign(
      () => {
        throw new Error("The bundled runtime must not be called");
      },
      { c: cache },
    ),
  };
}

describe("native section command discovery", () => {
  it("finds the single instantiated module that exports the section commands", async () => {
    const api = sectionModule();
    await expect(
      loadCodexNativeSections(ownerWindow(), async () =>
        bundledModule({ unrelated: { anything: true }, sectionModule: api }),
      ),
    ).resolves.toBe(api);
  });

  it("ignores a callable transport module whose every property reads as a function", async () => {
    const api = sectionModule();
    const transport: unknown = new Proxy(function transport() {}, { get: () => transport });
    await expect(
      loadCodexNativeSections(ownerWindow(), async () =>
        bundledModule({ transport, sectionModule: api }),
      ),
    ).resolves.toBe(api);
  });

  it("returns null when no module container has the command shape", async () => {
    await expect(
      loadCodexNativeSections(ownerWindow(), async () =>
        bundledModule({ partial: { Jn() {}, f2() {} } }),
      ),
    ).resolves.toBeNull();
  });

  it("returns null when two distinct modules claim the shape", async () => {
    await expect(
      loadCodexNativeSections(ownerWindow(), async () =>
        bundledModule({ first: sectionModule(), second: sectionModule() }),
      ),
    ).resolves.toBeNull();
  });

  it("does not treat a namespace re-export as an instantiated module", async () => {
    await expect(
      loadCodexNativeSections(ownerWindow(), async () => ({ sectionModule: sectionModule() })),
    ).resolves.toBeNull();
  });

  it("returns null when the loaded module catalog is invalid", async () => {
    const owner = ownerWindow();
    Reflect.set(owner, "__codexhostLoadedModulesV1", {
      complete: false,
      documentUrl: "app://-/index.html",
      urls: [],
    });
    await expect(loadCodexNativeSections(owner, async () => ({}))).resolves.toBeNull();
  });
});

function scope(brand: string): NativeSectionScope {
  return {
    get: () => undefined,
    set: () => undefined,
    watch: () => undefined,
    query: {},
    node: { token: { __scopeBrand: brand } },
  } as unknown as NativeSectionScope;
}

function ownerWithSidebar(current: unknown) {
  const element: Record<string, unknown> = {};
  Object.defineProperty(element, "__reactFiber$fixture", {
    value: { memoizedState: { memoizedState: { current }, next: null } },
    enumerable: false,
  });
  return {
    document: {
      querySelector: (selector: string) => (selector === "aside" ? element : null),
    },
  } as unknown as Window;
}

describe("native AppScope discovery", () => {
  it("returns the AppScope wrapper React handed to a committed hook", () => {
    const appScope = scope("AppScope");
    expect(findCodexAppScope(ownerWithSidebar(appScope))).toBe(appScope);
  });

  it("skips nested scopes such as the drag-and-drop scope", () => {
    expect(findCodexAppScope(ownerWithSidebar(scope("PageDndScope")))).toBeNull();
  });

  it("ignores non-scope hook state and windows without a sidebar", () => {
    expect(findCodexAppScope(ownerWithSidebar({ current: "value" }))).toBeNull();
    expect(
      findCodexAppScope({ document: { querySelector: () => null } } as unknown as Window),
    ).toBeNull();
  });
});
