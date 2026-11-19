import {
  DINGTALK_LIVE_CONVERSATION_LIMIT,
  DINGTALK_LIVE_MAX_BYTES,
  DINGTALK_LIVE_MESSAGE_LIMIT,
  DINGTALK_MAX_CONVERSATIONS,
  type DingTalkConversation,
  type DingTalkMember,
  type DingTalkMessage,
} from "@codexhost/shared-contracts";

export interface DingTalkLiveMessagePage {
  messages: DingTalkMessage[];
  hasMore: boolean;
  nextCursor: number | null;
  cachedAt: number;
}

export interface DingTalkLiveMemberList {
  members: DingTalkMember[];
  cachedAt: number;
}

export interface DingTalkLiveStats {
  storeBytes: number;
  peakStoreBytes: number;
  conversations: number;
  messageConversations: number;
  messages: number;
  members: number;
}

interface Entry {
  row: DingTalkConversation;
  /** Newest first, at most DINGTALK_LIVE_MESSAGE_LIMIT. */
  messages: DingTalkMessage[];
  members: DingTalkMember[] | null;
  /** When `messages` was last reconciled from dws; null until first opened. */
  messagesAt: number | null;
  membersAt: number | null;
  /** The live page had older messages before this one. */
  hasMore: boolean;
  nextCursor: number | null;
  /** Least-recently-viewed eviction order for message and member payloads. */
  touchedAt: number;
  bytes: number;
}

function normalizedRow(row: DingTalkConversation): DingTalkConversation {
  return {
    conversationId: row.conversationId,
    title: row.title,
    singleChat: row.singleChat,
    unreadCount: Math.max(0, Math.floor(row.unreadCount)),
    lastMessageAt: row.lastMessageAt,
    muted: row.muted,
    ...(row.preview !== undefined ? { preview: row.preview } : {}),
    ...(row.groupType !== undefined ? { groupType: row.groupType } : {}),
    ...(row.memberCount !== undefined ? { memberCount: row.memberCount } : {}),
    ...(row.atMe !== undefined ? { atMe: row.atMe } : {}),
  };
}

/** Text and resource references only; image and file bytes never enter the store. */
function normalizedMessage(message: DingTalkMessage): DingTalkMessage {
  return { ...message };
}

function mergeRow(
  previous: DingTalkConversation,
  incoming: DingTalkConversation,
): DingTalkConversation {
  const merged = normalizedRow({ ...previous, ...incoming });
  // A live unread row omits the preview, group metadata and @ flag; keep the
  // newer values the store already learned from messages, details or events.
  if (incoming.preview === undefined && previous.preview !== undefined) {
    merged.preview = previous.preview;
  }
  if (incoming.groupType === undefined && previous.groupType !== undefined) {
    merged.groupType = previous.groupType;
  }
  if (incoming.memberCount === undefined && previous.memberCount !== undefined) {
    merged.memberCount = previous.memberCount;
  }
  if (incoming.atMe === undefined && previous.atMe !== undefined) {
    merged.atMe = previous.atMe;
  }
  return merged;
}

/**
 * Host-local live state for the DingTalk workbench. It is memory only, never
 * written to disk, and cleared with the Host process or a DingTalk logout.
 *
 * Every mutation recomputes the serialized size of the touched conversation.
 * Least-recently-viewed transcripts are dropped first, then rows, until the
 * whole store fits DINGTALK_LIVE_MAX_BYTES.
 */
export class DingTalkLiveStore {
  readonly #entries = new Map<string, Entry>();
  readonly #maxBytes: number;
  #bytes = 0;
  #peakBytes = 0;
  #listAt: number | null = null;

  constructor(options: { maxBytes?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? DINGTALK_LIVE_MAX_BYTES;
  }

  /** True once a full unread list has been read from dws. */
  hasList(): boolean {
    return this.#listAt !== null;
  }

  listAt(): number | null {
    return this.#listAt;
  }

  rows(): DingTalkConversation[] {
    return [...this.#entries.values()]
      .map((entry) => ({ ...entry.row }))
      .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0));
  }

  row(conversationId: string): DingTalkConversation | null {
    const entry = this.#entries.get(conversationId);
    return entry ? { ...entry.row } : null;
  }

