import { describe, expect, test } from "vitest";
import {
  webExtensionPanelBadgeCountSchema,
  webExtensionPanelGroupSchema,
} from "../src/web-native-extensions.js";

describe("Web extension panel groups", () => {
  test.each(["Library", { en: "Library", "zh-CN": "资料库" }])(
    "accepts a group with title %j",
    (title) => {
      expect(webExtensionPanelGroupSchema.parse({ id: " library ", title })).toEqual({
        id: "library",
        title,
      });
    },
  );

  test.each([
    { id: " ", title: "Library" },
    { id: "library", title: " " },
    { id: "library", title: { en: "Library" } },
  ])("rejects an invalid group %j", (group) => {
    expect(webExtensionPanelGroupSchema.safeParse(group).success).toBe(false);
  });

  test("accepts only non-negative safe integers as badge counts", () => {
    expect(webExtensionPanelBadgeCountSchema.parse(0)).toBe(0);
    expect(webExtensionPanelBadgeCountSchema.parse(12)).toBe(12);
    for (const count of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
      expect(webExtensionPanelBadgeCountSchema.safeParse(count).success).toBe(false);
    }
  });
});
