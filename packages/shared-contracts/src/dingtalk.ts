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

// Desktop may wrap or split a long carrier between the label and the target;
// whitespace there is layout, not a different mention. Desktop's Markdown
// serializer also escapes the opening parenthesis (`]\(`) and characters in the
// label (`\[`, `\]`, `\_`), so backslash escapes are accepted and removed.
const MENTION_LINK_PATTERN =
  /\[((?:\\.|[^\]\n\\]){0,512})\]\s*\\?\(<?\s*dingtalk:\/\/(conversation|message)\/([^\s()<>\\]+)>?\\?\)/gu;
const MARKDOWN_ESCAPE = /\\([\\`*_{}[\]()#+\-.!|<>~])/gu;
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
      const trimmedLabel = label.replace(MARKDOWN_ESCAPE, "$1").trim().replace(/^@+/u, "").trim();
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
    /** `INTERNAL_GROUP` marks an internal group in list rows and the header. */
    groupType: z.string().max(64).nullable().optional(),
    memberCount: z.number().int().nonnegative().nullable().optional(),
    /** A recent message in this conversation mentions me. */
    atMe: z.boolean().optional(),
  })
  .strict();
export type DingTalkConversation = z.infer<typeof dingtalkConversationSchema>;

export const dingtalkQuotedMessageSchema = z
  .object({
    senderName: z.string().max(256),
    text: z.string().max(20_000),
    messageId: z.string().max(512).optional(),
    createdAt: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type DingTalkQuotedMessage = z.infer<typeof dingtalkQuotedMessageSchema>;

export const dingtalkReactionSchema = z
  .object({
    emoji: z.string().min(1).max(64),
    count: z.number().int().positive(),
  })
  .strict();
export type DingTalkReaction = z.infer<typeof dingtalkReactionSchema>;

export const dingtalkMessageResourceSchema = z
  .object({
    kind: z.enum(["image", "file"]),
    name: z.string().max(512).nullable().optional(),
    sizeBytes: z.number().int().nonnegative().nullable().optional(),
    resourceId: z.string().min(1).max(4_096),
    resourceIdType: z.string().min(1).max(32),
  })
  .strict();
export type DingTalkMessageResource = z.infer<typeof dingtalkMessageResourceSchema>;

export const dingtalkMessageSchema = z
  .object({
    messageId: z.string().trim().min(1).max(512),
    conversationId: z.string().trim().min(1).max(512),
    senderName: z.string().max(256),
    senderId: z.string().max(512).optional(),
    createdAt: z.number().int().nonnegative(),
    /** Readable text with media tags, `<imageContent>` and raw ids removed. */
    text: z.string().max(40_000),
    unsupported: z.boolean(),
    mine: z.boolean(),
    quotedMessage: dingtalkQuotedMessageSchema.nullable().optional(),
    reactions: z.array(dingtalkReactionSchema).max(20).optional(),
    resources: z.array(dingtalkMessageResourceSchema).max(20).optional(),
    /** `sendType: bot` in dws. */
    bot: z.boolean().optional(),
    /** Markdown card title; the body stays in `text`. */
    cardTitle: z.string().max(512).nullable().optional(),
    /** How the Renderer should render `text`. */
    format: z.enum(["text", "markdown"]).optional(),
  })
  .strict();
export type DingTalkMessage = z.infer<typeof dingtalkMessageSchema>;

/** Local-only methods: the default Host stays on this machine. */
export const DINGTALK_SETTINGS_GET_METHOD = "codexhost/dingtalk/settings/get";
export const DINGTALK_SETTINGS_SET_METHOD = "codexhost/dingtalk/settings/set";

/** Methods every Host can serve; reads route to the configured DingTalk Host. */
export const DINGTALK_STATUS_METHOD = "codexhost/dingtalk/status";
export const DINGTALK_CONVERSATIONS_METHOD = "codexhost/dingtalk/conversations";
export const DINGTALK_DETAILS_METHOD = "codexhost/dingtalk/details";
export const DINGTALK_PREVIEW_METHOD = "codexhost/dingtalk/preview";
export const DINGTALK_MESSAGES_METHOD = "codexhost/dingtalk/messages";
export const DINGTALK_MEMBERS_METHOD = "codexhost/dingtalk/members";
export const DINGTALK_RESOURCE_METHOD = "codexhost/dingtalk/resource";
export const DINGTALK_SEND_METHOD = "codexhost/dingtalk/send";
export const DINGTALK_SEARCH_METHOD = "codexhost/dingtalk/search";
export const DINGTALK_RESOLVE_METHOD = "codexhost/dingtalk/resolve";
export const DINGTALK_VIEWED_METHOD = "codexhost/dingtalk/viewed";
/** Warms the Host's in-memory live state for the conversations the list shows. */
export const DINGTALK_PREFETCH_METHOD = "codexhost/dingtalk/prefetch";
/** Bounded open timings for acceptance; never carries message content. */
export const DINGTALK_DIAGNOSTICS_METHOD = "codexhost/dingtalk/diagnostics";
/** Renderer paint and image timings join the same bounded ring; content-free. */
export const DINGTALK_TIMING_METHOD = "codexhost/dingtalk/timing";

/** Host → Renderer notification: reread current DingTalk state. */
export const DINGTALK_CHANGED_METHOD = "codexhost/dingtalk/changed";

export const DINGTALK_DEFAULT_PEER = "mac";
export const DINGTALK_MAX_MESSAGES = 100;
export const DINGTALK_MAX_CONVERSATIONS = 50;
export const DINGTALK_MAX_MEMBERS = 500;
export const DINGTALK_MAX_AT_MEMBERS = 100;
export const DINGTALK_MAX_PREFETCH = 50;

/** The Host keeps at most this many newest messages per opened conversation. */
export const DINGTALK_LIVE_MESSAGE_LIMIT = 50;
/** Opened conversations whose transcript stays in the live state. */
export const DINGTALK_LIVE_CONVERSATION_LIMIT = 20;
/** Hard cap for the whole live state; it is memory only and never persisted. */
export const DINGTALK_LIVE_MAX_BYTES = 5 * 1024 * 1024;

export const dingtalkStatusParamsSchema = z.object({ refresh: z.boolean().optional() }).strict();

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
    /** `null` means auto: the `mac` peer when configured, otherwise local. */
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

export const dingtalkConversationsParamsSchema = z.object({}).strict();
export type DingTalkConversationsParams = z.infer<typeof dingtalkConversationsParamsSchema>;

export const dingtalkConversationsResultSchema = z
  .object({
    available: z.boolean(),
    source: z.enum(["unread", "empty"]),
    conversations: z.array(dingtalkConversationSchema).max(DINGTALK_MAX_CONVERSATIONS),
    /** When the Host live state was last reconciled from dws, or null. */
    cachedAt: z.number().int().nonnegative().nullable(),
    /** Rows came from the live state and one live dws read is in flight. */
    refreshing: z.boolean(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkConversationsResult = z.infer<typeof dingtalkConversationsResultSchema>;

/** Labels for the rows currently displayed; the Host does not retain these rows. */
export const dingtalkDetailsSchema = z
  .object({ conversations: z.array(dingtalkConversationSchema).max(DINGTALK_MAX_CONVERSATIONS) })
  .strict();

export const dingtalkPreviewParamsSchema = z
  .object({ conversationId: z.string().trim().min(1).max(512) })
  .strict();
export type DingTalkPreviewParams = z.infer<typeof dingtalkPreviewParamsSchema>;

export const dingtalkPreviewResultSchema = z
  .object({
    available: z.boolean(),
    preview: z.string().max(2_000).nullable(),
    cachedAt: z.number().int().nonnegative().nullable(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkPreviewResult = z.infer<typeof dingtalkPreviewResultSchema>;

export const dingtalkMessagesParamsSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(512),
    before: z.number().int().nonnegative().optional(),
    /** The workbench already has a live title; skip a second CLI read. */
    includeConversation: z.boolean().optional(),
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
    /** When the Host live state for this conversation was last reconciled. */
    cachedAt: z.number().int().nonnegative().nullable(),
    /** The messages came from the live state and one live dws read is in flight. */
    refreshing: z.boolean().optional(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkMessagesResult = z.infer<typeof dingtalkMessagesResultSchema>;

export const dingtalkMembersParamsSchema = z
  .object({ conversationId: z.string().trim().min(1).max(512) })
  .strict();
export type DingTalkMembersParams = z.infer<typeof dingtalkMembersParamsSchema>;

export const dingtalkMemberSchema = z
  .object({
    openDingTalkId: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(256),
  })
  .strict();
export type DingTalkMember = z.infer<typeof dingtalkMemberSchema>;

export const dingtalkMembersResultSchema = z
  .object({
    available: z.boolean(),
    members: z.array(dingtalkMemberSchema).max(DINGTALK_MAX_MEMBERS),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkMembersResult = z.infer<typeof dingtalkMembersResultSchema>;

export const dingtalkResourceParamsSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(512),
    messageId: z.string().trim().min(1).max(512),
    resourceId: z.string().trim().min(1).max(4_096),
    resourceIdType: z.string().trim().min(1).max(32),
  })
  .strict();
export type DingTalkResourceParams = z.infer<typeof dingtalkResourceParamsSchema>;

export const dingtalkResourceResultSchema = z
  .object({
    available: z.boolean(),
    dataUrl: z.string().max(12_000_000).nullable(),
    mimeType: z.string().max(128).nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type DingTalkResourceResult = z.infer<typeof dingtalkResourceResultSchema>;

export const dingtalkSendParamsSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(512),
    text: z.string().trim().min(1).max(4_000),
    /** Group members to @; `text` must carry one `<@id>` per entry. */
    atOpenDingTalkIds: z
      .array(z.string().trim().min(1).max(512))
      .max(DINGTALK_MAX_AT_MEMBERS)
      .optional(),
    /** `@所有人`; `text` must carry `<@all>`. */
    atAll: z.boolean().optional(),
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

export const dingtalkSearchParamsSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
  })
  .strict();
export type DingTalkSearchParams = z.infer<typeof dingtalkSearchParamsSchema>;

export const dingtalkSearchResultSchema = z
  .object({
    available: z.boolean(),
    conversations: z.array(dingtalkConversationSchema).max(20),
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
    /** The workbench keeps the row visible without a badge while it stays open. */
    active: z.boolean().optional(),
  })
  .strict();
export type DingTalkViewedParams = z.infer<typeof dingtalkViewedParamsSchema>;

export const dingtalkPrefetchParamsSchema = z
  .object({
    conversationIds: z.array(z.string().trim().min(1).max(512)).min(1).max(DINGTALK_MAX_PREFETCH),
  })
  .strict();
export type DingTalkPrefetchParams = z.infer<typeof dingtalkPrefetchParamsSchema>;

export const dingtalkPrefetchResultSchema = z
  .object({ started: z.number().int().nonnegative() })
  .strict();
export type DingTalkPrefetchResult = z.infer<typeof dingtalkPrefetchResultSchema>;

export const dingtalkDiagnosticsParamsSchema = z
  .object({ limit: z.number().int().min(1).max(200).optional() })
  .strict();
export type DingTalkDiagnosticsParams = z.infer<typeof dingtalkDiagnosticsParamsSchema>;

/** One workbench open: ids and timings only, never message content. */
export const dingtalkOpenTimingSchema = z
  .object({
    at: z.number().int().nonnegative(),
    kind: z.enum(["conversations", "messages", "members", "prefetch", "paint"]),
    conversationId: z.string().max(512).nullable(),
    /** True when the response came from the live state without waiting for dws. */
    memoryHit: z.boolean(),
    /** Milliseconds the workbench waited for the response. */
    waitedMs: z.number().int().nonnegative(),
    /** Duration of the background live read, or null while it runs. */
    liveMs: z.number().int().nonnegative().nullable(),
    liveError: z.string().max(64).nullable(),
    storeBytes: z.number().int().nonnegative(),
    /** Click → first painted transcript frame, measured in the Renderer. */
    paintMs: z.number().int().nonnegative().nullable().default(null),
    /** Synchronous message list, markdown and mention build inside that open. */
    renderMs: z.number().int().nonnegative().nullable().default(null),
    /** Click → initial images settled (loaded or unavailable). */
    imagesMs: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();
export type DingTalkOpenTiming = z.infer<typeof dingtalkOpenTimingSchema>;

export const dingtalkTimingParamsSchema = z
  .object({
    conversationId: z.string().min(1).max(512),
    paintMs: z.number().int().nonnegative(),
    renderMs: z.number().int().nonnegative().nullable(),
    imagesMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type DingTalkTimingParams = z.infer<typeof dingtalkTimingParamsSchema>;

export const dingtalkDiagnosticsResultSchema = z
  .object({
    available: z.boolean(),
    entries: z.array(dingtalkOpenTimingSchema).max(200),
    storeBytes: z.number().int().nonnegative(),
    peakStoreBytes: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    messageConversations: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    members: z.number().int().nonnegative(),
  })
  .strict();
export type DingTalkDiagnosticsResult = z.infer<typeof dingtalkDiagnosticsResultSchema>;
