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

const VIEWED_WRITE_DELAY_MS = 500;
const NOTIFY_DELAY_MS = 250;
const UNREAD_LIMIT = 50;
const UNREAD_WINDOW_MS = 48 * 60 * 60_000;
const SEARCH_WINDOW_DAYS = 30;

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
    this.#lastAuth = null;
    await this.#cli.authStatus(true);
    return dingtalkSettingsSchema.parse(
      await readDingTalkSettings(this.#environment, this.#settings),
    );
  }

  async conversations(): Promise<DingTalkConversationsResult> {
    await this.#ensure();
    this.#events.touch();
    return await this.#dedupe("unread", async () => {
      const unread = await this.#cli
        .unreadConversations(UNREAD_LIMIT)
        .catch(() => ({ conversations: [], errorCode: "dws_failed" }));
      const cutoff = this.#now() - UNREAD_WINDOW_MS;
      const rows =
        unread.errorCode === null
          ? unread.conversations
              .filter(
                (row) =>
                  (row.lastMessageAt ?? 0) >= cutoff &&
                  (this.#active.has(row.conversationId) ||
                    (row.unreadCount > 0 &&
                      (row.lastMessageAt ?? 0) > (this.#viewedAt.get(row.conversationId) ?? 0))),
              )
              .map((row) => ({
                ...row,
                atMe: false,
                ...(this.#active.has(row.conversationId) ? { unreadCount: 0 } : {}),
              }))
              .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
              .slice(0, UNREAD_LIMIT)
          : [];
      return dingtalkConversationsResultSchema.parse({
        available: unread.errorCode === null,
        source: rows.length ? "unread" : "empty",
        conversations: rows,
        cachedAt: null,
        refreshing: false,
        errorCode: unread.errorCode,
      });
    });
  }

  async details(
    conversations: readonly DingTalkConversation[],
  ): Promise<{ conversations: DingTalkConversation[] }> {
    await this.#ensure();
    const rows = await readDingTalkConversationDetails(this.#cli, conversations);
    return {
      conversations: rows.map((row) => ({
        ...row,
        atMe:
          row.atMe === true &&
          !this.#active.has(row.conversationId) &&
          (row.lastMessageAt ?? 0) > (this.#viewedAt.get(row.conversationId) ?? 0),
      })),
    };
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
    return await this.#dedupe(
      `messages:${conversationId}:${params.before ?? "latest"}:${limit}:${params.includeConversation !== false}`,
      async () => {
        const [page, conversation] = await Promise.all([
          this.#readMessages(conversationId, limit, params.before),
          params.includeConversation === false
            ? Promise.resolve(null)
            : this.#cli.conversationInfo(conversationId).catch(() => null),
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
    if (this.#notifyTimer) clearTimeout(this.#notifyTimer);
    if (this.#viewedWriteTimer) clearTimeout(this.#viewedWriteTimer);
    void this.#viewed.write(this.#viewedAt).catch(() => undefined);
  }
}

export function createDingTalkService(options: DingTalkServiceOptions): DingTalkService {
  return new DingTalkService(options);
}
