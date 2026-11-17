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

const AVATAR_TONES = [
  "var(--color-avatar-blue)",
  "var(--color-avatar-light-blue)",
  "var(--color-avatar-purple)",
];

/** sdbm spreads neighbouring ids across the native avatar palette. */
export function avatarTone(conversationId: string): string {
  let hash = 0;
  for (const character of conversationId) {
    const code = character.codePointAt(0) ?? 0;
    hash = (code + (hash << 6) + (hash << 16) - hash) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length] as (typeof AVATAR_TONES)[number];
}

/** The first two Han characters after year prefixes, or one uppercase initial. */
export function dingtalkAvatarLabel(title: string, fallback = "钉"): string {
  const name = title.replace(/\d{4}\s*年/gu, "");
  const han = name.match(/\p{Script=Han}/gu);
  if (han?.length) return han.slice(0, 2).join("");
  return name.match(/\p{L}/u)?.[0]?.toUpperCase() ?? fallback;
}

export function dingtalkInitial(title: string): string {
  return dingtalkAvatarLabel(title);
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
  /** Wire text with `<@id>` placeholders when the bubble shows readable chips. */
  sendText?: string;
  atOpenDingTalkIds?: string[];
  atAll?: boolean;
  /** Local send start; allows one-to-one reconciliation when dws omits the sent ID. */
  echoStartedAt?: number;
}

/** Merge snapshots by stable message identity; repeated deliveries are idempotent. */
export function mergeDingTalkMessages(
  current: readonly ViewMessage[],
  incoming: readonly ViewMessage[],
): ViewMessage[] {
  const byId = new Map<string, ViewMessage>();
  for (const message of current) byId.set(message.messageId, message);
  for (const message of incoming) {
    if (message.mine && message.echoStartedAt === undefined && !byId.has(message.messageId)) {
      const echo = [...byId.values()].find(
        (local) =>
          local.echoStartedAt !== undefined &&
          local.messageId.startsWith("local-") &&
          !local.failed &&
          local.conversationId === message.conversationId &&
          (local.text.trim() === message.text.trim() ||
            local.sendText?.trim() === message.text.trim()) &&
          message.createdAt >= local.echoStartedAt - 1_000 &&
          message.createdAt <= local.echoStartedAt + 120_000,
      );
      if (echo) byId.delete(echo.messageId);
    }
    byId.set(message.messageId, message);
  }
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt);
}

export function formatDingTalkFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface DingTalkPageState {
  source: "unread" | "empty";
  conversations: DingTalkConversation[];
  selectedId: string | null;
  currentConversation: DingTalkConversation | null;
  messages: ViewMessage[];
  hasMore: boolean;
  nextCursor: number | null;
  search: DingTalkSearchResult | null;
  searchQuery: string;
  searchPending: boolean;
  searchFailed: boolean;
  listError: boolean;
  listLoading: boolean;
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
