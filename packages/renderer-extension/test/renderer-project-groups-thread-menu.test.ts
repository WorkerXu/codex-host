import { describe, expect, it } from "vitest";

import { collectNativeThreadMenuActions } from "../src/renderer-project-groups-thread-menu.js";

function button(label: string, options: { menu?: boolean; icon?: Element } = {}) {
  return {
    getAttribute: (name: string) => {
      if (name === "aria-label") return label;
      if (name === "aria-haspopup" && options.menu) return "menu";
      return null;
    },
    querySelector: (selector: string) => (selector === "svg" ? (options.icon ?? null) : null),
  } as unknown as HTMLElement;
}

describe("Project group proxy thread menu actions", () => {
  it("enumerates native action buttons and excludes menu triggers and duplicates", () => {
    const pin = button("取消置顶聊天");
    const archive = button("归档聊天");
    const duplicate = button("归档聊天");
    const menu = button("更多", { menu: true });
    const row = {
      querySelectorAll: () => [pin, archive, duplicate, menu],
    } as unknown as HTMLElement;
    expect(collectNativeThreadMenuActions(row)).toEqual([
      { id: "取消置顶聊天", label: "取消置顶聊天", icon: null, button: pin },
      { id: "归档聊天", label: "归档聊天", icon: null, button: archive },
    ]);
  });

  it("returns no entries when the native row exposes no actions", () => {
    expect(
      collectNativeThreadMenuActions({ querySelectorAll: () => [] } as unknown as HTMLElement),
    ).toEqual([]);
  });
});