  /**
   * Replaces the rows of the unread list. `keep` holds ids that must survive
   * even when the live list no longer shows them (the open conversation).
   */
  applyConversations(
    rows: readonly DingTalkConversation[],
    options: { now: number; keep?: readonly string[] },
  ): boolean {
    const keep = new Set(options.keep ?? []);
    const incoming = new Map(rows.map((row) => [row.conversationId, row]));
    let changed = false;
    for (const [conversationId, entry] of [...this.#entries]) {
      if (incoming.has(conversationId) || keep.has(conversationId)) continue;
      if (entry.messages.length > 0 || entry.members !== null) continue;
      this.#remove(entry);
      changed = true;
    }
    for (const row of rows) {
      const entry = this.#ensure(row.conversationId);
      const merged = mergeRow(entry.row, row);
      if (JSON.stringify(merged) !== JSON.stringify(entry.row)) {
        this.#setRow(entry, merged);
        changed = true;
      }
    }
    this.#listAt = options.now;
    this.#trim();
    return changed;
  }

  /** Group metadata and @ flags from `details`; a later list read keeps them. */
  applyDetails(rows: readonly DingTalkConversation[]): boolean {
    let changed = false;
    for (const row of rows) {
      const entry = this.#entries.get(row.conversationId);
      if (!entry) continue;
      const merged = mergeRow(entry.row, row);
      if (JSON.stringify(merged) === JSON.stringify(entry.row)) continue;
      this.#setRow(entry, merged);
      changed = true;
    }
    this.#trim();
    return changed;
  }

  applyMessages(input: {
    conversationId: string;
    /** Newest first. */
    messages: readonly DingTalkMessage[];
    hasMore: boolean;
    nextCursor: number | null;
    preview: string | null;
    now: number;
  }): boolean {
    const entry = this.#ensure(input.conversationId);
    const before = this.#snapshot(entry);
    const byId = new Map(entry.messages.map((message) => [message.messageId, message]));
    const liveIds = new Set(input.messages.map(({ messageId }) => messageId));
    const newestAt = input.messages[0]?.createdAt ?? 0;
    const oldestAt = input.messages.at(-1)?.createdAt ?? 0;
    // Keep only what the live page cannot cover: the transcript older than the
    // page and events that arrived after the read started. A message inside the
    // page that dws no longer returns was recalled and is dropped.
    for (const [messageId, message] of byId) {
      if (liveIds.has(messageId)) continue;
      if (message.createdAt <= newestAt && message.createdAt >= oldestAt) {
        byId.delete(messageId);
      }
    }
    for (const message of input.messages) {
      byId.set(message.messageId, normalizedMessage(message));
    }
    entry.messages = [...byId.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, DINGTALK_LIVE_MESSAGE_LIMIT);
    entry.messagesAt = input.now;
    entry.hasMore = input.hasMore;
    entry.nextCursor = input.nextCursor;
    entry.touchedAt = input.now;
    const newest = entry.messages[0];
    if (newest && newest.createdAt >= (entry.row.lastMessageAt ?? 0)) {
      this.#setRow(entry, {
        ...entry.row,
        lastMessageAt: newest.createdAt,
        ...(input.preview !== null ? { preview: input.preview } : {}),
      });
    }
    return this.#commit(entry, before);
  }

  /** One Stream event: append, bump the badge and preview, move the row up. */
  applyEvent(input: {
    message: DingTalkMessage;
    preview: string;
    title: string;
    singleChat: boolean;
    atMe: boolean;
    now: number;
  }): boolean {
    const { message } = input;
    const existing = this.#entries.get(message.conversationId);
    if (!existing && !input.title.trim() && !input.singleChat) return false;
    const entry = this.#ensure(message.conversationId);
    const before = this.#snapshot(entry);
    const row: DingTalkConversation = { ...entry.row };
    if (!row.title && input.title) row.title = input.title;
    row.singleChat = input.singleChat;
    if (!message.mine) row.unreadCount += 1;
    if (message.createdAt >= (row.lastMessageAt ?? 0)) {
      row.lastMessageAt = message.createdAt;
      row.preview = input.preview;
      if (input.atMe && !message.mine) row.atMe = true;
    }
    this.#setRow(entry, row);
    if (entry.messagesAt !== null) {
      entry.messages = [normalizedMessage(message), ...entry.messages]
        .filter(
          (candidate, index, all) =>
            all.findIndex((other) => other.messageId === candidate.messageId) === index,
        )
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, DINGTALK_LIVE_MESSAGE_LIMIT);
    }
    entry.touchedAt = input.now;
    return this.#commit(entry, before);
  }

  applyMembers(conversationId: string, members: readonly DingTalkMember[], now: number): boolean {
    const entry = this.#ensure(conversationId);
    const before = this.#snapshot(entry);
    entry.members = members.map((member) => ({ ...member }));
    entry.membersAt = now;
    entry.touchedAt = now;
    return this.#commit(entry, before);
  }

  /** Newest transcript page, or null when this conversation was never opened. */
  messages(conversationId: string, limit: number, now: number): DingTalkLiveMessagePage | null {
    const entry = this.#entries.get(conversationId);
    if (!entry || entry.messages.length === 0 || entry.messagesAt === null) return null;
    entry.touchedAt = now;
    return this.#page(entry, limit);
  }

  /** The stored page for a conversation that already has a transcript. */
  page(conversationId: string, limit: number): DingTalkLiveMessagePage | null {
    const entry = this.#entries.get(conversationId);
    if (!entry || entry.messages.length === 0 || entry.messagesAt === null) return null;
    return this.#page(entry, limit);
  }

  members(conversationId: string, now: number): DingTalkLiveMemberList | null {
    const entry = this.#entries.get(conversationId);
    if (!entry || entry.members === null || entry.membersAt === null) return null;
    entry.touchedAt = now;
    return { members: entry.members.map((member) => ({ ...member })), cachedAt: entry.membersAt };
  }

  touch(conversationId: string, now: number): void {
    const entry = this.#entries.get(conversationId);
    if (entry) entry.touchedAt = now;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
    this.#peakBytes = 0;
    this.#listAt = null;
  }

  stats(): DingTalkLiveStats {
    let messageConversations = 0;
    let messages = 0;
    let members = 0;
    for (const entry of this.#entries.values()) {
      if (entry.messages.length > 0) messageConversations += 1;
      messages += entry.messages.length;
      members += entry.members?.length ?? 0;
    }
    return {
      storeBytes: this.#bytes,
      peakStoreBytes: this.#peakBytes,
      conversations: this.#entries.size,
      messageConversations,
      messages,
      members,
    };
  }

  #page(entry: Entry, limit: number): DingTalkLiveMessagePage {
    const page = entry.messages.slice(0, limit);
    const hasStoredMore = entry.messages.length > limit;
    const hasMore = hasStoredMore || entry.hasMore;
    const nextCursor = hasStoredMore
      ? (page.at(-1)?.createdAt ?? entry.nextCursor)
      : entry.nextCursor;
    return {
      messages: page.map((message) => ({ ...message })),
      hasMore,
      nextCursor: hasMore ? nextCursor : null,
      cachedAt: entry.messagesAt ?? 0,
    };
  }

  #ensure(conversationId: string): Entry {
    const existing = this.#entries.get(conversationId);
    if (existing) return existing;
    const entry: Entry = {
      row: {
        conversationId,
        title: "",
        singleChat: false,
        unreadCount: 0,
        lastMessageAt: null,
        muted: false,
      },
      messages: [],
      members: null,
      messagesAt: null,
      membersAt: null,
      hasMore: false,
      nextCursor: null,
      touchedAt: 0,
      bytes: 0,
    };
    entry.bytes = this.#bytesOf(entry);
    this.#entries.set(conversationId, entry);
    this.#bytes += entry.bytes;
    this.#peakBytes = Math.max(this.#peakBytes, this.#bytes);
    return entry;
  }

  #remove(entry: Entry): void {
    if (!this.#entries.delete(entry.row.conversationId)) return;
    this.#bytes -= entry.bytes;
  }

  #setRow(entry: Entry, row: DingTalkConversation): void {
    entry.row = row;
    const after = this.#bytesOf(entry);
    this.#bytes += after - entry.bytes;
    entry.bytes = after;
  }

  #snapshot(entry: Entry): string {
    return JSON.stringify([
      entry.row,
      entry.messages,
      entry.members,
      entry.hasMore,
      entry.nextCursor,
    ]);
  }

  #bytesOf(entry: Entry, serialized?: string): number {
    return Buffer.byteLength(serialized ?? this.#snapshot(entry), "utf8");
  }

  #commit(entry: Entry, before: string): boolean {
    const after = this.#snapshot(entry);
    if (after === before) return false;
    const bytes = Buffer.byteLength(after, "utf8");
    this.#bytes += bytes - entry.bytes;
    entry.bytes = bytes;
    this.#trim();
    // The cap applies to the retained state; record it after eviction.
    this.#peakBytes = Math.max(this.#peakBytes, this.#bytes);
    return true;
  }

  /** Drops least-recently-viewed payloads, then rows, until the caps hold. */
  #trim(): void {
    for (;;) {
      const withPayload = [...this.#entries.values()].filter(
        (entry) => entry.messages.length > 0 || entry.members !== null,
      );
      if (withPayload.length <= DINGTALK_LIVE_CONVERSATION_LIMIT && this.#bytes <= this.#maxBytes) {
        break;
      }
      withPayload.sort((left, right) => left.touchedAt - right.touchedAt);
      const overCount = withPayload.length > DINGTALK_LIVE_CONVERSATION_LIMIT;
      const victim = withPayload[0];
      if (!victim) break;
      if (!overCount && this.#bytes <= this.#maxBytes) break;
      this.#dropPayload(victim);
    }
    while (this.#bytes > this.#maxBytes || this.#entries.size > DINGTALK_MAX_CONVERSATIONS) {
      const candidates = [...this.#entries.values()]
        .filter((entry) => entry.messages.length === 0 && entry.members === null)
        .sort((left, right) => (left.row.lastMessageAt ?? 0) - (right.row.lastMessageAt ?? 0));
      const victim = candidates[0];
      if (!victim) break;
      this.#remove(victim);
    }
  }

  #dropPayload(entry: Entry): void {
    const before = this.#bytesOf(entry);
    entry.messages = [];
    entry.members = null;
    entry.messagesAt = null;
    entry.membersAt = null;
    entry.hasMore = false;
    entry.nextCursor = null;
    const after = this.#bytesOf(entry);
    entry.bytes = after;
    this.#bytes += after - before;
  }
}
