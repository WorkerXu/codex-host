/** Public Chinese reasons; raw provider and Desktop errors stay in diagnostics. */
export function dingtalkMatchError(code: string | null): string {
  if (code === "missing_key") return "未配置 Gemini Key，未派发";
  if (code === "http_402" || code === "http_429") return "Gemini 额度不足，未派发";
  if (["unauthorized", "http_401", "http_403"].includes(code ?? ""))
    return "Gemini Key 无效，未派发";
  if (code === "timeout") return "Gemini 匹配超时，未派发";
  if (code === "network") return "无法连接 Gemini，未派发";
  return "Gemini 匹配失败，未派发";
}

export function dingtalkRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    /Desktop (?:did not confirm the DingTalk project|project preparation timed out)/iu.test(message)
  )
    return "需要在 Desktop 确认「钉钉智能体」文件夹，未派发";
  if (/Host connection closed/iu.test(message)) return "与 Desktop 的连接已断开";
  if (/no Thread identity/iu.test(message)) return "未能创建智能体对话";
  if (/no Turn identity/iu.test(message)) return "未能启动智能体处理";
  if (/Cannot restrict tools/iu.test(message)) return "无法限制审批汇总工具，未派发";
  if (/timed? ?out|timeout/iu.test(message)) return "智能体处理超时";
  if (/interrupted|cancelled/iu.test(message)) return "处理已中断";
  // Do not echo arbitrary provider text, credentials or tool output to the page/card.
  if (["无法启动", "处理时间过长，已停止"].includes(message)) return message;
  return "智能体处理失败，请在 Desktop 查看对话";
}
