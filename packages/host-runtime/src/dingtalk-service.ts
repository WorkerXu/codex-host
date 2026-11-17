import {
  DINGTALK_MAX_MEMBERS,
  dingtalkConversationsResultSchema,
  dingtalkMembersResultSchema,
  dingtalkMessagesResultSchema,
  dingtalkPreviewResultSchema,
  dingtalkResolveResultSchema,
  dingtalkResourceResultSchema,
  dingtalkSearchResultSchema,
  dingtalkSendResultSchema,
  dingtalkSettingsSchema,
  dingtalkStatusSchema,
  type DingTalkConversation,
  type DingTalkConversationsResult,
  type DingTalkMessage,
  type DingTalkMessagesParams,
  type DingTalkMessagesResult,
  type DingTalkMention,
  type DingTalkMembersResult,
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
  type DingTalkCardInput,
  type DingTalkCardUpdate,
  type DingTalkCardResult,
  type DingTalkCli,
  type DingTalkGroupMeta,
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
import type { PeerSpawn } from "./peer-transport.js";

const GROUP_META_TTL_MS = 10 * 60_000;
const VIEWED_WRITE_DELAY_MS = 500;
const NOTIFY_DELAY_MS = 250;
const UNREAD_LIMIT = 50;
const UNREAD_WINDOW_MS = 48 * 60 * 60_000;
const SEARCH_WINDOW_DAYS = 30;
const ENRICHMENT_IDLE_MS = 5_000;

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
  source: "unread" | "empty";
  rows: DingTalkConversation[];
  fetchedAt: number;
  errorCode: string | null;
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
  readonly #conversations = new Map<string, DingTalkConversation>();
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #viewedAt = new Map<string, number>();
  /** Open workbench conversations stay in the list without a badge until closed. */
  readonly #active = new Map<string, DingTalkConversation>();
  #viewedLoaded = false;
  #viewedWriteTimer: ReturnType<typeof setTimeout> | null = null;
  #list: ConversationCache | null = null;
  #refreshing: Promise<void> | null = null;
  #refreshQueued = false;
  #groupMeta: Map<string, DingTalkGroupMeta> | null = null;
  #groupMetaAt = 0;
  #atMe = new Map<string, number>();
  #ready: Promise<void> | null = null;
  #lastAuth: Awaited<ReturnType<DingTalkCli["authStatus"]>> | null = null;
  #lastAuthAt = 0;
  #enrichmentTimer: ReturnType<typeof setTimeout> | null = null;
  #enriching = false;
  #messageReads = 0;
  readonly #events: DingTalkEventListener;
  #notifyTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingNotify = new Set<string | null>();
  readonly #eventListeners = new Set<(record: DwsEventRecord) => void>();
  readonly #seenEvents = new Set<string>();
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
        openEventsImpl: (input) => this.#transport.openEvents(input),
        ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
      });
    this.#onChange = options.onChange;
    this.#events = new DingTalkEventListener({
      cli: this.#cli,
      local: () => this.#transport.canListen,
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

  async status(): Promise<DingTalkStatus> {
    await this.#ensure();
    const auth = await this.#cli.authStatus();
    this.#lastAuth = auth;
    this.#lastAuthAt = this.#now();
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
    this.#conversations.clear();
    this.#inflight.clear();
    this.#groupMeta = null;
    this.#groupMetaAt = 0;
    this.#atMe = new Map();
    return dingtalkSettingsSchema.parse(
      await readDingTalkSettings(this.#environment, this.#settings),
    );
  }

  async conversations(): Promise<DingTalkConversationsResult> {
    await this.#ensure();
    this.#events.touch();
    // The workbench always reads current data; concurrent identical reads share
    // one dws call instead of arriving at a result cache.
    await this.#refresh();
    const list = this.#list;
    return dingtalkConversationsResultSchema.parse({
      available: list !== null && list.errorCode === null,
      source: list?.source ?? "empty",
      conversations: list?.rows ?? [],
      cachedAt: list?.fetchedAt ?? null,
      refreshing: false,
      errorCode: list?.errorCode ?? null,
    });
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
    const conversationId = params.conversationId;
    const limit = params.limit ?? 40;
    return await this.#dedupe(
      `messages:${conversationId}:${params.before ?? "latest"}:${limit}`,
      async () => {
        this.#messageReads += 1;
        try {
          const [page, conversation] = await Promise.all([
            this.#readMessages(conversationId, limit, params.before),
            this.#conversationSnapshot(conversationId),
          ]);
          return dingtalkMessagesResultSchema.parse({
            available: page.errorCode === null,
            conversation,
            messages: page.messages,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            cachedAt: null,
            errorCode: page.errorCode,
          });
        } finally {
          this.#messageReads -= 1;
          this.#scheduleEnrichment();
        }
      },
    );
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

  /** Human members for the group composer's native `@` picker. */
  async members(conversationId: string): Promise<DingTalkMembersResult> {
    await this.#ensure();
    this.#events.touch();
    return await this.#dedupe(`members:${conversationId}`, async () => {
      const result = await this.#cli.members(conversationId);
      return dingtalkMembersResultSchema.parse({
        available: result.errorCode === null,
        members: result.members.slice(0, DINGTALK_MAX_MEMBERS),
        errorCode: result.errorCode,
      });
    });
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
      const sentAt = this.#now();
      const conversation = this.#conversations.get(params.conversationId);
      if (conversation) {
        conversation.lastMessageAt = sentAt;
        conversation.preview = `我：${previewOf(params.text)}`;
      }
      if (this.#list) {
        this.#list.rows = this.#list.rows.map((row) =>
          row.conversationId === params.conversationId
            ? { ...row, lastMessageAt: sentAt, preview: `我：${previewOf(params.text)}` }
            : row,
        );
      }
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
    let changed = false;
    const list = this.#list;
    const listed =
      list?.rows.find((conversation) => conversation.conversationId === conversationId) ?? null;
    const row = listed ?? this.#active.get(conversationId) ?? null;
    if (active && row) {
      const cleared: DingTalkConversation = {
        ...row,
        unreadCount: 0,
        atMe: false,
        ...(lastMessageAt > (row.lastMessageAt ?? 0) ? { lastMessageAt } : {}),
      };
      const wasActive = this.#active.has(conversationId);
      this.#active.set(conversationId, cleared);
      this.#conversations.set(conversationId, cleared);
      if (list && listed) {
        this.#list = {
          ...list,
          rows: list.rows.map((conversation) =>
            conversation.conversationId === conversationId ? cleared : conversation,
          ),
        };
        // Badge removal is the visible change; a newer viewed timestamp alone
        // must not start another page refresh.
        if (row.unreadCount > 0 || row.atMe === true || !wasActive) changed = true;
      } else if (!wasActive) {
        changed = true;
      }
    } else if (!active) {
      const wasActive = this.#active.delete(conversationId);
      if (list) {
        const rows = list.rows.filter(
          (conversation) =>
            conversation.conversationId !== conversationId ||
            (conversation.lastMessageAt ?? 0) > lastMessageAt,
        );
        if (rows.length !== list.rows.length) {
          this.#list = {
            ...list,
            rows,
            source: rows.length > 0 ? "unread" : "empty",
          };
          changed = true;
          if (rows.length === 0) void this.#refresh().catch(() => undefined);
        }
      }
      if (wasActive) changed = true;
    }
    if (changed) this.#notify(conversationId);
    return {};
  }

  /**
   * Plain keyword search. Local list matches come first, then groups, people
   * and message hits from dws; conversations are de-duplicated by id.
   */
  async search(params: DingTalkSearchParams): Promise<DingTalkSearchResult> {
    await this.#ensure();
    this.#events.touch();
    if (!this.#list) await this.#refresh();
    const query = params.query.trim();
    const needle = query.toLowerCase();
    const local: DingTalkConversation[] = [];
    const localSeen = new Set<string>();
    for (const row of this.#list?.rows ?? []) {
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
      this.#conversationSnapshot(mention.conversationId),
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
    this.#conversations.set(row.conversationId, row);
    return row;
  }

  async #conversationFor(conversationId: string): Promise<DingTalkConversation | null> {
    const cached =
      this.#conversations.get(conversationId) ??
      this.#list?.rows.find((conversation) => conversation.conversationId === conversationId) ??
      null;
    if (cached) return cached;
    const info = await this.#cli.conversationInfo(conversationId);
    if (!info) return cached;
    const meta = this.#groupMeta?.get(conversationId);
    const enriched: DingTalkConversation = {
      ...info,
      ...(meta
        ? {
            groupType: info.groupType ?? meta.groupType,
            memberCount: info.memberCount ?? meta.memberCount,
          }
        : {}),
    };
    this.#conversations.set(conversationId, enriched);
    return enriched;
  }

  /**
   * Messages and mention context need a title, not another directory lookup.
   * Optional metadata is enriched after foreground reads have settled.
   */
  async #conversationSnapshot(conversationId: string): Promise<DingTalkConversation | null> {
    const cached =
      this.#conversations.get(conversationId) ??
      this.#list?.rows.find((conversation) => conversation.conversationId === conversationId) ??
      null;
    if (cached) return cached;
    const info = await this.#cli.conversationInfo(conversationId).catch(() => null);
    if (info) this.#conversations.set(conversationId, info);
    return info;
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

  #refresh(queue = false): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const active = this.#refreshing;
    if (active) {
      if (queue) this.#refreshQueued = true;
      return active;
    }
    const promise = this.#runRefresh().finally(() => {
      if (this.#refreshing !== promise) return;
      this.#refreshing = null;
      if (this.#refreshQueued) {
        this.#refreshQueued = false;
        void this.#refresh().catch(() => undefined);
      }
    });
    this.#refreshing = promise;
    return promise;
  }

  async #runRefresh(): Promise<void> {
    try {
      // Only authentication and unread rows gate the first list.
      const reuseAuth =
        this.#lastAuth !== null && this.#now() - this.#lastAuthAt < ENRICHMENT_IDLE_MS;
      const [auth, unread] = await Promise.all([
        reuseAuth ? Promise.resolve(this.#lastAuth) : this.#cli.authStatus().catch(() => null),
        this.#cli.unreadConversations(UNREAD_LIMIT),
      ]);
      if (auth) {
        this.#lastAuth = auth;
        if (!reuseAuth) this.#lastAuthAt = this.#now();
      }
      if (!auth?.installed || !auth.authenticated) {
        this.#list = {
          source: "empty",
          rows: [],
          fetchedAt: this.#now(),
          errorCode: auth?.errorCode ?? "not_installed",
        };
        return;
      }
      if (unread.errorCode !== null) {
        this.#list = {
          source: this.#list?.source === "unread" ? "unread" : "empty",
          rows: this.#list?.rows ?? [],
          fetchedAt: this.#now(),
          errorCode: unread.errorCode,
        };
        return;
      }
      for (const conversation of unread.conversations) {
        this.#conversations.set(conversation.conversationId, this.#withMeta(conversation));
      }
      const cutoff = this.#now() - UNREAD_WINDOW_MS;
      const byId = new Map(
        unread.conversations.map((conversation) => [
          conversation.conversationId,
          this.#withMeta(conversation),
        ]),
      );
      // An open conversation keeps its row even when dws stops reporting it as
      // unread; its badge stays cleared until the page leaves it.
      for (const [conversationId, snapshot] of this.#active) {
        const latest = byId.get(conversationId);
        const merged: DingTalkConversation = {
          ...(latest ?? snapshot),
          ...(latest && !latest.preview && snapshot.preview ? { preview: snapshot.preview } : {}),
          unreadCount: 0,
          atMe: false,
          lastMessageAt: Math.max(latest?.lastMessageAt ?? 0, snapshot.lastMessageAt ?? 0) || null,
        };
        byId.set(conversationId, merged);
        this.#active.set(conversationId, merged);
        this.#conversations.set(conversationId, merged);
      }
      const rows = [...byId.values()]
        .filter((conversation) => {
          if ((conversation.lastMessageAt ?? 0) < cutoff) return false;
          if (this.#active.has(conversation.conversationId)) return true;
          const reported = unread.conversations.find(
            (row) => row.conversationId === conversation.conversationId,
          );
          return (
            reported !== undefined &&
            reported.unreadCount > 0 &&
            (conversation.lastMessageAt ?? 0) >
              (this.#viewedAt.get(conversation.conversationId) ?? 0)
          );
        })
        .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
        .slice(0, UNREAD_LIMIT);
      this.#list = {
        source: rows.length > 0 ? "unread" : "empty",
        rows,
        fetchedAt: this.#now(),
        errorCode: null,
      };
      this.#scheduleEnrichment();
    } catch {
      this.#list = {
        source: this.#list?.source ?? "empty",
        rows: this.#list?.rows ?? [],
        fetchedAt: this.#now(),
        errorCode: "dws_failed",
      };
    }
  }

  /** Directory and @me queries share the CLI's resources; keep them off the first-read path. */
  #scheduleEnrichment(): void {
    if (this.#disposed || this.#enriching) return;
    if (this.#enrichmentTimer) clearTimeout(this.#enrichmentTimer);
    this.#enrichmentTimer = setTimeout(() => {
      this.#enrichmentTimer = null;
      if (this.#messageReads > 0) {
        this.#scheduleEnrichment();
        return;
      }
      this.#enriching = true;
      void (async () => {
        const changes = await Promise.all([this.#loadGroupMeta(), this.#loadAtMe()]);
        const changed = changes.some(Boolean);
        if (this.#disposed) return;
        if (changed && !this.#disposed && this.#list) {
          this.#list.rows = this.#list.rows.map((row) => this.#withMeta(row));
          this.#notify(null);
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          this.#enriching = false;
        });
    }, ENRICHMENT_IDLE_MS);
    this.#enrichmentTimer.unref?.();
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
      atMe:
        conversation.unreadCount > 0 &&
        atMeAt !== undefined &&
        atMeAt > viewedAt &&
        !this.#active.has(conversation.conversationId),
    };
  }

  async #loadGroupMeta(): Promise<boolean> {
    if (this.#groupMeta && this.#now() - this.#groupMetaAt < GROUP_META_TTL_MS) return false;
    const result = await this.#cli.groupDirectory().catch(() => null);
    if (!result?.directory || this.#disposed) return false;
    this.#groupMeta = result.directory;
    this.#groupMetaAt = this.#now();
    return true;
  }

  async #loadAtMe(): Promise<boolean> {
    const result = await this.#cli.atMeHits(2, 50).catch(() => null);
    if (!result || result.errorCode !== null || this.#disposed) return false;
    const next = new Map<string, number>();
    const candidates = new Map<string, number>();
    for (const hit of result.hits) {
      if (hit.createdAt === null) continue;
      candidates.set(
        hit.conversationId,
        Math.max(candidates.get(hit.conversationId) ?? 0, hit.createdAt),
      );
    }
    await mapLimit([...candidates], 3, async ([id, hitAt]) => {
      const row = this.#list?.rows.find((row) => row.conversationId === id);
      if (!row || row.unreadCount <= 0 || this.#active.has(id)) return;
      const page = await this.#cli
        .messages({ conversationId: id, limit: Math.min(row.unreadCount, 100) })
        .catch(() => null);
      if (!page || page.errorCode !== null) return;
      const unread = page.messages
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-row.unreadCount);
      const firstUnreadAt = unread[0]?.createdAt;
      if (
        firstUnreadAt !== undefined &&
        hitAt >= firstUnreadAt &&
        hitAt <= (row.lastMessageAt ?? 0)
      )
        next.set(id, hitAt);
    });
    const changed =
      next.size !== this.#atMe.size || [...next].some(([id, at]) => this.#atMe.get(id) !== at);
    this.#atMe = next;
    return changed;
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
    for (const listener of this.#eventListeners) {
      try {
        listener(event);
      } catch {
        /* Dispatch listeners are isolated from the workbench. */
      }
    }
    const list = this.#list;
    if (list?.source === "unread") {
      const previous = list.rows.find(
        (conversation) => conversation.conversationId === record.conversationId,
      );
      const known = previous ??
        this.#active.get(record.conversationId) ??
        this.#conversations.get(record.conversationId) ?? {
          conversationId: record.conversationId,
          title: "",
          singleChat: false,
          unreadCount: 0,
          lastMessageAt: null,
          muted: false,
        };
      const active = this.#active.has(record.conversationId);
      const updated: DingTalkConversation = {
        ...known,
        unreadCount: active ? 0 : known.unreadCount + 1,
        atMe: active ? false : known.atMe,
        lastMessageAt: Math.max(known.lastMessageAt ?? 0, record.createdAt),
        preview: previewOf(record.text),
      };
      const visible =
        active ||
        ((updated.lastMessageAt ?? 0) >= this.#now() - UNREAD_WINDOW_MS &&
          (updated.lastMessageAt ?? 0) > (this.#viewedAt.get(record.conversationId) ?? 0));
      const rows = (
        visible
          ? [updated, ...list.rows.filter((row) => row.conversationId !== record.conversationId)]
          : list.rows.filter((row) => row.conversationId !== record.conversationId)
      )
        .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
        .slice(0, UNREAD_LIMIT);
      this.#list = { ...list, source: rows.length > 0 ? "unread" : "empty", rows };
      if (active) this.#active.set(record.conversationId, updated);
      this.#conversations.set(record.conversationId, updated);
    } else {
      void this.#refresh(true).catch(() => undefined);
    }
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
    this.#events.dispose();
    if (this.#enrichmentTimer) clearTimeout(this.#enrichmentTimer);
    if (this.#notifyTimer) clearTimeout(this.#notifyTimer);
    if (this.#viewedWriteTimer) clearTimeout(this.#viewedWriteTimer);
    void this.#viewed.write(this.#viewedAt).catch(() => undefined);
  }
}

export function createDingTalkService(options: DingTalkServiceOptions): DingTalkService {
  return new DingTalkService(options);
}
