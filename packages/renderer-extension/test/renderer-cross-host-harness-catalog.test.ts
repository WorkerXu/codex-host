import { expect, it } from "vitest";

import { localMachineLabel } from "../src/renderer-cross-host-harness-catalog.js";

it.each([
  ["zh-CN", "此计算机"],
  ["en", "This computer"],
])("uses the Desktop label for the local machine in %s", (locale, label) => {
  expect(localMachineLabel(locale)).toBe(label);
});
