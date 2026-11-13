import { z } from "zod";

/**
 * DingTalk carriers shared by the Renderer workbench and the Host.
 *
 * The Renderer inserts Codex Desktop's native mention chip, which Desktop
 * serializes into the prompt as a Markdown link with a `dingtalk://` path. The
 * Host rewrites every carrier into a read-only context block before the prompt
 * reaches a Harness, so the raw link never leaks into a model turn.
 *
 * Conversation and message ids are opaque and may contain `/`, `+` and `=`.
 * Each segment is therefore percent-encoded; the parser also accepts raw ids
 * and uses the last `/` as the message separator.
 */
export const DINGTALK_MENTION_PATH_PREFIX = "dingtalk://";

const MENTION_LINK_PATTERN =
  /\[([^\]\n]{0,512})\]\(<?dingtalk:\/\/(conversation|message)\/([^\s()<>]+)>?\)/gu;
const ID_SEGMENT = /^[^()<>\r\n]{1,512}$/u;
const MAX_MESSAGE_IDS = 200;

export interface DingTalkConversationMention {
  kind: "conversation";
  conversationId: string;
  label: string;
}

export interface DingTalkMessagesMention {
  kind: "messages";
  conversationId: string;
  messageIds: string[];
  label: string;
}

export type DingTalkMention = DingTalkConversationMention | DingTalkMessagesMention;

function validSegment(value: string): boolean {
  return ID_SEGMENT.test(value);
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/giu, "%2F");
}

function sanitizeLabel(label: string): string {
  const cleaned = label
    .replace(/[[\]()\n\r]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "钉钉";
}

/** Exact native mention path for one conversation. */
export function dingtalkConversationPath(conversationId: string): string {
  if (!validSegment(conversationId)) throw new Error("Invalid DingTalk conversation id");
  return `${DINGTALK_MENTION_PATH_PREFIX}conversation/${encodeSegment(conversationId)}`;
}

/** Exact native mention path for selected messages of one conversation. */
export function dingtalkMessagePath(conversationId: string, messageIds: readonly string[]): string {
  if (!validSegment(conversationId)) throw new Error("Invalid DingTalk conversation id");
  const ids = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_MESSAGE_IDS) {
    throw new Error("Invalid DingTalk message id list");
  }
  if (ids.some((id) => !validSegment(id))) throw new Error("Invalid DingTalk message id");
  return `${DINGTALK_MENTION_PATH_PREFIX}message/${encodeSegment(conversationId)}/${ids
    .map(encodeSegment)
    .join(",")}`;
}

/** Markdown carrier Desktop restores into a native mention chip. */
export function formatDingTalkMentionLink(mention: DingTalkMention): string {
  const label = sanitizeLabel(mention.label);
  const path =
    mention.kind === "conversation"
      ? dingtalkConversationPath(mention.conversationId)
      : dingtalkMessagePath(mention.conversationId, mention.messageIds);
  return `[@${label}](${path})`;
}

function parsePath(kind: string, tail: string): DingTalkMention | null {
  if (kind === "conversation") {
    const conversationId = decodeSegment(tail);
    return validSegment(conversationId)
      ? { kind: "conversation", conversationId, label: "" }
      : null;
  }
  const separator = tail.lastIndexOf("/");
  if (separator <= 0 || separator === tail.length - 1) return null;
  const conversationId = decodeSegment(tail.slice(0, separator));
  const rawIds = tail.slice(separator + 1);
  const messageIds = [...new Set(rawIds.split(",").map(decodeSegment).filter(Boolean))];
  if (
    !validSegment(conversationId) ||
    messageIds.length === 0 ||
    messageIds.length > MAX_MESSAGE_IDS ||
    messageIds.some((id) => !validSegment(id))
  ) {
    return null;
  }
  return { kind: "messages", conversationId, messageIds, label: "" };
}

export interface DingTalkMentionRewrite {
  text: string;
  mentions: DingTalkMention[];
}

/**
 * Replace each carrier link with its readable `@Label` form. Returns the
 * mentioned conversations in first-seen order, merged by conversation.
 */
export function stripDingTalkMentions(text: string): DingTalkMentionRewrite {
  const mentions: DingTalkMention[] = [];
  const index = new Map<string, DingTalkMention>();
  const rewritten = text.replace(
    MENTION_LINK_PATTERN,
    (match, label: string, kind: string, tail: string) => {
      const parsed = parsePath(kind, tail);
      if (!parsed) return match;
      const trimmedLabel = label.trim().replace(/^@+/u, "").trim();
      parsed.label = trimmedLabel || "钉钉";
      const existing = index.get(parsed.conversationId);
      if (!existing) {
        index.set(parsed.conversationId, parsed);
        mentions.push(parsed);
      } else if (existing.kind === "messages" && parsed.kind === "messages") {
        existing.messageIds = [...new Set([...existing.messageIds, ...parsed.messageIds])];
        if (!existing.label && parsed.label) existing.label = parsed.label;
      }
      return `@${parsed.label}`;
    },
  );
  return { text: rewritten, mentions };
}

