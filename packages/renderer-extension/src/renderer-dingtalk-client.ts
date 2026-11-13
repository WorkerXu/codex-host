import {
  DINGTALK_CHANGED_METHOD,
  DINGTALK_CONVERSATIONS_METHOD,
  DINGTALK_DECIDE_METHOD,
  DINGTALK_MESSAGES_METHOD,
  DINGTALK_RESOLVE_METHOD,
  DINGTALK_SEARCH_METHOD,
  DINGTALK_SEND_METHOD,
  DINGTALK_SETTINGS_GET_METHOD,
  DINGTALK_SETTINGS_SET_METHOD,
  DINGTALK_STATUS_METHOD,
  DINGTALK_VIEWED_METHOD,
  dingtalkConversationsResultSchema,
  dingtalkDecideResultSchema,
  dingtalkMessagesResultSchema,
  dingtalkResolveResultSchema,
  dingtalkSearchResultSchema,
  dingtalkSendResultSchema,
  dingtalkSettingsSchema,
  dingtalkStatusSchema,
  type DingTalkConversationsResult,
  type DingTalkDecideParams,
  type DingTalkDecideResult,
  type DingTalkMessage,
  type DingTalkMessagesParams,
  type DingTalkMessagesResult,
  type DingTalkResolveResult,
  type DingTalkSearchParams,
  type DingTalkSearchResult,
  type DingTalkSendParams,
  type DingTalkSendResult,
  type DingTalkSettings,
  type DingTalkSettingsSetParams,
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
}

export interface RendererDingTalkClient {
  available(): boolean;
  status(): Promise<DingTalkStatus>;
  settings(): Promise<DingTalkSettings>;
  updateSettings(params: DingTalkSettingsSetParams): Promise<DingTalkSettings>;
  conversations(refresh?: boolean): Promise<DingTalkConversationsResult>;
  messages(params: DingTalkMessagesParams): Promise<DingTalkMessagesResult>;
  send(params: DingTalkSendParams): Promise<DingTalkSendResult>;
  decide(params: DingTalkDecideParams): Promise<DingTalkDecideResult>;
  search(params: DingTalkSearchParams): Promise<DingTalkSearchResult>;
  resolve(conversationId: string, messageIds?: readonly string[]): Promise<DingTalkResolveResult>;
  markViewed(conversationId: string, lastMessageAt: number): Promise<void>;
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
    decision_unavailable: "搜索分类不可用，已按关键词搜索",
    dws_failed: "钉钉数据读取失败",
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
    decision_unavailable: "Search classification is unavailable; using keyword search",
    dws_failed: "Could not read DingTalk data",
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
  const route = (): RendererDingTalkRoute | null => options.forHost("local");

  const request = async (method: string, params: unknown, timeoutMs = 45_000): Promise<unknown> => {
    const current = route();
    if (!current) throw new Error("peer_unavailable: Host Runtime is unavailable");
    return await current.manager.sendRequest(method, params, { timeoutMs });
  };

  return {
    available: () => route() !== null,
    async status() {
      return dingtalkStatusSchema.parse(await request(DINGTALK_STATUS_METHOD, {}));
    },
    async settings() {
      return dingtalkSettingsSchema.parse(await request(DINGTALK_SETTINGS_GET_METHOD, {}));
    },
    async updateSettings(params) {
      return dingtalkSettingsSchema.parse(await request(DINGTALK_SETTINGS_SET_METHOD, params));
    },
    async conversations(refresh = false) {
      return dingtalkConversationsResultSchema.parse(
        await request(DINGTALK_CONVERSATIONS_METHOD, { refresh }),
      );
    },
    async messages(params) {
      return dingtalkMessagesResultSchema.parse(await request(DINGTALK_MESSAGES_METHOD, params));
    },
    async send(params) {
      return dingtalkSendResultSchema.parse(await request(DINGTALK_SEND_METHOD, params, 60_000));
    },
    async decide(params) {
      return dingtalkDecideResultSchema.parse(await request(DINGTALK_DECIDE_METHOD, params));
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
    async markViewed(conversationId, lastMessageAt) {
      try {
        await request(DINGTALK_VIEWED_METHOD, { conversationId, lastMessageAt });
      } catch {
        // View state is an optimization; a failure must not hide messages.
      }
    },
    subscribe(listener) {
      const current = route();
      const emit = (value: unknown): void => {
        const conversationId =
          typeof value === "object" &&
          value !== null &&
          "params" in value &&
          typeof (value as { params?: unknown }).params === "object"
            ? (value as { params?: { conversationId?: unknown } }).params?.conversationId
            : null;
        listener(typeof conversationId === "string" ? conversationId : null);
      };
      const unsubscribe = current?.manager.addNotificationCallback?.(DINGTALK_CHANGED_METHOD, emit);
      // Desktop's app-server method table may drop custom notifications before
      // the native manager callback; observe the real Host frame as a fallback.
      const onMessage = (event: MessageEvent): void => {
        const message = event.data;
        if (
          typeof message !== "object" ||
          message === null ||
          (message as { type?: unknown }).type !== "mcp-notification" ||
          (message as { method?: unknown }).method !== DINGTALK_CHANGED_METHOD
        ) {
          return;
        }
        emit(message);
      };
      window.addEventListener("message", onMessage);
      return () => {
        unsubscribe?.();
        window.removeEventListener("message", onMessage);
      };
    },
  };
}

export { errorCode as dingtalkClientErrorCode };

export type { DingTalkMessage };
