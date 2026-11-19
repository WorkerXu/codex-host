import { expect, it } from "vitest";
import { dingtalkMatchError, dingtalkRunError } from "../src/dingtalk-dispatch-errors.js";
it.each([
  ["http_402", "Gemini 额度不足，未派发"],
  ["http_429", "Gemini 额度不足，未派发"],
  ["unauthorized", "Gemini Key 无效，未派发"],
  ["http_403", "Gemini Key 无效，未派发"],
  ["timeout", "Gemini 匹配超时，未派发"],
])("translates match error %s", (code, text) => expect(dingtalkMatchError(code)).toBe(text));
it("never exposes raw English errors or arbitrary provider text", () => {
  expect(dingtalkRunError("upstream 502 token=secret")).toBe(
    "智能体处理失败，请在 Desktop 查看对话",
  );
});
it.each([
  ["Desktop did not confirm the DingTalk project", "智能体处理失败，请在 Desktop 查看对话"],
  ["Host connection closed", "与 Desktop 的连接已断开"],
  ["Official thread/start returned no Thread identity", "未能创建智能体对话"],
  ["interrupted", "处理已中断"],
  ["处理时间过长，已停止", "处理时间过长，已停止"],
])("keeps every card reason Chinese: %s", (raw, text) => {
  expect(dingtalkRunError(raw)).toBe(text);
});
