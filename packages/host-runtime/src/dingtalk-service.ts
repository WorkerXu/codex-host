import {
  dingtalkConversationsResultSchema,
  dingtalkDecideResultSchema,
  dingtalkMessagesResultSchema,
  dingtalkResolveResultSchema,
  dingtalkSearchResultSchema,
  dingtalkSendResultSchema,
  dingtalkSettingsSchema,
  dingtalkStatusSchema,
  type DingTalkConversation,
  type DingTalkConversationsResult,
  type DingTalkDecideParams,
  type DingTalkDecideResult,
  type DingTalkMessage,
  type DingTalkMessagesParams,
  type DingTalkMessagesResult,
  type DingTalkMention,
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
  type DwsEventRecord,
  type DwsSpawn,
} from "./dingtalk-cli.js";
import {
  createDingTalkDecisions,
  dingtalkMessageKeyword,
  type DingTalkDecisions,
} from "./dingtalk-decisions.js";
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
import { JarvisSettingsStore } from "./jarvis-settings.js";

const LIST_TTL_MS = 30_000;
const MESSAGES_TTL_MS = 60_000;
const VIEWED_WRITE_DELAY_MS = 500;
const NOTIFY_DELAY_MS = 250;
const RECENT_REPLIED_LIMIT = 10;
const FALLBACK_WINDOW_DAYS = 30;
const RECENT_REPLIED_WINDOW_DAYS = 90;

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
  /** Desktop-local Host owns the Gemini key and the default-Host setting. */
  isLocalHost: boolean;
  cli?: DingTalkCli;
  transport?: DingTalkTransport;
  settings?: DingTalkSettingsStore;
  decisions?: DingTalkDecisions;
  viewed?: DingTalkViewedStore;
  now?: () => number;
  onChange?(event: { conversationId: string | null }): void;
  spawnImpl?: DwsSpawn;
  peerSpawnImpl?: PeerSpawn;
}

