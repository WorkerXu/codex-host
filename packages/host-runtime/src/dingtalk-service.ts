import {
  dingtalkConversationsResultSchema,
  dingtalkMessagesResultSchema,
  dingtalkPreviewResultSchema,
  dingtalkResolveResultSchema,
  dingtalkResourceResultSchema,
  dingtalkSearchResultSchema,
  dingtalkSendResultSchema,
  dingtalkSettingsSchema,
  dingtalkStatusSchema,
  type DingTalkConversation,
  type DingTalkConversationsParams,
  type DingTalkConversationsResult,
  type DingTalkMessage,
  type DingTalkMessagesParams,
  type DingTalkMessagesResult,
  type DingTalkMention,
  type DingTalkPreviewResult,
  type DingTalkResourceParams,
  type DingTalkResourceResult,
  type DingTalkResolveResult,
  type DingTalkSearchParams,
  type DingTalkSearchResult,
  type DingTalkSendParams,
  type DingTalkSendResult,
  type DingTalkSettings,
  type DingTalkSettingsSetParams,
  type DingTalkStatus,
} from "@codexhost/shared-contracts";

import {
  createDingTalkCli,
  type DingTalkCli,
  type DingTalkGroupMeta,
  type DingTalkPerson,
  type DwsEventRecord,
  type DwsSpawn,
} from "./dingtalk-cli.js";
import {
  readDingTalkSettings,
  resolveDingTalkHost,
  DingTalkSettingsStore,
} from "./dingtalk-settings.js";
import {
  expandDingTalkMentions,
  type DingTalkMentionResolver,
} from "./dingtalk-mention-rewrite.js";
import { createDingTalkTransport, type DingTalkTransport } from "./dingtalk-transport.js";
import { DingTalkViewedStore } from "./dingtalk-viewed.js";
import { DingTalkEventListener } from "./dingtalk-listener.js";
import type { PeerSpawn } from "./peer-transport.js";

const LIST_TTL_MS = 30_000;
const RECENT_TTL_MS = 120_000;
const MESSAGES_TTL_MS = 60_000;
const PREVIEW_TTL_MS = 60_000;
const GROUP_META_TTL_MS = 10 * 60_000;
const AT_ME_TTL_MS = 2 * 60_000;
const VIEWED_WRITE_DELAY_MS = 500;
const NOTIFY_DELAY_MS = 250;
const RECENT_LIMIT = 10;
const UNREAD_LIMIT = 50;
const SEARCH_WINDOW_DAYS = 30;
const RECENT_WINDOW_DAYS = 90;
const GROUP_META_LIMIT = 200;

export type DingTalkConversationView = "unread" | "recent";

export class DingTalkServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DingTalkServiceError";
  }
}

export interface DingTalkServiceOptions {
  environment?: NodeJS.ProcessEnv;
  /** Kept for callers that construct both Host roles; DingTalk settings stay local. */
  isLocalHost: boolean;
  cli?: DingTalkCli;
  transport?: DingTalkTransport;
  settings?: DingTalkSettingsStore;
  viewed?: DingTalkViewedStore;
  now?: () => number;
  onChange?(event: { conversationId: string | null }): void;
  spawnImpl?: DwsSpawn;
  peerSpawnImpl?: PeerSpawn;
}

interface ConversationCache {
  source: "unread" | "recent" | "empty";
  rows: DingTalkConversation[];
  fetchedAt: number;
  errorCode: string | null;
}

interface MessageCache {
  messages: DingTalkMessage[];
  hasMore: boolean;
  nextCursor: number | null;
  fetchedAt: number;
}

interface PreviewCache {
  preview: string | null;
  fetchedAt: number;
}

