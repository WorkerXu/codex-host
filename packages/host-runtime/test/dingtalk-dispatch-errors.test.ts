import { expect, it } from "vitest";
import { dingtalkMatchError, dingtalkRunError } from "../src/dingtalk-dispatch-errors.js";
it.each([
  ["http_402", "Gemini 额度不足，未派发"],
  ["http_429", "Gemini 额度不足，未派发"],
  ["unauthorized", "Gemini Key 无效，未派发"],
  ["http_403", "Gemini Key 无效，未派发"],
  ["timeout", "Gemini 匹配超时，未派发"],
])("translates match error %s", (code, text) => expect(dingtalkMatchError(code)).toBe(text));
it.each(["Desktop did not confirm the DingTalk project", "Desktop project preparation timed out"])(
  "translates folder confirmation %s",
  (message) => {
    expect(dingtalkRunError(new Error(message))).toBe(
      "需要在 Desktop 确认「钉钉智能体」文件夹，未派发",
    );
  },
);
it("never exposes raw English errors or arbitrary provider text", () => {
  expect(dingtalkRunError("upstream 502 token=secret")).toBe(
    "智能体处理失败，请在 Desktop 查看对话",
  );
});
