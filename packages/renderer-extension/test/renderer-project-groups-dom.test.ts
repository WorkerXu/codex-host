import { describe, expect, it } from "vitest";

import { hasNativeContextMenu, statusIconState } from "../src/renderer-project-groups-dom.js";

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
