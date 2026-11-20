/**
 * Maps the Codex Turn items the Host actually observes onto the public steps of
 * the DingTalk progress card. Only public operations become steps: private
 * reasoning, tool arguments and raw output never leave this module.
 */
import type { JsonObject } from "@codexhost/protocol-core";
import type { DingTalkProgressStep } from "./dingtalk-dispatch-types.js";

const CJK = /[\u3400-\u9fff]/u;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Removes credentials that could appear in a command line, never the whole line. */
function redactSecrets(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "$1 ***")
    .replace(
      /(--?[A-Za-z0-9_-]*(?:token|key|secret|password)[A-Za-z0-9_-]*\s*(?:[=:]\s*)?)(?:"[^"]*"|'[^']*'|\S+)/giu,
      "$1***",
    )
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)/gu,
      "$1***",
    )
    .replace(
      /\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}\b/gu,
      "***",
    );
}

/** One collapsed line, credential-free and bounded. */
export function sanitizeProgressText(value: string, limit = 140): string {
  const compact = redactSecrets(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

/** Commands are shown by their first line only; heredocs are never the point. */
function sanitizeCommand(value: string): string {
  return sanitizeProgressText(value.split(/\r?\n/u)[0] ?? "", 140);
}

/** A short public status line for the panel title; English only text is skipped. */
export function dingtalkStatusText(value: string): string | null {
  const text = sanitizeProgressText(value, 60);
  return text && CJK.test(text) ? text : null;
}

function itemStatus(item: JsonObject): "done" | "failed" {
  if (item.status === "failed" || item.status === "declined" || item.status === "error")
    return "failed";
  if (item.success === false) return "failed";
  if (typeof item.exitCode === "number" && item.exitCode !== 0) return "failed";
  return "done";
}

function stepId(item: JsonObject): string | null {
  return typeof item.id === "string" && item.id ? `item:${item.id}` : null;
}

function fileDetail(item: JsonObject): string {
  const paths = (Array.isArray(item.changes) ? item.changes : [])
    .map((change) => (isRecord(change) && typeof change.path === "string" ? change.path : null))
    .filter((path): path is string => path !== null);
  if (paths.length === 0) return "文件变更";
  const shown = paths
    .slice(0, 3)
    .map((path) => sanitizeProgressText(path, 80))
    .join("、");
  return paths.length > 3 ? `${shown} 等 ${paths.length} 个文件` : shown;
}

function toolDetail(item: JsonObject): string {
  const server = typeof item.server === "string" ? sanitizeProgressText(item.server, 40) : "";
  const tool = typeof item.tool === "string" ? sanitizeProgressText(item.tool, 60) : "";
  return [server, tool].filter(Boolean).join(" · ") || "工具调用";
}

/**
 * One public step for an observed item, or null when the item must stay
 * private. `completed` is the event, because some items do not report status.
 */
export function dingtalkProgressStep(
  item: JsonObject,
  completed: boolean,
): DingTalkProgressStep | null {
  const id = stepId(item);
  if (!id) return null;
  const status = completed ? itemStatus(item) : "running";
  switch (item.type) {
    case "commandExecution": {
      const command = typeof item.command === "string" ? item.command : "";
      return {
        id,
        kind: "command",
        title: "执行命令",
        detail: command ? sanitizeCommand(command) : "命令已启动",
        status,
      };
    }
    case "fileChange":
      return { id, kind: "file", title: "修改文件", detail: fileDetail(item), status };
    case "mcpToolCall":
    case "dynamicToolCall":
    case "toolExecution":
      return { id, kind: "tool", title: "调用工具", detail: toolDetail(item), status };
    case "webSearch": {
      const query = typeof item.query === "string" ? sanitizeProgressText(item.query, 120) : "";
      return { id, kind: "search", title: "搜索资料", detail: query || "网页搜索", status };
    }
    case "agentMessage":
      if (item.phase === "commentary") return null;
      return { id, kind: "answer", title: "撰写回答", detail: "整理最终回答", status };
    default:
      return null;
  }
}

/** Public commentary only; the reasoning and tool payloads never become text. */
export function dingtalkProgressStatus(item: JsonObject): string | null {
  if (item.type !== "agentMessage" || item.phase !== "commentary") return null;
  return typeof item.text === "string" ? dingtalkStatusText(item.text) : null;
}