/** Fast path used before any CLI work starts. */
export function hasDingTalkCarrier(text: string): boolean {
  return stripDingTalkMentions(text).mentions.length > 0;
}

export const dingtalkConversationSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(512),
    title: z.string().max(1_024),
    singleChat: z.boolean(),
    unreadCount: z.number().int().nonnegative(),
    lastMessageAt: z.number().int().nonnegative().nullable(),
    muted: z.boolean(),
    preview: z.string().max(2_000).optional(),
  })
  .strict();
export type DingTalkConversation = z.infer<typeof dingtalkConversationSchema>;

export const dingtalkMessageSchema = z
  .object({
    messageId: z.string().trim().min(1).max(512),
    conversationId: z.string().trim().min(1).max(512),
    senderName: z.string().max(256),
    senderId: z.string().max(512).optional(),
    createdAt: z.number().int().nonnegative(),
    text: z.string().max(20_000),
    unsupported: z.boolean(),
    mine: z.boolean(),
  })
  .strict();
export type DingTalkMessage = z.infer<typeof dingtalkMessageSchema>;

/** Local-only methods: Gemini key and the default Host stay on this machine. */
export const DINGTALK_SETTINGS_GET_METHOD = "codexhost/dingtalk/settings/get";
export const DINGTALK_SETTINGS_SET_METHOD = "codexhost/dingtalk/settings/set";
export const DINGTALK_DECIDE_METHOD = "codexhost/dingtalk/decide";

/** Methods every Host can serve; reads route to the configured DingTalk Host. */
export const DINGTALK_STATUS_METHOD = "codexhost/dingtalk/status";
export const DINGTALK_CONVERSATIONS_METHOD = "codexhost/dingtalk/conversations";
export const DINGTALK_MESSAGES_METHOD = "codexhost/dingtalk/messages";
export const DINGTALK_SEND_METHOD = "codexhost/dingtalk/send";
export const DINGTALK_SEARCH_METHOD = "codexhost/dingtalk/search";
export const DINGTALK_RESOLVE_METHOD = "codexhost/dingtalk/resolve";
export const DINGTALK_VIEWED_METHOD = "codexhost/dingtalk/viewed";

/** Host → Renderer notification: cached unread state changed. */
export const DINGTALK_CHANGED_METHOD = "codexhost/dingtalk/changed";

export const DINGTALK_DEFAULT_PEER = "tencent";
export const DINGTALK_MAX_MESSAGES = 100;
export const DINGTALK_MAX_CONVERSATIONS = 50;

