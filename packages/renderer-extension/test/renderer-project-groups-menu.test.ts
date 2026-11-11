import { describe, expect, it } from "vitest";

import { ProjectGroupMenuProxy } from "../src/renderer-project-groups-menu.js";

function fakeDocument(): Document {
  return {
    body: {},
    documentElement: {},
    querySelectorAll: () => [],
  } as unknown as Document;
}

const fakeWindow = {
  setTimeout: (callback: () => void) => setTimeout(callback, 0),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
} as unknown as Window;

describe("Project group native menu proxy", () => {
  it("degrades once when the native row has no context-menu handler", async () => {
    const reasons: string[] = [];
    const proxy = new ProjectGroupMenuProxy({
      document: fakeDocument(),
      window: fakeWindow,
      onUnsupported: (reason) => reasons.push(reason),
    });
    const anchor = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 100,
        bottom: 20,
        width: 100,
        height: 20,
      }),
    } as unknown as HTMLElement;
    await expect(proxy.open({} as HTMLElement, anchor)).resolves.toBe(false);
    expect(proxy.state()).toBe("unsupported");
    expect(proxy.isAvailable()).toBe(false);
    expect(reasons).toEqual(["native-context-menu-missing"]);
    await expect(proxy.open({} as HTMLElement, anchor)).resolves.toBe(false);
    expect(reasons).toHaveLength(1);
  });
});
