import { describe, expect, it } from "vitest";
import { hubDate } from "../../src/settings/hub-admin-ui.js";
import { validateHubHeaders } from "../../src/settings/hub-header-editor.js";

describe("Hub header fields", () => {
  it("keeps header values as text and ignores unused rows", () => {
    expect(
      validateHubHeaders([
        [" X-Project ", "docs"],
        ["Authorization", "Bearer example"],
        ["", ""],
      ]),
    ).toEqual({ value: { "X-Project": "docs", Authorization: "Bearer example" } });
  });
  it.each([
    [
      [
        ["Authorization", "one"],
        ["authorization", "two"],
      ],
      "请求头名称不能重复",
    ],
    [[["Bad Header", "value"]], "请输入有效的请求头名称"],
    [[["", "value"]], "请输入有效的请求头名称"],
    [[["X-Project", "one\r\nX-Other: two"]], "请求头内容不能包含换行"],
  ] as const)("rejects ambiguous or invalid rows with a Chinese field error", (rows, error) => {
    expect(validateHubHeaders(rows)).toEqual({ error });
  });
});
describe("Hub display dates", () => {
  const now = new Date(2026, 10, 17, 12, 0);
  it("uses calendar days and omits seconds", () => {
    expect(hubDate(new Date(2026, 10, 17, 3, 30, 42).getTime(), now)).toBe("今天 03:30");
    expect(hubDate(new Date(2026, 10, 16, 21, 10, 59).getTime() / 1000, now)).toBe("昨天 21:10");
    expect(hubDate(new Date(2026, 10, 15, 9, 0).getTime(), now)).toBe("11-15 09:00");
    expect(hubDate(null, now)).toBe("—");
  });
});