interface ConversationCache {
  source: "unread" | "recent-replied" | "empty";
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

function previewOf(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 119)}…` : normalized;
}

export class DingTalkService {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #isLocalHost: boolean;
  readonly #settings: DingTalkSettingsStore;
  readonly #viewed: DingTalkViewedStore;
  readonly #decisions: DingTalkDecisions;
  readonly #transport: DingTalkTransport;
  readonly #cli: DingTalkCli;
  readonly #now: () => number;
  readonly #onChange: ((event: { conversationId: string | null }) => void) | undefined;
  readonly #listCache = new Map<string, { title: string; singleChat: boolean }>();
  readonly #messages = new Map<string, MessageCache>();
  readonly #viewedAt = new Map<string, number>();
  #viewedLoaded = false;
  #viewedWriteTimer: ReturnType<typeof setTimeout> | null = null;
  #list: ConversationCache | null = null;
  #refreshPromise: Promise<void> | null = null;
  #refreshQueued = false;
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
    this.#decisions =
      options.decisions ??
      createDingTalkDecisions({
        readApiKey: () => new JarvisSettingsStore({ environment: this.#environment }).readKey(),
      });
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
    this.#list = null;
    this.#messages.clear();
    this.#decisions.clear();
    return dingtalkSettingsSchema.parse(
      await readDingTalkSettings(this.#environment, this.#settings),
    );
  }

  async conversations(refresh = false): Promise<DingTalkConversationsResult> {
    await this.#ensure();
    this.#events.touch();
    if (!this.#list || refresh) {
      await this.#refreshConversations();
    } else if (this.#now() - this.#list.fetchedAt >= LIST_TTL_MS) {
      void this.#refreshConversations().catch(() => undefined);
    }
    const list = this.#list;
    return dingtalkConversationsResultSchema.parse({
      available: list !== null && list.errorCode === null,
      source: list?.source ?? "empty",
      conversations: list?.rows ?? [],
      cachedAt: list?.fetchedAt ?? null,
      refreshing: this.#refreshPromise !== null,
      errorCode: list?.errorCode ?? null,
    });
  }

  async messages(params: DingTalkMessagesParams): Promise<DingTalkMessagesResult> {
    await this.#ensure();
    this.#events.touch();
    const conversationId = params.conversationId;
    const limit = params.limit ?? 40;
    let cache = this.#messages.get(conversationId);
    if (!params.before && cache && this.#now() - cache.fetchedAt < MESSAGES_TTL_MS) {
      return this.#messagesResult(conversationId, cache);
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
      return this.#messagesResult(conversationId, cache);
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
    return this.#messagesResult(conversationId, cache);
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
      if (this.#list) {
        this.#list.rows = this.#list.rows.map((conversation) =>
          conversation.conversationId === params.conversationId
            ? { ...conversation, lastMessageAt: sentAt, preview: previewOf(params.text) }
            : conversation,
        );
      }
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
    if (this.#list?.source === "unread") {
      const rows = this.#list.rows.filter(
        (conversation) =>
          conversation.conversationId !== conversationId ||
          (conversation.lastMessageAt ?? 0) > lastMessageAt,
      );
      if (rows.length !== this.#list.rows.length) {
        this.#list = { ...this.#list, rows };
        if (rows.length === 0) void this.#refreshConversations().catch(() => undefined);
        this.#notify(conversationId);
      }
    }
    return {};
  }

  async decide(params: DingTalkDecideParams): Promise<DingTalkDecideResult> {
    this.#requireLocal("search decision");
    await this.#ensure();
    const keyword = dingtalkMessageKeyword(params.query);
    try {
      const decision = await this.#decisions.decide(
        params.query,
        params.conversations.map((conversation) => ({
          ...conversation,
          unreadCount: 0,
          muted: false,
        })),
      );
      return dingtalkDecideResultSchema.parse({
        available: decision.available,
        route: decision.route,
        messageQuery: decision.messageQuery,
        fromMe: decision.fromMe,
        atMe: decision.atMe,
        days: decision.days,
        conversationIds: decision.conversationIds,
        errorCode: decision.errorCode,
      });
    } catch {
      return dingtalkDecideResultSchema.parse({
        available: false,
        route: "messages",
        messageQuery: keyword,
        fromMe: false,
        atMe: false,
        days: FALLBACK_WINDOW_DAYS,
        conversationIds: [],
        errorCode: "decision_unavailable",
      });
    }
  }

  async search(params: DingTalkSearchParams): Promise<DingTalkSearchResult> {
    await this.#ensure();
    this.#events.touch();
    if (params.route === "conversations") {
      const ids = params.conversationIds ?? [];
      const conversations = (
        await Promise.all(ids.map((conversationId) => this.#conversationFor(conversationId)))
      ).filter((conversation): conversation is DingTalkConversation => conversation !== null);
      return dingtalkSearchResultSchema.parse({
        available: true,
        route: "conversations",
        conversations: conversations.slice(0, 8),
        messages: [],
        errorCode: null,
      });
    }
    const userId = this.#lastAuth?.userId ?? (await this.#cli.authStatus()).userId;
    const keyword = params.messageQuery?.trim() || params.query;
    const messages = await this.#cli.searchMessages({
      query: keyword,
      ...(params.fromMe && userId ? { senderIds: [userId] } : {}),
      atMe: params.atMe === true,
      days: params.days ?? FALLBACK_WINDOW_DAYS,
      limit: 30,
    });
    const ids = [...new Set(messages.messages.map(({ conversationId }) => conversationId))];
    const conversations = (
      await Promise.all(
        ids.slice(0, 8).map((conversationId) => this.#conversationFor(conversationId)),
      )
    ).filter((conversation): conversation is DingTalkConversation => conversation !== null);
    return dingtalkSearchResultSchema.parse({
      available: messages.errorCode === null,
      route: "messages",
      conversations,
      messages: messages.messages.slice(0, 50),
      errorCode: messages.errorCode,
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

  async #conversationFor(conversationId: string): Promise<DingTalkConversation | null> {
    const cached = this.#list?.rows.find((row) => row.conversationId === conversationId);
    if (cached) return cached;
    const known = this.#listCache.get(conversationId);
    if (known) {
      return {
        conversationId,
        title: known.title,
        singleChat: known.singleChat,
        unreadCount: 0,
        lastMessageAt: null,
        muted: false,
      };
    }
    const info = await this.#cli.conversationInfo(conversationId);
    if (!info) return null;
    this.#listCache.set(conversationId, { title: info.title, singleChat: info.singleChat });
    return info;
  }

  #messagesResult(conversationId: string, cache: MessageCache): DingTalkMessagesResult {
    const known = this.#list?.rows.find((row) => row.conversationId === conversationId);
    return dingtalkMessagesResultSchema.parse({
      available: true,
      conversation: known ?? null,
      messages: cache.messages,
      hasMore: cache.hasMore,
      nextCursor: cache.nextCursor,
      cachedAt: cache.fetchedAt,
      errorCode: null,
    });
  }

  #refreshConversations(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#refreshPromise) {
      this.#refreshQueued = true;
      return this.#refreshPromise;
    }
    const promise = this.#runRefresh().finally(() => {
      if (this.#refreshPromise !== promise) return;
      this.#refreshPromise = null;
      if (this.#refreshQueued) {
        this.#refreshQueued = false;
        void this.#refreshConversations().catch(() => undefined);
      }
    });
    this.#refreshPromise = promise;
    return promise;
  }

  async #runRefresh(): Promise<void> {
    try {
      const auth = await this.#cli.authStatus().catch(() => null);
      if (auth) this.#lastAuth = auth;
      if (!auth?.installed || !auth.authenticated) {
        this.#list = {
          source: "empty",
          rows: [],
          fetchedAt: this.#now(),
          errorCode: auth?.errorCode ?? "not_installed",
        };
        return;
      }
      const unread = await this.#cli.unreadConversations(50);
      if (unread.errorCode !== null) {
        this.#list = {
          source: this.#list?.source ?? "empty",
          rows: this.#list?.rows ?? [],
          fetchedAt: this.#now(),
          errorCode: unread.errorCode,
        };
        return;
      }
      for (const conversation of unread.conversations) {
        this.#listCache.set(conversation.conversationId, {
          title: conversation.title,
          singleChat: conversation.singleChat,
        });
      }
      const rows = unread.conversations.filter(
        (conversation) =>
          (conversation.lastMessageAt ?? 0) >
          (this.#viewedAt.get(conversation.conversationId) ?? 0),
      );
      if (rows.length > 0) {
        this.#list = {
          source: "unread",
          rows: rows
            .slice()
            .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
            .slice(0, 50),
          fetchedAt: this.#now(),
          errorCode: null,
        };
      } else {
        const replied = await this.#recentReplied(auth.userId);
        this.#list = {
          source: replied.length > 0 ? "recent-replied" : "empty",
          rows: replied,
          fetchedAt: this.#now(),
          errorCode: null,
        };
      }
    } catch {
      this.#list = {
        source: this.#list?.source ?? "empty",
        rows: this.#list?.rows ?? [],
        fetchedAt: this.#now(),
        errorCode: "dws_failed",
      };
    }
  }

  async #recentReplied(userId: string | null): Promise<DingTalkConversation[]> {
    if (!userId) return [];
    const sent = await this.#cli.searchMessages({
      senderIds: [userId],
      days: RECENT_REPLIED_WINDOW_DAYS,
      limit: 100,
    });
    const rows: DingTalkConversation[] = [];
    const seen = new Set<string>();
    for (const message of sent.messages) {
      if (seen.has(message.conversationId)) continue;
      seen.add(message.conversationId);
      const known = this.#listCache.get(message.conversationId);
      rows.push({
        conversationId: message.conversationId,
        title: known?.title ?? "",
        singleChat: known?.singleChat ?? false,
        unreadCount: 0,
        lastMessageAt: message.createdAt,
        muted: false,
        preview: previewOf(message.text),
      });
      if (rows.length >= RECENT_REPLIED_LIMIT) break;
    }
    await Promise.all(
      rows
        .filter((row) => !row.title)
        .map(async (row) => {
          const info = await this.#cli.conversationInfo(row.conversationId).catch(() => null);
          if (info) {
            row.title = info.title;
            row.singleChat = info.singleChat;
            this.#listCache.set(row.conversationId, {
              title: info.title,
              singleChat: info.singleChat,
            });
          }
        }),
    );
    return rows.map((row) => ({
      ...row,
      title: row.title || `钉钉会话 ${row.conversationId.slice(-6)}`,
    }));
  }

  #onEvent(record: DwsEventRecord): void {
    if (this.#disposed) return;
    const previous = this.#list?.rows.find(
      (conversation) => conversation.conversationId === record.conversationId,
    );
    const known = this.#listCache.get(record.conversationId);
    const conversation: DingTalkConversation = previous ?? {
      conversationId: record.conversationId,
      title: known?.title ?? "",
      singleChat: known?.singleChat ?? false,
      unreadCount: 0,
      lastMessageAt: null,
      muted: false,
    };
    const updated: DingTalkConversation = {
      ...conversation,
      unreadCount: conversation.unreadCount + 1,
      lastMessageAt: Math.max(conversation.lastMessageAt ?? 0, record.createdAt),
      preview: previewOf(record.text),
    };
    if (this.#list?.source === "unread") {
      const rows = [
        updated,
        ...this.#list.rows.filter((row) => row.conversationId !== record.conversationId),
      ].sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0));
      this.#list = { ...this.#list, rows: rows.slice(0, 50) };
    } else {
      void this.#refreshConversations().catch(() => undefined);
    }
    if (!updated.title) void this.#resolveEventTitle(record.conversationId);
    this.#notify(record.conversationId);
  }

  async #resolveEventTitle(conversationId: string): Promise<void> {
    const info = await this.#cli.conversationInfo(conversationId).catch(() => null);
    if (!info || this.#disposed) return;
    this.#listCache.set(conversationId, { title: info.title, singleChat: info.singleChat });
    if (this.#list?.source === "unread") {
      this.#list = {
        ...this.#list,
        rows: this.#list.rows.map((row) =>
          row.conversationId === conversationId
            ? { ...row, title: info.title, singleChat: info.singleChat }
            : row,
        ),
      };
      this.#notify(conversationId);
    }
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
