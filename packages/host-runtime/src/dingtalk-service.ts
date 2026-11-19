import {
  DINGTALK_LIVE_MESSAGE_LIMIT,
  DINGTALK_MAX_MEMBERS,
  DINGTALK_MAX_PREFETCH,
  dingtalkConversationsResultSchema,
  dingtalkDiagnosticsResultSchema,
  dingtalkMembersResultSchema,
  dingtalkMessagesResultSchema,
  dingtalkPrefetchResultSchema,
  dingtalkPreviewResultSchema,
  dingtalkResolveResultSchema,
  dingtalkResourceResultSchema,
  dingtalkSearchResultSchema,
  dingtalkSendResultSchema,
  dingtalkSettingsSchema,
  dingtalkStatusSchema,
  type DingTalkConversation,
  type DingTalkConversationsResult,
  type DingTalkDiagnosticsParams,
  type DingTalkDiagnosticsResult,
  type DingTalkMessage,
  type DingTalkMessagesParams,
  type DingTalkMessagesResult,
  type DingTalkMention,
  type DingTalkMembersResult,
  type DingTalkOpenTiming,
  type DingTalkPrefetchParams,
  type DingTalkPrefetchResult,
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
  type DingTalkTimingParams,
} from "@codexhost/shared-contracts";

import {
  createDingTalkCli,
  parseMessageBody,
  type DingTalkCardInput,
  type DingTalkCardUpdate,
  type DingTalkCardResult,
  type DingTalkCli,
  type DingTalkPendingApproval,
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
import { DingTalkLiveStore } from "./dingtalk-live-store.js";
import type { PeerSpawn } from "./peer-transport.js";

const VIEWED_WRITE_DELAY_MS = 500;
const NOTIFY_DELAY_MS = 250;
const UNREAD_LIMIT = 50;
const UNREAD_WINDOW_MS = 48 * 60 * 60_000;
const SEARCH_WINDOW_DAYS = 30;
const TIMING_LIMIT = 200;
const PREFETCH_MESSAGE_LIMIT = 20;
const RECONCILE_MESSAGE_LIMIT = DINGTALK_LIVE_MESSAGE_LIMIT;

import { readDingTalkConversationDetails } from "./dingtalk-conversation-details.js";

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

function previewOf(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 119)}…` : normalized;
}

function plainSnippet(text: string): string {
  return previewOf(
    text
      .replace(/^\s*(?:#{1,6}|>|[-*]|\d+\.)\s?/gmu, "")
      .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
      .replace(/\[([^\]\n]+)\]\([^)\n]+\)/gu, "$1"),
  );
}

/** One-line list summary for the newest message, including its sender. */
export function dingtalkMessageSummary(message: DingTalkMessage): string {
  const image = message.resources?.find(({ kind }) => kind === "image");
  if (image) return "[图片]";
  const file = message.resources?.find(({ kind }) => kind === "file");
  if (file) return file.name ? `[文件] ${file.name}` : "[文件]";
  if (message.cardTitle) return message.cardTitle;
  if (message.text.trim()) return plainSnippet(message.text);
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
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #viewedAt = new Map<string, number>();
  /** Only active view IDs are retained; conversation data belongs to the current page. */
  readonly #active = new Set<string>();
  #viewedLoaded = false;
  #viewedWriteTimer: ReturnType<typeof setTimeout> | null = null;
  #ready: Promise<void> | null = null;
  #lastAuth: Awaited<ReturnType<DingTalkCli["authStatus"]>> | null = null;
  readonly #events: DingTalkEventListener;
  #notifyTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingNotify = new Set<string | null>();
  readonly #eventListeners = new Set<(record: DwsEventRecord) => void>();
  readonly #seenEvents = new Set<string>();
  /** Memory only; never written to disk and dropped with the Host process. */
  readonly #live = new DingTalkLiveStore();
  readonly #timings: DingTalkOpenTiming[] = [];
  readonly #prefetchQueue = new Set<string>();
  readonly #prefetchPending = new Set<string>();
  #prefetchActive = 0;
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
        onIdentityResolved: () => {
          if (!this.#disposed) this.#notify(null);
        },
        runImpl: (args, timeoutMs) => this.#transport.run(args, timeoutMs),
        openEventsImpl: (input) => this.#transport.openEvents(input),
        ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
      });
    this.#onChange = options.onChange;
    this.#events = new DingTalkEventListener({
      cli: this.#cli,
      local: () => this.#transport.canListen,
      authenticate: async () => {
        const auth = await this.#cli.authStatus().catch(() => null);
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

  /** Keeps the dws stream alive while at least one agent listens. */
  setListeningHold(enabled: boolean): void {
    this.#events.setHold(enabled);
    if (enabled)
      void this.#ensure()
        .then(() => this.#events.touch())
        .catch(() => undefined);
  }

  /** Opens (or reopens) the event stream without waiting for a page read. */
  async startListening(): Promise<void> {
    await this.#ensure();
    this.#events.touch();
  }

  /** Dispatch runs on the Desktop Host; every raw IM event is delivered there. */
  subscribeEvents(listener: (record: DwsEventRecord) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
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

  async status(refresh = false): Promise<DingTalkStatus> {
    await this.#ensure();
    const auth = await this.#cli.authStatus(refresh);
    this.#lastAuth = auth;
    // A logout must never leave another account's rows readable.
    if (auth.installed && !auth.authenticated) this.#live.clear();
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
    // The new Host serves a different DingTalk login.
    this.#live.clear();
    this.#lastAuth = null;
    await this.#cli.authStatus(true);
    return dingtalkSettingsSchema.parse(
      await readDingTalkSettings(this.#environment, this.#settings),
    );
  }

  /**
   * The visible unread column. Once the live state has a list, rows come back
   * immediately and one background dws read reconciles them; only the first
   * open of a Host waits for dws.
   */
  async conversations(): Promise<DingTalkConversationsResult> {
    await this.#ensure();
    this.#events.touch();
    if (this.#live.hasList()) {
      const startedAt = this.#now();
      const timing = this.#recordOpen("conversations", null, true);
      this.#reconcileConversations(timing);
      const rows = this.#cachedConversations();
      timing.waitedMs = this.#now() - startedAt;
      return dingtalkConversationsResultSchema.parse({
        available: true,
        source: rows.length ? "unread" : "empty",
        conversations: rows,
        cachedAt: this.#live.listAt(),
        refreshing: true,
        errorCode: null,
      });
    }
    const startedAt = this.#now();
    const timing = this.#recordOpen("conversations", null, false);
    const unread = await this.#dedupe("live:unread", () => this.#readConversationsLive());
    timing.liveMs = this.#now() - startedAt;
    timing.waitedMs = timing.liveMs;
    timing.liveError = unread.errorCode;
    timing.storeBytes = this.#live.stats().storeBytes;
    const rows = unread.errorCode === null ? this.#cachedConversations() : [];
    return dingtalkConversationsResultSchema.parse({
      available: unread.errorCode === null,
      source: rows.length ? "unread" : "empty",
      conversations: rows,
      cachedAt: unread.errorCode === null ? this.#live.listAt() : null,
      refreshing: false,
      errorCode: unread.errorCode,
    });
  }

  async details(
    conversations: readonly DingTalkConversation[],
  ): Promise<{ conversations: DingTalkConversation[] }> {
    await this.#ensure();
    const rows = await readDingTalkConversationDetails(this.#cli, conversations);
    const resolved = rows.map((row) => ({
      ...row,
      atMe:
        row.atMe === true &&
        !this.#active.has(row.conversationId) &&
        (row.lastMessageAt ?? 0) > (this.#viewedAt.get(row.conversationId) ?? 0),
    }));
    this.#live.applyDetails(resolved);
    return { conversations: resolved };
  }

  /** Newest-message summary for one visible row. */
  async preview(conversationId: string): Promise<DingTalkPreviewResult> {
    await this.#ensure();
    return await this.#dedupe(`preview:${conversationId}`, async () => {
      const page = await this.#cli.messages({ conversationId, limit: 1 }).catch(() => null);
      const newest = page?.messages[0];
      const preview = newest
        ? `${newest.mine ? "我" : newest.senderName}：${dingtalkMessageSummary(newest)}`
        : null;
      return dingtalkPreviewResultSchema.parse({
        available: page?.errorCode === null,
        preview,
        cachedAt: null,
        errorCode: page?.errorCode ?? null,
      });
    });
  }

  async messages(params: DingTalkMessagesParams): Promise<DingTalkMessagesResult> {
    await this.#ensure();
    this.#events.touch();
    const { conversationId } = params;
    const limit = params.limit ?? 40;
    if (params.before === undefined) {
      const startedAt = this.#now();
      const snapshot = this.#live.messages(conversationId, limit, this.#now());
      if (snapshot) {
        const timing = this.#recordOpen("messages", conversationId, true);
        this.#reconcileMessages(conversationId, RECONCILE_MESSAGE_LIMIT, timing);
        const conversation =
          params.includeConversation === false ? null : this.#live.row(conversationId);
        timing.waitedMs = this.#now() - startedAt;
        return dingtalkMessagesResultSchema.parse({
          available: true,
          conversation,
          messages: snapshot.messages,
          hasMore: snapshot.hasMore,
          nextCursor: snapshot.nextCursor,
          cachedAt: snapshot.cachedAt,
          refreshing: true,
          errorCode: null,
        });
      }
    }
    const startedAt = this.#now();
    const timing = this.#recordOpen("messages", conversationId, false);
    const result = await this.#dedupe(
      `live:messages:${conversationId}:${params.before ?? "latest"}:${limit}:${params.includeConversation !== false}`,
      async () => {
        const [page, conversation] = await Promise.all([
          this.#readMessages(conversationId, limit, params.before),
          params.includeConversation === false
            ? Promise.resolve(null)
            : this.#cli.conversationInfo(conversationId).catch(() => null),
        ]);
        if (params.before === undefined && page.errorCode === null) {
          this.#storeMessages(conversationId, page);
        } else if (page.errorCode !== null) {
          this.#noteLiveError(page.errorCode);
        }
        return dingtalkMessagesResultSchema.parse({
          available: page.errorCode === null,
          conversation,
          messages: page.messages,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          cachedAt: page.errorCode === null ? this.#now() : null,
          refreshing: false,
          errorCode: page.errorCode,
        });
      },
    );
    timing.liveMs = this.#now() - startedAt;
    timing.waitedMs = timing.liveMs;
    timing.liveError = result.errorCode;
    timing.storeBytes = this.#live.stats().storeBytes;
    return result;
  }

  #readMessages(
    conversationId: string,
    limit: number,
    before?: number,
  ): Promise<Awaited<ReturnType<DingTalkCli["messages"]>>> {
    return this.#cli.messages({
      conversationId,
      limit,
      ...(before !== undefined ? { before, direction: "older" as const } : {}),
    });
  }

  /**
   * One message by id for manual dispatch. The live state answers for the
   * transcript the page is showing; an id outside that window is read from
   * dws, including a bounded scrollback, before giving up.
   */
  recordDispatch(
    message: DingTalkMessage,
    mark: NonNullable<DingTalkMessage["dispatchedAgents"]>[number],
  ): void {
    if (this.#disposed) return;
    this.#live.recordDispatch(message, mark, this.#now());
    this.#notify(message.conversationId);
  }

  async message(conversationId: string, messageId: string): Promise<DingTalkMessage | null> {
    await this.#ensure();
    const stored = this.#live.message(conversationId, messageId);
    if (stored) return stored;
    const page = await this.#readMessages(conversationId, 50).catch(() => null);
    const found = page?.messages.find((message) => message.messageId === messageId);
    if (found) {
      if (page?.errorCode === null) this.#storeMessages(conversationId, page);
      return found;
    }
    const scrollback = await this.#cli
      .messages({ conversationId, limit: 100, pageAll: true, maxItems: 300 })
      .catch(() => null);
    return scrollback?.messages.find((message) => message.messageId === messageId) ?? null;
  }

  /** Human members for the group composer's native `@` picker. */
  async members(conversationId: string): Promise<DingTalkMembersResult> {
    await this.#ensure();
    this.#events.touch();
    const startedAt = this.#now();
    const cached = this.#live.members(conversationId, this.#now());
    if (cached) {
      const timing = this.#recordOpen("members", conversationId, true);
      this.#reconcileMembers(conversationId, timing);
      timing.waitedMs = this.#now() - startedAt;
      return dingtalkMembersResultSchema.parse({
        available: true,
        members: cached.members,
        errorCode: null,
      });
    }
    const timing = this.#recordOpen("members", conversationId, false);
    const result = await this.#dedupe(`live:members:${conversationId}`, async () => {
      const live = await this.#cli.members(conversationId);
      if (live.errorCode === null) {
        this.#live.applyMembers(conversationId, live.members, this.#now());
      } else {
        this.#noteLiveError(live.errorCode);
      }
      return dingtalkMembersResultSchema.parse({
        available: live.errorCode === null,
        members: live.members.slice(0, DINGTALK_MAX_MEMBERS),
        errorCode: live.errorCode,
      });
    });
    timing.liveMs = this.#now() - startedAt;
    timing.waitedMs = timing.liveMs;
    timing.liveError = result.errorCode;
    timing.storeBytes = this.#live.stats().storeBytes;
    return result;
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
    const atIds = [...new Set(params.atOpenDingTalkIds ?? [])];
    for (const id of atIds) {
      if (!params.text.includes(`<@${id}>`)) {
        throw new DingTalkServiceError(
          "invalid_params",
          "DingTalk @ member placeholder is missing",
        );
      }
    }
    if (params.atAll === true && !params.text.includes("<@all>")) {
      throw new DingTalkServiceError("invalid_params", "DingTalk @all placeholder is missing");
    }
    const result = await this.#cli.send(params.conversationId, params.text, {
      ...(atIds.length > 0 ? { atOpenDingTalkIds: atIds } : {}),
      ...(params.atAll === true ? { atAll: true } : {}),
    });
    if (result.ok) {
      this.#notify(params.conversationId);
    }
    return dingtalkSendResultSchema.parse({
      ok: result.ok,
      messageId: result.messageId ?? null,
      sentAt: this.#now(),
      errorCode: result.errorCode,
    });
  }

  async sendDirect(
    openDingTalkId: string,
    text: string,
    options: { atOpenDingTalkIds?: readonly string[]; atAll?: boolean } = {},
  ): Promise<DingTalkSendResult> {
    await this.#ensure();
    const result = await this.#cli.sendDirect(openDingTalkId, text, options);
    return dingtalkSendResultSchema.parse({
      ok: result.ok,
      messageId: null,
      sentAt: this.#now(),
      errorCode: result.errorCode,
    });
  }

  async sendCard(input: DingTalkCardInput): Promise<DingTalkCardResult> {
    await this.#ensure();
    return await this.#cli.sendCard(input);
  }

  async updateCard(input: DingTalkCardUpdate): Promise<{ ok: boolean; errorCode: string | null }> {
    await this.#ensure();
    return await this.#cli.updateCard(input);
  }

  async pendingApprovals(limit = 20): Promise<{
    approvals: DingTalkPendingApproval[];
    errorCode: string | null;
  }> {
    await this.#ensure();
    return await this.#cli.pendingApprovals(limit);
  }

  /** Resolve the logged-in user by stable userId, never by name alone. */
  async selfOpenDingTalkId(): Promise<string | null> {
    await this.#ensure();
    const auth = this.#lastAuth ?? (await this.#cli.authStatus());
    if (!auth.userId || !auth.userName) return null;
    const result = await this.#cli.searchPeople(auth.userName);
    const matches = result.people.filter((person) => person.userId === auth.userId);
    return matches.length === 1 ? (matches[0]?.openDingTalkId ?? null) : null;
  }

  async markViewed(
    conversationId: string,
    lastMessageAt: number,
    active = true,
  ): Promise<Record<string, never>> {
    await this.#ensure();
    const previous = this.#viewedAt.get(conversationId) ?? 0;
    if (lastMessageAt > previous) {
      this.#viewedAt.set(conversationId, lastMessageAt);
      this.#scheduleViewedWrite();
    }
    const wasActive = this.#active.has(conversationId);
    if (active) this.#active.add(conversationId);
    else this.#active.delete(conversationId);
    if (wasActive !== active) this.#notify(conversationId);
    return {};
  }

  /**
   * Warms the newest transcript of rows the list is about to show, so the
   * first open of each is also instant. Bounded and deduplicated per chat.
   */
  async prefetch(params: DingTalkPrefetchParams): Promise<DingTalkPrefetchResult> {
    await this.#ensure();
    const ids = [...new Set(params.conversationIds)].slice(0, DINGTALK_MAX_PREFETCH);
    // Two dws reads at a time keep the Host responsive while every visible row
    // warms; the live-state byte cap evicts the least recently viewed payloads.
    const pending = ids.filter(
      (conversationId) =>
        !this.#prefetchPending.has(conversationId) &&
        !this.#inflight.has(`live:messages:${conversationId}`),
    );
    for (const id of pending) {
      this.#prefetchPending.add(id);
      this.#prefetchQueue.add(id);
    }
    this.#drainPrefetch();
    return dingtalkPrefetchResultSchema.parse({ started: pending.length });
  }

  #drainPrefetch(): void {
    while (!this.#disposed && this.#prefetchActive < 2 && this.#prefetchQueue.size > 0) {
      const id = this.#prefetchQueue.values().next().value;
      if (!id) break;
      this.#prefetchQueue.delete(id);
      this.#prefetchActive += 1;
      void this.#reconcileMessages(id, PREFETCH_MESSAGE_LIMIT).finally(() => {
        this.#prefetchActive -= 1;
        this.#prefetchPending.delete(id);
        this.#drainPrefetch();
      });
    }
  }

  /** Renderer paint timings share the bounded ring; no content is recorded. */
  async recordTiming(params: DingTalkTimingParams): Promise<Record<string, never>> {
    const timing: DingTalkOpenTiming = {
      at: this.#now(),
      kind: "paint",
      conversationId: params.conversationId,
      memoryHit: true,
      waitedMs: 0,
      liveMs: null,
      liveError: null,
      storeBytes: this.#live.stats().storeBytes,
      paintMs: params.paintMs,
      renderMs: params.renderMs,
      imagesMs: params.imagesMs,
    };
    this.#timings.push(timing);
    if (this.#timings.length > TIMING_LIMIT) {
      this.#timings.splice(0, this.#timings.length - TIMING_LIMIT);
    }
    return {};
  }

  /** Bounded open timings; ids and durations only, never message content. */
  async diagnostics(params: DingTalkDiagnosticsParams = {}): Promise<DingTalkDiagnosticsResult> {
    const limit = params.limit ?? 40;
    return dingtalkDiagnosticsResultSchema.parse({
      available: true,
      entries: this.#timings.slice(-limit).reverse(),
      ...this.#live.stats(),
    });
  }

  /**
   * Plain keyword search. Local list matches come first, then groups, people
   * and message hits from dws; conversations are de-duplicated by id.
   */
  async search(params: DingTalkSearchParams): Promise<DingTalkSearchResult> {
    await this.#ensure();
    this.#events.touch();
    const query = params.query.trim();
    const [list, groups, people, messages] = await Promise.all([
      this.conversations(),
      this.#cli.searchGroups(query).catch(() => ({
        conversations: [],
        errorCode: "cli_failed",
      })),
      this.#cli.searchPeople(query).catch(() => ({ people: [], errorCode: "cli_failed" })),
      this.#cli
        .searchMessages({ query, days: SEARCH_WINDOW_DAYS, limit: 30 })
        .catch(() => ({ messages: [], errorCode: "cli_failed" })),
    ]);
    const needle = query.toLowerCase();
    const local: DingTalkConversation[] = [];
    const localSeen = new Set<string>();
    for (const row of list.conversations) {
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
    const personConversations = await mapLimit(people.people.slice(0, 6), 3, async (person) =>
      this.#personConversation(person),
    );
    const messageIds = [...new Set(messages.messages.map(({ conversationId }) => conversationId))];
    const messageConversations = await mapLimit(messageIds.slice(0, 8), 3, (conversationId) =>
      this.#cli.conversationInfo(conversationId),
    );
    const conversations: DingTalkConversation[] = [];
    const seen = new Set<string>();
    const push = (row: DingTalkConversation | null): void => {
      if (!row || seen.has(row.conversationId) || conversations.length >= 20) return;
      seen.add(row.conversationId);
      conversations.push(row);
    };
    for (const row of local.filter((row) => row.singleChat)) push(row);
    for (const row of personConversations) push(row);
    for (const row of local.filter((row) => !row.singleChat)) push(row);
    for (const row of groups.conversations) push(row);
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
    const [conversation, latestPage] = await Promise.all([
      this.#cli.conversationInfo(mention.conversationId),
      this.#readMessages(mention.conversationId, 30),
    ]);
    let available = latestPage.errorCode === null;
    let errorCode = latestPage.errorCode;
    let all = latestPage.messages;
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

  /**
   * Every Host session that serves this page subscribes; one shared service can
   * outlive individual Desktop sessions, so a single notifier would send the
   * change to whichever session constructed last.
   */
  addNotifier(notifier: (event: { conversationId: string | null }) => void): () => void {
    this.#notifiers.add(notifier);
    return () => this.#notifiers.delete(notifier);
  }

  setNotifier(notifier: (event: { conversationId: string | null }) => void): void {
    this.#notifiers.clear();
    this.#notifiers.add(notifier);
  }

  readonly #notifiers = new Set<(event: { conversationId: string | null }) => void>();

  async #personConversation(person: DingTalkPerson): Promise<DingTalkConversation | null> {
    const info = await this.#cli.conversationInfoForUser(person.openDingTalkId);
    if (!info) return null;
    const row: DingTalkConversation = {
      ...info,
      title: info.title || person.name,
      singleChat: true,
      memberCount: info.memberCount ?? 2,
    };
    return row;
  }

  #dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const active = this.#inflight.get(key) as Promise<T> | undefined;
    if (active) return active;
    const promise = run().finally(() => {
      if (this.#inflight.get(key) === promise) this.#inflight.delete(key);
    });
    this.#inflight.set(key, promise);
    return promise;
  }

  #recordOpen(
    kind: DingTalkOpenTiming["kind"],
    conversationId: string | null,
    memoryHit: boolean,
  ): DingTalkOpenTiming {
    const timing: DingTalkOpenTiming = {
      at: this.#now(),
      kind,
      conversationId,
      memoryHit,
      waitedMs: 0,
      liveMs: null,
      liveError: null,
      storeBytes: this.#live.stats().storeBytes,
      paintMs: null,
      renderMs: null,
      imagesMs: null,
    };
    this.#timings.push(timing);
    if (this.#timings.length > TIMING_LIMIT) {
      this.#timings.splice(0, this.#timings.length - TIMING_LIMIT);
    }
    return timing;
  }

  /** Rows for the unread column, filtered against @ me and local view state. */
  #cachedConversations(): DingTalkConversation[] {
    const cutoff = this.#now() - UNREAD_WINDOW_MS;
    const rows: DingTalkConversation[] = [];
    for (const row of this.#live.rows()) {
      const active = this.#active.has(row.conversationId);
      const lastMessageAt = row.lastMessageAt ?? 0;
      const viewedAt = this.#viewedAt.get(row.conversationId) ?? 0;
      if (lastMessageAt < cutoff) continue;
      if (!active && !(row.unreadCount > 0 && lastMessageAt > viewedAt)) continue;
      rows.push({
        ...row,
        atMe: row.atMe === true && !active && lastMessageAt > viewedAt,
        ...(active ? { unreadCount: 0 } : {}),
      });
      if (rows.length >= UNREAD_LIMIT) break;
    }
    return rows;
  }

  async #readConversationsLive(): Promise<{
    errorCode: string | null;
    changed: boolean;
  }> {
    const unread = await this.#cli
      .unreadConversations(UNREAD_LIMIT)
      .catch(() => ({ conversations: [], errorCode: "dws_failed" }));
    if (unread.errorCode !== null) {
      this.#noteLiveError(unread.errorCode);
      return { errorCode: unread.errorCode, changed: false };
    }
    const changed = this.#live.applyConversations(unread.conversations, {
      now: this.#now(),
      keep: [...this.#active],
    });
    return { errorCode: null, changed };
  }

  /** A dead login must not leave the previous account's rows in memory. */
  #noteLiveError(errorCode: string | null): void {
    if (!errorCode) return;
    if (
      !/not[_ -]?logged|unauthenticated|unauthorized|login[_ -]?required|auth/iu.test(errorCode)
    ) {
      return;
    }
    this.#live.clear();
  }

  #reconcileConversations(timing: DingTalkOpenTiming): void {
    const key = "live:unread";
    if (this.#inflight.has(key)) return;
    const startedAt = this.#now();
    void this.#dedupe(key, () => this.#readConversationsLive())
      .then((result) => {
        timing.liveMs = this.#now() - startedAt;
        timing.liveError = result.errorCode;
        timing.storeBytes = this.#live.stats().storeBytes;
        if (result.changed && !this.#disposed) this.#notify(null);
      })
      .catch(() => {
        timing.liveMs = this.#now() - startedAt;
        timing.liveError = "dws_failed";
        timing.storeBytes = this.#live.stats().storeBytes;
      });
  }

  #storeMessages(
    conversationId: string,
    page: Awaited<ReturnType<DingTalkCli["messages"]>>,
  ): boolean {
    const newest = page.messages[0];
    return this.#live.applyMessages({
      conversationId,
      messages: page.messages,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      preview: newest ? this.#messagePreview(newest) : null,
      now: this.#now(),
    });
  }

  #messagePreview(message: DingTalkMessage): string {
    return `${message.mine ? "我" : message.senderName}：${dingtalkMessageSummary(message)}`;
  }

  /**
   * One live newest-page read per conversation. The caller already answered
   * from the store; this only reconciles what events may have missed.
   */
  #reconcileMessages(
    conversationId: string,
    limit: number,
    timing?: DingTalkOpenTiming,
  ): Promise<void> {
    const key = `live:messages:${conversationId}`;
    if (this.#inflight.has(key)) return Promise.resolve();
    const startedAt = this.#now();
    const recorded = timing ?? this.#recordOpen("prefetch", conversationId, false);
    return this.#dedupe(key, async () => {
      const page = await this.#readMessages(conversationId, limit);
      if (page.errorCode !== null) {
        this.#noteLiveError(page.errorCode);
        return page.errorCode;
      }
      if (this.#storeMessages(conversationId, page) && !this.#disposed) {
        this.#notify(conversationId);
      }
      return null;
    })
      .then((errorCode) => {
        recorded.liveMs = this.#now() - startedAt;
        recorded.liveError = errorCode;
        recorded.storeBytes = this.#live.stats().storeBytes;
      })
      .catch(() => {
        recorded.liveMs = this.#now() - startedAt;
        recorded.liveError = "dws_failed";
        recorded.storeBytes = this.#live.stats().storeBytes;
      });
  }

  #reconcileMembers(conversationId: string, timing: DingTalkOpenTiming): void {
    const key = `live:members:${conversationId}`;
    if (this.#inflight.has(key)) return;
    const startedAt = this.#now();
    void this.#dedupe(key, async () => {
      const live = await this.#cli.members(conversationId);
      if (live.errorCode !== null) {
        this.#noteLiveError(live.errorCode);
        return live.errorCode;
      }
      const changed = this.#live.applyMembers(conversationId, live.members, this.#now());
      if (changed && !this.#disposed) this.#notify(conversationId);
      return null;
    })
      .then((errorCode) => {
        timing.liveMs = this.#now() - startedAt;
        timing.liveError = errorCode;
        timing.storeBytes = this.#live.stats().storeBytes;
      })
      .catch(() => {
        timing.liveMs = this.#now() - startedAt;
        timing.liveError = "dws_failed";
        timing.storeBytes = this.#live.stats().storeBytes;
      });
  }

  #onEvent(record: DwsEventRecord): void {
    if (this.#disposed) return;
    const key = JSON.stringify([record.conversationId, record.messageId]);
    if (this.#seenEvents.has(key)) return;
    this.#seenEvents.add(key);
    if (this.#seenEvents.size > 4_000) {
      const oldest = this.#seenEvents.values().next().value;
      if (oldest !== undefined) this.#seenEvents.delete(oldest);
    }
    const selfName = this.#lastAuth?.userName?.trim();
    const atMe =
      record.atMe ||
      (record.kind === "group" &&
        Boolean(selfName) &&
        new RegExp(
          `@${selfName?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=[\\s（(：:,，。！？!?]|$)`,
          "u",
        ).test(record.text));
    const event = atMe === record.atMe ? record : { ...record, atMe };
    this.#applyEvent(event);
    for (const listener of this.#eventListeners) {
      try {
        listener(event);
      } catch {
        /* Dispatch listeners are isolated from the workbench. */
      }
    }
    this.#notify(record.conversationId);
  }

  /** Mirrors one Stream event into the live state before anyone re-reads it. */
  #applyEvent(record: DwsEventRecord): void {
    const body = parseMessageBody(record.text);
    const message: DingTalkMessage = {
      messageId: record.messageId,
      conversationId: record.conversationId,
      senderName: record.senderName || "未知成员",
      ...(record.senderId ? { senderId: record.senderId } : {}),
      createdAt: record.createdAt > 0 ? record.createdAt : this.#now(),
      text: body.text,
      unsupported: body.text.length === 0,
      mine: record.mine === true,
      ...(record.bot ? { bot: true } : {}),
      ...(body.cardTitle ? { cardTitle: body.cardTitle } : {}),
      ...(body.format === "markdown" ? { format: "markdown" as const } : {}),
    };
    this.#live.applyEvent({
      message,
      preview: this.#messagePreview(message),
      title: record.conversationTitle ?? (record.kind === "direct" ? record.senderName : ""),
      singleChat: record.kind === "direct",
      atMe: record.atMe,
      now: this.#now(),
    });
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
    this.#pendingNotify.add(conversationId);
    if (this.#notifyTimer) return;
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = null;
      const pending = [...this.#pendingNotify];
      this.#pendingNotify.clear();
      // One refresh reloads the whole list; the newest conversation id tells
      // the page which open transcript also needs an incremental read.
      const event = { conversationId: [...pending].reverse().find((id) => id !== null) ?? null };
      try {
        this.#onChange?.(event);
      } catch {
        /* Renderer notification is best effort. */
      }
      for (const notifier of this.#notifiers) {
        try {
          notifier(event);
        } catch {
          /* Renderer notification is best effort. */
        }
      }
    }, NOTIFY_DELAY_MS);
    this.#notifyTimer.unref?.();
  }

  dispose(): void {
    this.#disposed = true;
    this.#notifiers.clear();
    this.#pendingNotify.clear();
    this.#eventListeners.clear();
    this.#seenEvents.clear();
    this.#live.clear();
    this.#prefetchQueue.clear();
    this.#prefetchPending.clear();
    this.#timings.length = 0;
    this.#events.dispose();
    if (this.#notifyTimer) clearTimeout(this.#notifyTimer);
    if (this.#viewedWriteTimer) clearTimeout(this.#viewedWriteTimer);
    void this.#viewed.write(this.#viewedAt).catch(() => undefined);
  }
}

export function createDingTalkService(options: DingTalkServiceOptions): DingTalkService {
  return new DingTalkService(options);
}
