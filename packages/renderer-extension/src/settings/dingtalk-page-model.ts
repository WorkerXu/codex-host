import type {
  DingTalkConversation,
  DingTalkMessage,
  DingTalkMention,
} from "@codexhost/shared-contracts";

export function formatDingTalkTime(value: number | null, now = Date.now()): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const current = new Date(now);
  const sameDay =
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate();
  const pad = (input: number): string => String(input).padStart(2, "0");
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === current.getFullYear()) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dingtalkInitial(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "钉";
  return [...trimmed][0] ?? "钉";
}

export function conversationMention(
  conversation: DingTalkConversation | null,
  conversationId: string,
  messageIds: readonly string[] = [],
): DingTalkMention {
  const label = conversation?.title?.trim() || "钉钉会话";
  return messageIds.length > 0
    ? {
        kind: "messages",
        conversationId,
        messageIds: [...messageIds],
        label: `${label}（${messageIds.length} 条消息）`,
      }
    : { kind: "conversation", conversationId, label };
}

export function messagePreview(message: DingTalkMessage): string {
  if (message.unsupported) return "非文本消息，请在手机上查看";
  const text = message.text.replace(/\s+/gu, " ").trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

export function selectedMessageIds(selected: ReadonlySet<string>): string[] {
  return [...selected];
}
