import { describe, expect, it } from "vitest";

import { agentMenuFocusIndex, agentMenuPlacement } from "../../src/settings/agent-card-menu.js";

describe("Agent card menu placement", () => {
  const menu = { width: 168, height: 104 };

  it("hangs under the trigger and aligns its right edge", () => {
    expect(
      agentMenuPlacement({
        anchor: { top: 100, bottom: 128, right: 400 },
        viewport: { width: 1000, height: 800 },
        menu,
      }),
    ).toEqual({ top: 132, left: 232 });
  });

  it("flips above the trigger when the page bottom is close", () => {
    expect(
      agentMenuPlacement({
        anchor: { top: 760, bottom: 788, right: 400 },
        viewport: { width: 1000, height: 800 },
        menu,
      }),
    ).toEqual({ top: 652, left: 232 });
  });

  it("keeps the menu inside the viewport at both edges", () => {
    expect(
      agentMenuPlacement({
        anchor: { top: 40, bottom: 68, right: 60 },
        viewport: { width: 1000, height: 800 },
        menu,
      }).left,
    ).toBe(8);
    expect(
      agentMenuPlacement({
        anchor: { top: 40, bottom: 68, right: 1000 },
        viewport: { width: 1000, height: 800 },
        menu,
      }).left,
    ).toBe(824);
  });
});

describe("Agent card menu keyboard navigation", () => {
  it("wraps arrow keys and jumps to the first or last item", () => {
    expect(agentMenuFocusIndex(0, "ArrowDown", 3)).toBe(1);
    expect(agentMenuFocusIndex(2, "ArrowDown", 3)).toBe(0);
    expect(agentMenuFocusIndex(0, "ArrowUp", 3)).toBe(2);
    expect(agentMenuFocusIndex(1, "Home", 3)).toBe(0);
    expect(agentMenuFocusIndex(1, "End", 3)).toBe(2);
  });

  it("leaves other keys alone", () => {
    expect(agentMenuFocusIndex(0, "Enter", 3)).toBeNull();
    expect(agentMenuFocusIndex(0, "ArrowDown", 0)).toBeNull();
  });
});
