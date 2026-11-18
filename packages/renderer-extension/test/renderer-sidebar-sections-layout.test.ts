import { describe, expect, it } from "vitest";
import {
  MERGE_FLATTEN_ATTRIBUTE,
  MERGE_HIDDEN_ATTRIBUTE,
  MERGE_ORDER_ATTRIBUTE,
  SECTION_DISPLAY_TOGGLE_ATTRIBUTE,
  mergeStyleCss,
} from "../src/renderer-sidebar-sections-layout.js";

describe("merged section stylesheet", () => {
  it("flattens wrappers and hides project chrome without touching rows", () => {
    const css = mergeStyleCss(0);
    expect(css).toContain(`[${MERGE_FLATTEN_ATTRIBUTE}] { display: contents !important; }`);
    expect(css).toContain(`[${MERGE_HIDDEN_ATTRIBUTE}] { display: none !important; }`);
    expect(css).toContain("flex-direction: column !important;");
    expect(css).toContain(`[${MERGE_FLATTEN_ATTRIBUTE}]::before`);
    expect(css).toContain("content: none !important;");
  });

  it("emits one order rule per reachable row index", () => {
    const css = mergeStyleCss(3);
    for (const order of [0, 1, 2, 3]) {
      expect(css).toContain(`[${MERGE_ORDER_ATTRIBUTE}="${order}"] { order: ${order}; }`);
    }
    expect(css).not.toContain(`[${MERGE_ORDER_ATTRIBUTE}="4"]`);
  });

  it("gives the header toggle native hover, pressed and focus styling", () => {
    const css = mergeStyleCss(0);
    expect(css).toContain(`[${SECTION_DISPLAY_TOGGLE_ATTRIBUTE}]:hover`);
    expect(css).toContain(`[${SECTION_DISPLAY_TOGGLE_ATTRIBUTE}][aria-pressed="true"]`);
    expect(css).toContain("focus-visible");
    expect(css).toContain("--color-background-secondary-ghost-hover");
    expect(css).toContain("--color-ring");
  });
});