function previewOf(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 119)}…` : normalized;
}

/** One-line list summary for the newest message, including its sender. */
export function dingtalkMessageSummary(message: DingTalkMessage): string {
  const image = message.resources?.find(({ kind }) => kind === "image");
  if (image) return "[图片]";
  const file = message.resources?.find(({ kind }) => kind === "file");
  if (file) return file.name ? `[文件] ${file.name}` : "[文件]";
  if (message.cardTitle) return message.cardTitle;
  if (message.text.trim()) return previewOf(message.text);
  if (message.unsupported) return "[非文本消息]";
  return "";
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export class DingTalkService {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #isLocalHost: boolean;
  readonly #settings: DingTalkSettingsStore;
  readonly #viewed: DingTalkViewedStore;
  readonly #transport: DingTalkTransport;
  readonly #cli: DingTalkCli;
  readonly #now: () => number;
  readonly #onChange: ((event: { conversationId: string | null }) => void) | undefined;
  readonly #conversations = new Map<string, DingTalkConversation>();
  readonly #messages = new Map<string, MessageCache>();
  readonly #previews = new Map<string, PreviewCache>();
  readonly #viewedAt = new Map<string, number>();
  #viewedLoaded = false;
  #viewedWriteTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #lists: Record<DingTalkConversationView, ConversationCache | null> = {
    unread: null,
    recent: null,
  };
  readonly #refreshing = new Map<DingTalkConversationView, Promise<void>>();
  readonly #refreshQueued = new Set<DingTalkConversationView>();
  #groupMeta: Map<string, DingTalkGroupMeta> | null = null;
  #groupMetaAt = 0;
  #atMe = new Map<string, number>();
  #atMeAt = 0;
  #ready: Promise<void> | null = null;
  #lastAuth: Awaited<ReturnType<DingTalkCli["authStatus"]>> | null = null;
  readonly #events: DingTalkEventListener;
  #notifyTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: DingTalkServiceOptions) {
    this.#environment = options.environment ?? process.env;
    this.#isLocalHost = options.isLocalHost;
    this.#now = options.now ?? Date.now;
    this.#settings =
      options.settings ?? new DingTalkSettingsStore({ environment: this.#environment });
    this.#viewed = options.viewed ?? new DingTalkViewedStore(this.#environment);
    this.#transport =
      options.transport ??
      createDingTalkTransport({
        environment: this.#environment,
        settings: this.#settings,
        ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
        ...(options.peerSpawnImpl ? { peerSpawnImpl: options.peerSpawnImpl } : {}),
      });
    this.#cli =
      options.cli ??
      createDingTalkCli({
        environment: this.#environment,
        runImpl: (args, timeoutMs) => this.#transport.run(args, timeoutMs),
        ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
      });
    this.#onChange = options.onChange;
    this.#events = new DingTalkEventListener({
      cli: this.#cli,
      local: () => this.#transport.local,
      authenticate: async () => {
        const auth = this.#lastAuth ?? (await this.#cli.authStatus().catch(() => null));
        this.#lastAuth = auth;
        return auth?.installed === true && auth.authenticated;
      },
      onRecord: (record) => this.#onEvent(record),
      now: this.#now,
    });
  }

  get isLocalHost(): boolean {
    return this.#isLocalHost;
  }

  #ensure(): Promise<void> {
    this.#ready ??= (async () => {
      await this.#transport.refresh().catch(() => undefined);
      if (!this.#viewedLoaded) {
        this.#viewedLoaded = true;
        for (const [conversationId, value] of await this.#viewed.read()) {
          this.#viewedAt.set(conversationId, value);
        }
      }
    })();
    return this.#ready;
  }

  #requireLocal(capability = "this"): void {
    if (!this.#isLocalHost) {
      throw new DingTalkServiceError("local_only", `DingTalk ${capability} is local-only`);
    }
  }

  async status(): Promise<DingTalkStatus> {
    await this.#ensure();
    const auth = await this.#cli.authStatus();
    this.#lastAuth = auth;
    const resolved = await resolveDingTalkHost(this.#environment, await this.#settings.read());
    return dingtalkStatusSchema.parse({
      installed: auth.installed,
      authenticated: auth.authenticated,
      userName: auth.userName,
      userId: auth.userId,
      corpName: auth.corpName,
      defaultHost: resolved.name,
      defaultHostId: resolved.hostId,
      errorCode: auth.errorCode,
    });
  }

  async settings(): Promise<DingTalkSettings> {
    this.#requireLocal("settings");
    await this.#ensure();
    return dingtalkSettingsSchema.parse(
      await readDingTalkSettings(this.#environment, this.#settings),
    );
  }

  async updateSettings(params: DingTalkSettingsSetParams): Promise<DingTalkSettings> {
    this.#requireLocal("settings");
    await this.#ensure();
    const current = await readDingTalkSettings(this.#environment, this.#settings);
    const value = params.defaultHost?.trim() || null;
    if (
      value !== null &&
      !current.hosts.some((host) => host.name === value || host.hostId === value)
    ) {
      throw new DingTalkServiceError("unknown_host", `DingTalk Host '${value}' is not configured`);
    }
    await this.#settings.write(value);
    await this.#transport.refresh();
    this.#lists.unread = null;
    this.#lists.recent = null;
    this.#conversations.clear();
    this.#messages.clear();
    this.#previews.clear();
    this.#groupMeta = null;
    this.#groupMetaAt = 0;
    this.#atMe = new Map();
    this.#atMeAt = 0;
    return dingtalkSettingsSchema.parse(
      await readDingTalkSettings(this.#environment, this.#settings),
    );
  }

  async conversations(
    params: DingTalkConversationsParams = {},
  ): Promise<DingTalkConversationsResult> {
    await this.#ensure();
    this.#events.touch();
    const view = params.view ?? "unread";
    const cache = this.#lists[view];
    if (!cache || params.refresh === true) {
      await this.#refresh(view);
    } else {
      const ttl = view === "unread" ? LIST_TTL_MS : RECENT_TTL_MS;
      if (this.#now() - cache.fetchedAt >= ttl) {
        void this.#refresh(view).catch(() => undefined);
      }
    }
    const list = this.#lists[view];
    return dingtalkConversationsResultSchema.parse({
      available: list !== null && list.errorCode === null,
      source: list?.source ?? "empty",
      conversations: list?.rows ?? [],
      cachedAt: list?.fetchedAt ?? null,
      refreshing: this.#refreshing.has(view),
      errorCode: list?.errorCode ?? null,
    });
  }

  /** Newest-message summary for one visible row. */
  async preview(conversationId: string): Promise<DingTalkPreviewResult> {
    await this.#ensure();
    const cached = this.#previews.get(conversationId);
    if (cached && this.#now() - cached.fetchedAt < PREVIEW_TTL_MS) {
      return dingtalkPreviewResultSchema.parse({
        available: true,
        preview: cached.preview,
        cachedAt: cached.fetchedAt,
        errorCode: null,
      });
    }
    const page = await this.#cli.messages({ conversationId, limit: 1 }).catch(() => null);
    const newest = page?.messages[0];
    const preview = newest
      ? `${newest.mine ? "我" : newest.senderName}：${dingtalkMessageSummary(newest)}`
      : null;
    const entry = { preview, fetchedAt: this.#now() };
    this.#previews.set(conversationId, entry);
    return dingtalkPreviewResultSchema.parse({
      available: page?.errorCode === null,
      preview,
      cachedAt: entry.fetchedAt,
      errorCode: page?.errorCode ?? null,
    });
  }

  async messages(params: DingTalkMessagesParams): Promise<DingTalkMessagesResult> {
    await this.#ensure();
    this.#events.touch();
    const conversationId = params.conversationId;
    const limit = params.limit ?? 40;
    let cache = this.#messages.get(conversationId);
    if (!params.before && cache && this.#now() - cache.fetchedAt < MESSAGES_TTL_MS) {
      return await this.#messagesResult(conversationId, cache);
    }
    const page = await this.#cli.messages({
      conversationId,
      limit,
      ...(params.before !== undefined
        ? { before: params.before, direction: "older" as const }
        : {}),
    });
    if (page.errorCode !== null) {
      return dingtalkMessagesResultSchema.parse({
        available: false,
        conversation: await this.#conversationFor(conversationId),
        messages: cache?.messages ?? [],
        hasMore: cache?.hasMore ?? false,
        nextCursor: cache?.nextCursor ?? null,
        cachedAt: cache?.fetchedAt ?? null,
        errorCode: page.errorCode,
      });
    }
    if (!params.before) {
      cache = {
        messages: page.messages,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        fetchedAt: this.#now(),
      };
      this.#messages.set(conversationId, cache);
      this.#previews.delete(conversationId);
      return await this.#messagesResult(conversationId, cache);
    }
    const merged = new Map<string, DingTalkMessage>();
    for (const message of [...(cache?.messages ?? []), ...page.messages]) {
      merged.set(message.messageId, message);
    }
    cache = {
      messages: [...merged.values()].sort((left, right) => right.createdAt - left.createdAt),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      fetchedAt: cache?.fetchedAt ?? this.#now(),
    };
    this.#messages.set(conversationId, cache);
    return await this.#messagesResult(conversationId, cache);
  }

  async resource(params: DingTalkResourceParams): Promise<DingTalkResourceResult> {
    await this.#ensure();
    const media = await this.#transport.readMedia({
      conversationId: params.conversationId,
      messageId: params.messageId,
      resourceId: params.resourceId,
      resourceIdType: params.resourceIdType,
    });
    const renderable = media.ok && media.mimeType?.startsWith("image/") === true;
    return dingtalkResourceResultSchema.parse({
      available: renderable,
      dataUrl:
        renderable && media.base64 && media.mimeType
          ? `data:${media.mimeType};base64,${media.base64}`
          : null,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      errorCode: renderable ? media.errorCode : (media.errorCode ?? "unsupported_media"),
    });
  }

  async send(params: DingTalkSendParams): Promise<DingTalkSendResult> {
    await this.#ensure();
    const result = await this.#cli.send(params.conversationId, params.text);
    if (result.ok) {
      const sentAt = this.#now();
      const cached = this.#messages.get(params.conversationId);
      if (cached) {
        cached.messages = [
          {
            messageId: `codexhost-${sentAt}`,
            conversationId: params.conversationId,
            senderName: "我",
            createdAt: sentAt,
            text: params.text,
            unsupported: false,
            mine: true,
          },
          ...cached.messages,
        ];
      }
      const conversation = this.#conversations.get(params.conversationId);
      if (conversation) {
        conversation.lastMessageAt = sentAt;
        conversation.preview = `我：${previewOf(params.text)}`;
      }
      for (const view of ["unread", "recent"] as const) {
        const list = this.#lists[view];
        if (!list) continue;
        list.rows = list.rows.map((row) =>
          row.conversationId === params.conversationId
            ? { ...row, lastMessageAt: sentAt, preview: `我：${previewOf(params.text)}` }
            : row,
        );
      }
      this.#previews.delete(params.conversationId);
      this.#notify(params.conversationId);
    }
    return dingtalkSendResultSchema.parse({
      ok: result.ok,
      messageId: null,
      sentAt: this.#now(),
      errorCode: result.errorCode,
    });
  }

  async markViewed(conversationId: string, lastMessageAt: number): Promise<Record<string, never>> {
    await this.#ensure();
    const previous = this.#viewedAt.get(conversationId) ?? 0;
    if (lastMessageAt > previous) {
      this.#viewedAt.set(conversationId, lastMessageAt);
      this.#scheduleViewedWrite();
    }
    const list = this.#lists.unread;
    if (list?.source === "unread") {
      const rows = list.rows.filter(
        (conversation) =>
          conversation.conversationId !== conversationId ||
          (conversation.lastMessageAt ?? 0) > lastMessageAt,
      );
      if (rows.length !== list.rows.length) {
        this.#lists.unread = { ...list, rows };
        if (rows.length === 0) void this.#refresh("unread").catch(() => undefined);
        this.#notify(conversationId);
      }
    }
    return {};
  }

  /**
   * Plain keyword search. Local list matches come first, then groups, people
   * and message hits from dws; conversations are de-duplicated by id.
   */
  async search(params: DingTalkSearchParams): Promise<DingTalkSearchResult> {
    await this.#ensure();
    this.#events.touch();
    if (!this.#lists.unread) await this.#refresh("unread");
    const query = params.query.trim();
    const needle = query.toLowerCase();
    const local: DingTalkConversation[] = [];
    const localSeen = new Set<string>();
    for (const view of ["unread", "recent"] as const) {
      for (const row of this.#lists[view]?.rows ?? []) {
        if (localSeen.has(row.conversationId)) continue;
        if (
          !row.title.toLowerCase().includes(needle) &&
          !(row.preview ?? "").toLowerCase().includes(needle)
        ) {
          continue;
        }
        localSeen.add(row.conversationId);
        local.push(row);
      }
    }
    const [groups, people, messages] = await Promise.all([
      this.#cli.searchGroups(query).catch(() => ({
        conversations: [],
        errorCode: "cli_failed",
      })),
      this.#cli.searchPeople(query).catch(() => ({ people: [], errorCode: "cli_failed" })),
      this.#cli
        .searchMessages({ query, days: SEARCH_WINDOW_DAYS, limit: 30 })
        .catch(() => ({ messages: [], errorCode: "cli_failed" })),
    ]);
    const personConversations = await mapLimit(people.people.slice(0, 6), 3, async (person) =>
      this.#personConversation(person),
    );
    const messageIds = [...new Set(messages.messages.map(({ conversationId }) => conversationId))];
    const messageConversations = await mapLimit(messageIds.slice(0, 8), 3, (conversationId) =>
      this.#conversationFor(conversationId),
    );
    const conversations: DingTalkConversation[] = [];
    const seen = new Set<string>();
    const push = (row: DingTalkConversation | null): void => {
      if (!row || seen.has(row.conversationId) || conversations.length >= 20) return;
      seen.add(row.conversationId);
      conversations.push(row);
      this.#conversations.set(row.conversationId, { ...row });
    };
    for (const row of local) push(row);
    for (const row of groups.conversations) push(row);
    for (const row of personConversations) push(row);
    for (const row of messageConversations) push(row);
    const available =
      local.length > 0 ||
      groups.errorCode === null ||
      people.errorCode === null ||
      messages.errorCode === null;
    return dingtalkSearchResultSchema.parse({
      available,
      conversations,
      messages: messages.messages.slice(0, 50),
      errorCode: groups.errorCode ?? people.errorCode ?? messages.errorCode,
    });
  }

  async resolve(mention: DingTalkMention): Promise<DingTalkResolveResult> {
    await this.#ensure();
    this.#events.touch();
    const conversation = await this.#conversationFor(mention.conversationId);
    const latest = await this.messages({ conversationId: mention.conversationId, limit: 100 });
    let available = latest.available;
    let errorCode = latest.errorCode;
    let all = latest.messages;
    if (
      mention.kind === "messages" &&
      mention.messageIds.some((id) => !all.some((message) => message.messageId === id))
    ) {
      const scrollback = await this.#cli.messages({
        conversationId: mention.conversationId,
        limit: 100,
        pageAll: true,
        maxItems: 300,
      });
      if (scrollback.messages.length > 0) all = scrollback.messages;
      available = scrollback.errorCode === null;
      errorCode = scrollback.errorCode;
    }
    if (!available && all.length === 0) {
      return dingtalkResolveResultSchema.parse({
        available: false,
        conversation,
        messages: [],
        errorCode,
      });
    }
    const ordered = all.slice().sort((left, right) => left.createdAt - right.createdAt);
    let selected = ordered;
    if (mention.kind === "messages" && mention.messageIds.length > 0) {
      const wanted = new Set(mention.messageIds);
      const indexes = ordered.flatMap((message, index) =>
        wanted.has(message.messageId) ? [index] : [],
      );
      const keep = new Set<number>();
      for (const index of indexes) {
        for (let offset = -3; offset <= 3; offset += 1) {
          const target = index + offset;
          if (target >= 0 && target < ordered.length) keep.add(target);
        }
      }
      selected = ordered.filter((_message, index) => keep.has(index));
      if (selected.length === 0) selected = ordered.slice(-10);
    } else if (mention.kind === "conversation") {
      selected = ordered.slice(-30);
    }
    return dingtalkResolveResultSchema.parse({
      available: true,
      conversation,
      messages: selected.slice(-100),
      errorCode: null,
    });
  }

  /** Submission-time expansion; a failed read never blocks the Turn. */
  async expandMentions(text: string): Promise<string> {
    const resolver: DingTalkMentionResolver = { resolve: (mention) => this.resolve(mention) };
    return (await expandDingTalkMentions(text, resolver)).text;
  }

  setNotifier(notifier: (event: { conversationId: string | null }) => void): void {
    this.#notifier = notifier;
  }

  #notifier: ((event: { conversationId: string | null }) => void) | null = null;

  async #personConversation(person: DingTalkPerson): Promise<DingTalkConversation | null> {
    const known = [...this.#conversations.values()].find(
      (row) => row.singleChat && row.title === person.name,
    );
    if (known) {
      known.subtitle = person.title || known.subtitle;
      return known;
    }
    const info = await this.#cli.conversationInfoForUser(person.openDingTalkId);
    if (!info) return null;
    const row: DingTalkConversation = {
      ...info,
      title: info.title || person.name,
      singleChat: true,
      subtitle: person.title || null,
      memberCount: info.memberCount ?? 2,
    };
    this.#conversations.set(row.conversationId, row);
    return row;
  }

  async #conversationFor(conversationId: string): Promise<DingTalkConversation | null> {
    const cached =
      this.#conversations.get(conversationId) ??
      this.#lists.unread?.rows.find(
        (conversation) => conversation.conversationId === conversationId,
      ) ??
      this.#lists.recent?.rows.find(
        (conversation) => conversation.conversationId === conversationId,
      ) ??
      null;
    // A group row is complete once it carries a member count; a direct chat
    // also needs the person's job title for the header subtitle.
    if (
      cached &&
      (cached.singleChat ? cached.subtitle !== undefined : cached.memberCount !== undefined)
    ) {
      return cached;
    }
    const info = await this.#cli.conversationInfo(conversationId);
    if (!info) return cached;
    const meta = this.#groupMeta?.get(conversationId);
    const enriched: DingTalkConversation = {
      ...info,
      ...(cached
        ? {
            unreadCount: cached.unreadCount,
            lastMessageAt: cached.lastMessageAt ?? info.lastMessageAt,
            muted: cached.muted,
            ...(cached.preview ? { preview: cached.preview } : {}),
            ...(cached.atMe ? { atMe: true } : {}),
          }
        : {}),
      ...(meta
        ? {
            groupType: info.groupType ?? meta.groupType,
            memberCount: info.memberCount ?? meta.memberCount,
          }
        : {}),
    };
    if (enriched.singleChat) {
      enriched.subtitle = await this.#personSubtitle(enriched.title);
    }
    this.#conversations.set(conversationId, enriched);
    return enriched;
  }

  async #personSubtitle(name: string): Promise<string | null> {
    if (!name) return null;
    const result = await this.#cli.searchPeople(name).catch(() => null);
    const person = result?.people.find((row) => row.name === name) ?? result?.people[0];
    return person?.title || null;
  }

  async #messagesResult(
    conversationId: string,
    cache: MessageCache,
  ): Promise<DingTalkMessagesResult> {
    return dingtalkMessagesResultSchema.parse({
      available: true,
      conversation: await this.#conversationFor(conversationId),
      messages: cache.messages,
      hasMore: cache.hasMore,
      nextCursor: cache.nextCursor,
      cachedAt: cache.fetchedAt,
      errorCode: null,
    });
  }

  #refresh(view: DingTalkConversationView): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const active = this.#refreshing.get(view);
    if (active) {
      this.#refreshQueued.add(view);
      return active;
    }
    const promise = this.#runRefresh(view).finally(() => {
      if (this.#refreshing.get(view) !== promise) return;
      this.#refreshing.delete(view);
      if (this.#refreshQueued.delete(view)) {
        void this.#refresh(view).catch(() => undefined);
      }
    });
    this.#refreshing.set(view, promise);
    return promise;
  }

  async #runRefresh(view: DingTalkConversationView): Promise<void> {
    try {
      const auth = await this.#cli.authStatus().catch(() => null);
      if (auth) this.#lastAuth = auth;
      if (!auth?.installed || !auth.authenticated) {
        this.#lists[view] = {
          source: "empty",
          rows: [],
          fetchedAt: this.#now(),
          errorCode: auth?.errorCode ?? "not_installed",
        };
        return;
      }
      if (view === "recent") {
        await this.#loadGroupMeta();
        const rows = await this.#recentConversations(auth.userId);
        this.#lists.recent = {
          source: rows.length > 0 ? "recent" : "empty",
          rows,
          fetchedAt: this.#now(),
          errorCode: null,
        };
        return;
      }
      await this.#loadGroupMeta();
      const [unread, atMe] = await Promise.all([
        this.#cli.unreadConversations(UNREAD_LIMIT),
        this.#loadAtMe(),
      ]);
      void atMe;
      if (unread.errorCode !== null) {
        this.#lists.unread = {
          source: this.#lists.unread?.source === "unread" ? "unread" : "empty",
          rows: this.#lists.unread?.rows ?? [],
          fetchedAt: this.#now(),
          errorCode: unread.errorCode,
        };
        return;
      }
      for (const conversation of unread.conversations) {
        this.#conversations.set(conversation.conversationId, this.#withMeta(conversation));
      }
      const rows = unread.conversations
        .filter(
          (conversation) =>
            (conversation.lastMessageAt ?? 0) >
            (this.#viewedAt.get(conversation.conversationId) ?? 0),
        )
        .map((conversation) => this.#withMeta(conversation))
        .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
        .slice(0, UNREAD_LIMIT);
      this.#lists.unread = {
        source: rows.length > 0 ? "unread" : "empty",
        rows,
        fetchedAt: this.#now(),
        errorCode: null,
      };
    } catch {
      this.#lists[view] = {
        source: this.#lists[view]?.source ?? "empty",
        rows: this.#lists[view]?.rows ?? [],
        fetchedAt: this.#now(),
        errorCode: "dws_failed",
      };
    }
  }

  #withMeta(conversation: DingTalkConversation): DingTalkConversation {
    const meta = this.#groupMeta?.get(conversation.conversationId);
    const atMeAt = this.#atMe.get(conversation.conversationId);
    const viewedAt = this.#viewedAt.get(conversation.conversationId) ?? 0;
    return {
      ...conversation,
      ...(meta
        ? {
            groupType: conversation.groupType ?? meta.groupType,
            memberCount: conversation.memberCount ?? meta.memberCount,
          }
        : {}),
      ...(atMeAt !== undefined && atMeAt > viewedAt ? { atMe: true } : {}),
    };
  }

  async #loadGroupMeta(): Promise<void> {
    if (this.#groupMeta && this.#now() - this.#groupMetaAt < GROUP_META_TTL_MS) return;
    const result = await this.#cli.groupDirectory().catch(() => null);
    if (result?.directory) {
      this.#groupMeta = result.directory;
      this.#groupMetaAt = this.#now();
    }
  }

  async #loadAtMe(): Promise<void> {
    if (this.#now() - this.#atMeAt < AT_ME_TTL_MS) return;
    const result = await this.#cli.atMeHits(7, 50).catch(() => null);
    if (!result || result.errorCode !== null) {
      this.#atMeAt = this.#now();
      return;
    }
    const next = new Map<string, number>();
    for (const hit of result?.hits ?? []) {
      if (hit.createdAt === null) continue;
      next.set(hit.conversationId, Math.max(next.get(hit.conversationId) ?? 0, hit.createdAt));
    }
    this.#atMe = next;
    this.#atMeAt = this.#now();
  }

  async #recentConversations(userId: string | null): Promise<DingTalkConversation[]> {
    if (!userId) return [];
    const sent = await this.#cli.searchMessages({
      senderIds: [userId],
      days: RECENT_WINDOW_DAYS,
      limit: 100,
    });
    const latest = new Map<string, DingTalkMessage>();
    for (const message of sent.messages) {
      const existing = latest.get(message.conversationId);
      if (!existing || message.createdAt > existing.createdAt) {
        latest.set(message.conversationId, message);
      }
    }
    const rows = [...latest.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, RECENT_LIMIT);
    const conversations = await mapLimit<DingTalkMessage, DingTalkConversation | null>(
      rows,
      4,
      async (message) => {
        const known =
          this.#conversations.get(message.conversationId) ??
          (await this.#conversationFor(message.conversationId));
        if (!known) return null;
        return {
          ...this.#withMeta(known),
          unreadCount: 0,
          lastMessageAt: message.createdAt,
          preview: `我：${dingtalkMessageSummary(message)}`,
        };
      },
    );
    return conversations.filter((row): row is DingTalkConversation => row !== null);
  }

  #onEvent(record: DwsEventRecord): void {
    if (this.#disposed) return;
    const list = this.#lists.unread;
    if (list?.source === "unread") {
      const previous = list.rows.find(
        (conversation) => conversation.conversationId === record.conversationId,
      );
      const known = previous ??
        this.#conversations.get(record.conversationId) ?? {
          conversationId: record.conversationId,
          title: "",
          singleChat: false,
          unreadCount: 0,
          lastMessageAt: null,
          muted: false,
        };
      const updated: DingTalkConversation = {
        ...known,
        unreadCount: known.unreadCount + 1,
        lastMessageAt: Math.max(known.lastMessageAt ?? 0, record.createdAt),
        preview: previewOf(record.text),
      };
      const rows = [
        updated,
        ...list.rows.filter((row) => row.conversationId !== record.conversationId),
      ].sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0));
      this.#lists.unread = { ...list, rows: rows.slice(0, UNREAD_LIMIT) };
    } else {
      void this.#refresh("unread").catch(() => undefined);
    }
    this.#previews.delete(record.conversationId);
    this.#messages.delete(record.conversationId);
    if (!this.#conversations.get(record.conversationId)?.title) {
      void this.#conversationFor(record.conversationId).catch(() => undefined);
    }
    this.#notify(record.conversationId);
  }

  #scheduleViewedWrite(): void {
    if (this.#viewedWriteTimer) clearTimeout(this.#viewedWriteTimer);
    this.#viewedWriteTimer = setTimeout(() => {
      this.#viewedWriteTimer = null;
      void this.#viewed.write(this.#viewedAt).catch(() => undefined);
    }, VIEWED_WRITE_DELAY_MS);
    this.#viewedWriteTimer.unref?.();
  }

  #notify(conversationId: string | null): void {
    if (this.#notifyTimer) return;
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = null;
      const event = { conversationId };
      try {
        this.#onChange?.(event);
      } catch {
        /* Renderer notification is best effort. */
      }
      try {
        this.#notifier?.(event);
      } catch {
        /* Renderer notification is best effort. */
      }
    }, NOTIFY_DELAY_MS);
    this.#notifyTimer.unref?.();
  }

  dispose(): void {
    this.#disposed = true;
    this.#events.dispose();
    if (this.#notifyTimer) clearTimeout(this.#notifyTimer);
    if (this.#viewedWriteTimer) clearTimeout(this.#viewedWriteTimer);
    void this.#viewed.write(this.#viewedAt).catch(() => undefined);
  }
}

export function createDingTalkService(options: DingTalkServiceOptions): DingTalkService {
  return new DingTalkService(options);
}
