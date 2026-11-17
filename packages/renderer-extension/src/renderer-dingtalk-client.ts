import {
  DINGTALK_CHANGED_METHOD,
  DINGTALK_CONVERSATIONS_METHOD,
  DINGTALK_MESSAGES_METHOD,
  DINGTALK_MEMBERS_METHOD,
  DINGTALK_PREVIEW_METHOD,
  DINGTALK_DETAILS_METHOD,
  dingtalkDetailsSchema,
  type DingTalkConversation,
  DINGTALK_RESOURCE_METHOD,
  DINGTALK_RESOLVE_METHOD,
  DINGTALK_SEARCH_METHOD,
  DINGTALK_SEND_METHOD,
  DINGTALK_STATUS_METHOD,
  DINGTALK_VIEWED_METHOD,
  dingtalkConversationsResultSchema,
  dingtalkMessagesResultSchema,
  dingtalkMembersResultSchema,
  dingtalkPreviewResultSchema,
  dingtalkResourceResultSchema,
  dingtalkResolveResultSchema,
  dingtalkSearchResultSchema,
  dingtalkSendResultSchema,
  dingtalkStatusSchema,
  type DingTalkConversationsResult,
  type DingTalkMessage,
  type DingTalkMessagesParams,
  type DingTalkMessagesResult,
  type DingTalkMembersResult,
  type DingTalkPreviewResult,
  type DingTalkResourceParams,
  type DingTalkResourceResult,
  type DingTalkResolveResult,
  type DingTalkSearchParams,
  type DingTalkSearchResult,
  type DingTalkSendParams,
  type DingTalkSendResult,
  type DingTalkStatus,
} from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

export interface RendererDingTalkManager {
  sendRequest(
    method: string,
    params: unknown,
    options?: { priority?: "background" | "interactive"; timeoutMs?: number },
  ): Promise<unknown> | unknown;
  addNotificationCallback?(
    methods: string | readonly string[],
    listener: (notification: unknown) => void,
  ): (() => void) | undefined;
}

export interface RendererDingTalkRoute {
  hostId: string;
  manager: RendererDingTalkManager;
}

export interface RendererDingTalkClientOptions {
  forHost(hostId: string): RendererDingTalkRoute | null;
  /** Window that carries raw Host notification frames; injectable for tests. */
  notificationTarget?: EventTarget | null;
}

export interface RendererDingTalkClient {
  available(): boolean;
  /** Starts a fresh page session; the DingTalk data Host is resolved again. */
  beginSession(): void;
  /** Releases the page session route and drops any routed subscription. */
  endSession(): void;
  status(refresh?: boolean): Promise<DingTalkStatus>;
  conversations(): Promise<DingTalkConversationsResult>;
  details(conversations: readonly DingTalkConversation[]): Promise<DingTalkConversation[]>;
  preview(conversationId: string): Promise<DingTalkPreviewResult>;
  messages(params: DingTalkMessagesParams): Promise<DingTalkMessagesResult>;
  members(conversationId: string): Promise<DingTalkMembersResult>;
  resource(params: DingTalkResourceParams): Promise<DingTalkResourceResult>;
  send(params: DingTalkSendParams): Promise<DingTalkSendResult>;
  search(params: DingTalkSearchParams): Promise<DingTalkSearchResult>;
  resolve(conversationId: string, messageIds?: readonly string[]): Promise<DingTalkResolveResult>;
  markViewed(conversationId: string, lastMessageAt: number, active?: boolean): Promise<void>;
  subscribe(listener: (conversationId: string | null) => void): () => void;
}

const DINGTALK_MESSAGES: Record<RendererSettingsLocale, Record<string, string>> = {
  "zh-CN": {
    not_installed: "DingTalk Host 未安装 dws",
    not_logged_in: "钉钉未登录",
    auth_failed: "钉钉登录状态读取失败",
    peer_unavailable: "无法连接 DingTalk Host",
    timeout: "钉钉命令超时",
    cli_failed: "钉钉命令失败",
    local_only: "该操作只能在桌面本机执行",
    invalid_params: "请求参数无效",
    dws_failed: "钉钉数据读取失败",
    cache_unavailable: "无法写入图片缓存",
    download_failed: "图片下载失败",
    resource_too_large: "图片过大，暂不显示",
    unsupported_media: "图片格式暂不支持",
  },
  en: {
    not_installed: "dws is not installed on the DingTalk Host",
    not_logged_in: "DingTalk is not signed in",
    auth_failed: "Could not read the DingTalk login state",
    peer_unavailable: "The DingTalk Host is unreachable",
    timeout: "The DingTalk command timed out",
    cli_failed: "The DingTalk command failed",
    local_only: "This action is available on the desktop Host only",
    invalid_params: "Invalid request",
    dws_failed: "Could not read DingTalk data",
    cache_unavailable: "Could not write the image cache",
    download_failed: "Could not download the image",
    resource_too_large: "The image is too large to show",
    unsupported_media: "This image format is not supported",
  },
};

