import type {
  DingTalkConversation,
  DingTalkMessage,
  DingTalkMention,
  DingTalkSearchResult,
} from "@codexhost/shared-contracts";

const MINUTE = 60_000;

function startOfDay(value: number | Date): number {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function isSameDingTalkDay(left: number, right: number): boolean {
  return startOfDay(left) === startOfDay(right);
}

export function isYesterday(value: number, now = Date.now()): boolean {
  return startOfDay(value) === startOfDay(now) - 24 * 60 * MINUTE;
}

function clock(value: number): string {
  const date = new Date(value);
  const pad = (input: number): string => String(input).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Conversation-row time: clock today, 昨天, month/day this year, full date earlier. */
export function formatDingTalkTime(value: number | null, now = Date.now()): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (isSameDingTalkDay(value, now)) return clock(value);
  if (isYesterday(value, now)) return "昨天";
  const pad = (input: number): string => String(input).padStart(2, "0");
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  return `${String(date.getFullYear()).slice(-2)}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
}

/** Centered date separator label. */
export function formatDingTalkDateLabel(value: number, now = Date.now()): string {
  if (isSameDingTalkDay(value, now)) return "今天";
  if (isYesterday(value, now)) return "昨天";
  const date = new Date(value);
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? monthDay
    : `${date.getFullYear()}年${monthDay}`;
}

export function formatDingTalkClock(value: number): string {
  return clock(value);
}

/** A centered time marker inside one day; date changes use a date separator. */
export function formatDingTalkTimeMark(value: number): string {
  return clock(value);
}

export function dayKey(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Consecutive messages by one sender within three minutes share one header. */
export function continuesDingTalkGroup(
  previous: DingTalkMessage | undefined,
  message: DingTalkMessage,
): boolean {
  if (!previous) return false;
  if (previous.mine !== message.mine) return false;
  if (previous.senderId && message.senderId) {
    if (previous.senderId !== message.senderId) return false;
  } else if (previous.senderName !== message.senderName) {
    return false;
  }
  if (!isSameDingTalkDay(previous.createdAt, message.createdAt)) return false;
  return message.createdAt - previous.createdAt <= 3 * MINUTE;
}

export function dingtalkInitial(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "钉";
  return [...trimmed][0] ?? "钉";
}

const AVATAR_TONES = [
  "var(--color-token-charts-blue)",
  "var(--color-token-charts-green)",
  "var(--color-token-charts-orange)",
  "var(--color-token-charts-purple)",
  "var(--color-token-charts-yellow)",
  "var(--color-token-charts-red)",
] as const;

/** FNV-1a keeps the same conversation on the same soft tone across sessions. */
export function avatarTone(conversationId: string): string {
  let hash = 0x811c9dc5;
  for (const character of conversationId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0];
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

/** One-line summary for a card or other message the workbench cannot render. */
export function unsupportedSummary(message: DingTalkMessage): string {
  const title = message.text.replace(/\s+/gu, " ").trim().slice(0, 80);
  return title ? `[卡片] ${title} · 在手机上查看` : "[卡片] 在手机上查看";
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export interface ViewMessage extends DingTalkMessage {
  pending?: boolean;
  failed?: boolean;
}

export interface DingTalkPageState {
  source: "unread" | "recent-replied" | "empty";
  view: "unread" | "recent";
  conversations: DingTalkConversation[];
  selectedId: string | null;
  currentConversation: DingTalkConversation | null;
  messages: ViewMessage[];
  hasMore: boolean;
  nextCursor: number | null;
  selectedMessages: Set<string>;
  search: DingTalkSearchResult | null;
  searchQuery: string;
  searchPending: boolean;
  searchFailed: boolean;
  listError: boolean;
  loadingMessages: boolean;
  messagesError: boolean;
  loadMoreError: boolean;
  pendingNewCount: number;
}

/** Case-insensitive, literal keyword split for search highlighting. */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (;;) {
    const index = lowerText.indexOf(lowerNeedle, cursor);
    if (index < 0) break;
    if (index > cursor) segments.push({ text: text.slice(cursor, index), match: false });
    segments.push({ text: text.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}

export function selectedMessageIds(selected: ReadonlySet<string>): string[] {
  return [...selected];
}