export const dingtalkStatusSchema = z
  .object({
    installed: z.boolean(),
    authenticated: z.boolean(),
    userName: z.string().max(256).nullable(),
    userId: z.string().max(512).nullable(),
    corpName: z.string().max(512).nullable(),
    /** Effective peer name, or `local` when this Host runs dws itself. */
    defaultHost: z.string().max(128),
    defaultHostId: z.string().max(256).nullable(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkStatus = z.infer<typeof dingtalkStatusSchema>;

export const dingtalkHostOptionSchema = z
  .object({
    name: z.string().min(1).max(128),
    hostId: z.string().max(256).nullable(),
    local: z.boolean(),
  })
  .strict();
export type DingTalkHostOption = z.infer<typeof dingtalkHostOptionSchema>;

export const dingtalkSettingsSchema = z
  .object({
    /** `null` means auto: the `tencent` peer when configured, otherwise local. */
    defaultHost: z.string().max(128).nullable(),
    effectiveHost: z.string().max(128),
    effectiveHostId: z.string().max(256).nullable(),
    hosts: z.array(dingtalkHostOptionSchema).max(128),
  })
  .strict();
export type DingTalkSettings = z.infer<typeof dingtalkSettingsSchema>;

export const dingtalkSettingsSetParamsSchema = z
  .object({ defaultHost: z.string().trim().max(128).nullable() })
  .strict();
export type DingTalkSettingsSetParams = z.infer<typeof dingtalkSettingsSetParamsSchema>;

export const dingtalkConversationsParamsSchema = z
  .object({ refresh: z.boolean().optional() })
  .strict();
export type DingTalkConversationsParams = z.infer<typeof dingtalkConversationsParamsSchema>;

export const dingtalkConversationsResultSchema = z
  .object({
    available: z.boolean(),
    source: z.enum(["unread", "recent-replied", "empty"]),
    conversations: z.array(dingtalkConversationSchema).max(DINGTALK_MAX_CONVERSATIONS),
    cachedAt: z.number().int().nonnegative().nullable(),
    refreshing: z.boolean(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkConversationsResult = z.infer<typeof dingtalkConversationsResultSchema>;

export const dingtalkMessagesParamsSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(512),
    before: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(DINGTALK_MAX_MESSAGES).optional(),
  })
  .strict();
export type DingTalkMessagesParams = z.infer<typeof dingtalkMessagesParamsSchema>;

export const dingtalkMessagesResultSchema = z
  .object({
    available: z.boolean(),
    conversation: dingtalkConversationSchema.nullable(),
    messages: z.array(dingtalkMessageSchema).max(DINGTALK_MAX_MESSAGES),
    hasMore: z.boolean(),
    nextCursor: z.number().int().nonnegative().nullable(),
    cachedAt: z.number().int().nonnegative().nullable(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkMessagesResult = z.infer<typeof dingtalkMessagesResultSchema>;

export const dingtalkSendParamsSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(512),
    text: z.string().trim().min(1).max(4_000),
  })
  .strict();
export type DingTalkSendParams = z.infer<typeof dingtalkSendParamsSchema>;

export const dingtalkSendResultSchema = z
  .object({
    ok: z.boolean(),
    messageId: z.string().max(512).nullable(),
    sentAt: z.number().int().nonnegative(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkSendResult = z.infer<typeof dingtalkSendResultSchema>;

export const dingtalkDecideParamsSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    conversations: z
      .array(
        z
          .object({
            conversationId: z.string().min(1).max(512),
            title: z.string().max(1_024),
            singleChat: z.boolean(),
            lastMessageAt: z.number().int().nonnegative().nullable(),
            preview: z.string().max(2_000).optional(),
          })
          .strict(),
      )
      .max(DINGTALK_MAX_CONVERSATIONS),
  })
  .strict();
export type DingTalkDecideParams = z.infer<typeof dingtalkDecideParamsSchema>;

export const dingtalkDecideResultSchema = z
  .object({
    available: z.boolean(),
    route: z.enum(["messages", "conversations", "none"]),
    /** Keyword for `+search-msg`; empty means the raw query is not reusable. */
    messageQuery: z.string().max(200),
    fromMe: z.boolean(),
    atMe: z.boolean(),
    days: z.number().int().min(1).max(90),
    conversationIds: z.array(z.string().max(512)).max(8),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkDecideResult = z.infer<typeof dingtalkDecideResultSchema>;

export const dingtalkSearchParamsSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    route: z.enum(["messages", "conversations"]),
    messageQuery: z.string().max(200).optional(),
    fromMe: z.boolean().optional(),
    atMe: z.boolean().optional(),
    days: z.number().int().min(1).max(90).optional(),
    conversationIds: z.array(z.string().max(512)).max(8).optional(),
  })
  .strict();
export type DingTalkSearchParams = z.infer<typeof dingtalkSearchParamsSchema>;

export const dingtalkSearchResultSchema = z
  .object({
    available: z.boolean(),
    route: z.enum(["messages", "conversations", "none"]),
    conversations: z.array(dingtalkConversationSchema).max(8),
    messages: z.array(dingtalkMessageSchema).max(50),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkSearchResult = z.infer<typeof dingtalkSearchResultSchema>;

export const dingtalkResolveParamsSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(512),
    messageIds: z.array(z.string().min(1).max(512)).max(DINGTALK_MAX_MESSAGES).optional(),
    contextBefore: z.number().int().min(0).max(20).optional(),
    contextAfter: z.number().int().min(0).max(20).optional(),
  })
  .strict();
export type DingTalkResolveParams = z.infer<typeof dingtalkResolveParamsSchema>;

export const dingtalkResolveResultSchema = z
  .object({
    available: z.boolean(),
    conversation: dingtalkConversationSchema.nullable(),
    messages: z.array(dingtalkMessageSchema).max(DINGTALK_MAX_MESSAGES),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkResolveResult = z.infer<typeof dingtalkResolveResultSchema>;

export const dingtalkViewedParamsSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(512),
    lastMessageAt: z.number().int().nonnegative(),
  })
  .strict();
export type DingTalkViewedParams = z.infer<typeof dingtalkViewedParamsSchema>;