export function dingtalkErrorText(
  code: string | null | undefined,
  locale: RendererSettingsLocale,
): string {
  if (!code) return "";
  return DINGTALK_MESSAGES[locale][code] ?? code;
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === "string") return value;
  }
  if (error instanceof Error) {
    const match = /^([a-z_]+):/u.exec(error.message);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function createRendererDingTalkClient(
  options: RendererDingTalkClientOptions,
): RendererDingTalkClient {
  const notificationTarget =
    options.notificationTarget ?? (typeof window === "undefined" ? null : window);
  const listeners = new Set<(conversationId: string | null) => void>();
  let session = 0;
  let statusPromise: Promise<DingTalkStatus> | null = null;
  let resolving: Promise<RendererDingTalkRoute | null> | null = null;
  let resolvedRoute: RendererDingTalkRoute | null = null;
  let routedSubscription: (() => void) | null = null;
  let subscribedRoute: RendererDingTalkRoute | null = null;

  const localRoute = (): RendererDingTalkRoute | null => options.forHost("local");

  const emit = (value: unknown): void => {
    const params =
      typeof value === "object" && value !== null && "params" in value
        ? (value as { params?: unknown }).params
        : undefined;
    const conversationId =
      typeof params === "object" && params !== null
        ? (params as { conversationId?: unknown }).conversationId
        : undefined;
    for (const listener of listeners) {
      try {
        listener(typeof conversationId === "string" ? conversationId : null);
      } catch {
        /* One page listener must not block the others. */
      }
    }
  };

  const detachRoute = (): void => {
    routedSubscription?.();
    routedSubscription = null;
    subscribedRoute = null;
  };

  const attachRoute = (): void => {
    const route = resolvedRoute;
    if (!route || listeners.size === 0) {
      if (!route) detachRoute();
      return;
    }
    if (subscribedRoute === route) return;
    detachRoute();
    const unsubscribe = route.manager.addNotificationCallback?.(DINGTALK_CHANGED_METHOD, emit);
    const onMessage = (event: Event): void => {
      const message = (event as MessageEvent).data;
      if (
        typeof message !== "object" ||
        message === null ||
        (message as { type?: unknown }).type !== "mcp-notification" ||
        (message as { method?: unknown }).method !== DINGTALK_CHANGED_METHOD
      ) {
        return;
      }
      // Desktop may fan every Host's frames into this window; keep only the
      // DingTalk Host the page is reading from.
      const hostId = (message as { hostId?: unknown }).hostId;
      if (typeof hostId === "string" && hostId !== route.hostId) return;
      emit(message);
    };
    notificationTarget?.addEventListener("message", onMessage);
    routedSubscription = () => {
      unsubscribe?.();
      notificationTarget?.removeEventListener("message", onMessage);
    };
    subscribedRoute = route;
  };

  const remoteRouteFor = (status: DingTalkStatus): RendererDingTalkRoute | null =>
    status.defaultHost !== "local" && status.defaultHostId
      ? options.forHost(status.defaultHostId)
      : null;

  /**
   * A DingTalk Host whose Runtime predates direct reads answers "unavailable";
   * the page then keeps using local forwarding instead of failing.
   */
  const probeRemote = async (route: RendererDingTalkRoute | null): Promise<boolean> => {
    if (!route) return false;
    try {
      dingtalkStatusSchema.parse(
        await route.manager.sendRequest(DINGTALK_STATUS_METHOD, {}, { timeoutMs: 10_000 }),
      );
      return true;
    } catch {
      return false;
    }
  };

  const applyStatus = (status: DingTalkStatus, remoteUsable: boolean): void => {
    const remote = remoteUsable ? remoteRouteFor(status) : null;
    const next = remote ?? localRoute();
    resolvedRoute = next;
    if (statusPromise === null && resolving === null) attachRoute();
    else if (next === null) detachRoute();
  };

  const readStatus = (refresh = false): Promise<DingTalkStatus> => {
    statusPromise ??= (async () => {
      const generation = session;
      const current = localRoute();
      if (!current) throw new Error("peer_unavailable: Host Runtime is unavailable");
      const status = dingtalkStatusSchema.parse(
        await current.manager.sendRequest(
          DINGTALK_STATUS_METHOD,
          refresh ? { refresh: true } : {},
          { timeoutMs: 45_000 },
        ),
      );
      const remoteUsable = await probeRemote(remoteRouteFor(status));
      if (generation === session) applyStatus(status, remoteUsable);
      return status;
    })().finally(() => {
      statusPromise = null;
      attachRoute();
    });
    return statusPromise;
  };

  /** The DingTalk Host route for this page session; local forwarding otherwise. */
  const dataRoute = (): Promise<RendererDingTalkRoute | null> => {
    if (resolvedRoute) return Promise.resolve(resolvedRoute);
    const generation = session;
    resolving ??= (async () => {
      void readStatus().catch(() => null);
      if (generation !== session) return null;
      return resolvedRoute ?? localRoute();
    })().finally(() => {
      resolving = null;
      attachRoute();
    });
    return resolving;
  };

  const request = async (
    method: string,
    params: unknown,
    timeoutMs = 45_000,
    priority: "interactive" | "background" = "interactive",
  ): Promise<unknown> => {
    const current = await dataRoute();
    if (!current) throw new Error("peer_unavailable: Host Runtime is unavailable");
    return await current.manager.sendRequest(method, params, { timeoutMs, priority });
  };

  return {
    available: () => localRoute() !== null,
    beginSession() {
      session += 1;
      resolvedRoute = null;
      detachRoute();
    },
    endSession() {
      session += 1;
      resolvedRoute = null;
      detachRoute();
    },
    async status(refresh = false) {
      return await readStatus(refresh);
    },
    async conversations() {
      return dingtalkConversationsResultSchema.parse(
        await request(DINGTALK_CONVERSATIONS_METHOD, {}),
      );
    },
    async details(conversations) {
      return dingtalkDetailsSchema.parse(
        await request(DINGTALK_DETAILS_METHOD, { conversations }, 90_000, "background"),
      ).conversations;
    },
    async preview(conversationId) {
      return dingtalkPreviewResultSchema.parse(
        await request(DINGTALK_PREVIEW_METHOD, { conversationId }, 30_000, "background"),
      );
    },
    async messages(params) {
      return dingtalkMessagesResultSchema.parse(
        await request(DINGTALK_MESSAGES_METHOD, { ...params, includeConversation: false }),
      );
    },
    async members(conversationId) {
      return dingtalkMembersResultSchema.parse(
        await request(DINGTALK_MEMBERS_METHOD, { conversationId }, 30_000),
      );
    },
    async resource(params) {
      return dingtalkResourceResultSchema.parse(
        await request(DINGTALK_RESOURCE_METHOD, params, 60_000),
      );
    },
    async send(params) {
      return dingtalkSendResultSchema.parse(await request(DINGTALK_SEND_METHOD, params, 60_000));
    },
    async search(params) {
      return dingtalkSearchResultSchema.parse(
        await request(DINGTALK_SEARCH_METHOD, params, 60_000),
      );
    },
    async resolve(conversationId, messageIds) {
      return dingtalkResolveResultSchema.parse(
        await request(DINGTALK_RESOLVE_METHOD, {
          conversationId,
          ...(messageIds && messageIds.length > 0 ? { messageIds: [...messageIds] } : {}),
        }),
      );
    },
    async markViewed(conversationId, lastMessageAt, active) {
      try {
        await request(DINGTALK_VIEWED_METHOD, {
          conversationId,
          lastMessageAt,
          ...(active === undefined ? {} : { active }),
        });
      } catch {
        // View state is an optimization; a failure must not hide messages.
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      if (resolvedRoute) attachRoute();
      else void dataRoute().catch(() => undefined);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) detachRoute();
      };
    },
  };
}

export { errorCode as dingtalkClientErrorCode };

export type { DingTalkMessage };
