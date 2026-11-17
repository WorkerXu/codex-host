import type {
  CodexAgentCatalogResult,
  CodexAgentListResult,
  CodexAgentRecord,
  CodexAgentSaveParams,
  DingTalkConversation,
  DingTalkConversationsResult,
  DingTalkMessage,
  DingTalkMessagesResult,
  DingTalkResolveResult,
  DingTalkResourceResult,
  DingTalkSearchResult,
  DingTalkSendResult,
  DingTalkStatus,
  DingTalkDispatchSettings,
  DingTalkDispatchStatus,
  JarvisStatus,
} from "@codexhost/shared-contracts";

import type { RendererCodexAgentsClient } from "../../../packages/renderer-extension/src/renderer-codex-agents-client.js";
import type { RendererDingTalkClient } from "../../../packages/renderer-extension/src/renderer-dingtalk-client.js";
import type {
  RendererJarvisClient,
  RendererJarvisHost,
} from "../../../packages/renderer-extension/src/renderer-jarvis-client.js";
import {
  agentCatalog,
  agentSummaries,
  agents,
  conversations,
  dispatchSettings,
  groupMembers,
  heavyConversation,
  messagesFor,
  previewImageDataUrl,
  remoteSearchGroups,
  remoteSearchPeople,
} from "./fixtures.js";

export type FakeDingTalkStatus = "connected" | "not-logged-in" | "unreachable";

export interface FakeDingTalkOptions {
  empty?: boolean;
  error?: boolean;
  conversationsPending?: boolean;
  messageDelayMs?: number;
  status?: FakeDingTalkStatus;
  heavy?: boolean;
  /** Preview-only: make view state change the visible list like the Host. */
  liveUnread?: boolean;
  onSend?(params: { text: string; atOpenDingTalkIds?: string[]; atAll?: boolean }): void;
  onViewed?(conversationId: string, active: boolean): void;
  /** Preview-only: notify subscribers after this delay, like a dws event. */
  pushChangeAfterMs?: number;
  duplicateMessages?: boolean;
  changeRepeats?: number;
  sendEcho?: "before" | "after";
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export function createFakeDingTalkClient(
  options: FakeDingTalkOptions = {},
): RendererDingTalkClient {
  const messageDelay = options.messageDelayMs ?? 120;
  const statusState = options.status ?? "connected";
  const listeners = new Set<(conversationId: string | null) => void>();
  const viewed = new Set<string>();
  const active = new Set<string>();

  const conversationsResult = (): DingTalkConversationsResult => {
    const cutoff = Date.now() - 48 * 60 * 60_000;
    const visible = (row: DingTalkConversation): boolean =>
      (row.unreadCount > 0 &&
        (row.lastMessageAt ?? 0) >= cutoff &&
        !viewed.has(row.conversationId)) ||
      active.has(row.conversationId);
    const rows = (
      options.heavy
        ? [{ ...heavyConversation }, ...conversations.slice(0, 4).map((row) => ({ ...row }))]
        : conversations.map((row) => ({ ...row }))
    )
      .filter(visible)
      .map((row) =>
        active.has(row.conversationId) ? { ...row, unreadCount: 0, atMe: false } : row,
      );
    return {
      available: !options.error,
      source: options.empty || options.error ? "empty" : rows.length > 0 ? "unread" : "empty",
      conversations: options.empty || options.error ? [] : rows,
      cachedAt: Date.now(),
      refreshing: false,
      errorCode: options.error ? "cli_failed" : null,
    };
  };

  return {
    available: () => true,
    beginSession() {
      // Preview fixtures do not route between Hosts.
    },
    endSession() {
      // Preview fixtures do not route between Hosts.
    },
    async status(): Promise<DingTalkStatus> {
      if (statusState === "not-logged-in") {
        return {
          installed: true,
          authenticated: false,
          userName: null,
          userId: null,
          corpName: null,
          defaultHost: "tencent",
          defaultHostId: "host-tencent",
          errorCode: "not_logged_in",
        };
      }
      if (statusState === "unreachable") {
        return {
          installed: true,
          authenticated: false,
          userName: null,
          userId: null,
          corpName: null,
          defaultHost: "tencent",
          defaultHostId: "host-tencent",
          errorCode: "peer_unavailable",
        };
      }
      return {
        installed: true,
        authenticated: true,
        userName: "示例用户",
        userId: "user-preview",
        corpName: "示例科技有限公司",
        defaultHost: "tencent",
        defaultHostId: "host-tencent",
        errorCode: null,
      };
    },
    async conversations(): Promise<DingTalkConversationsResult> {
      if (options.conversationsPending) return new Promise(() => {});
      await sleep(40);
      return conversationsResult();
    },
    async preview(conversationId) {
      await sleep(20);
      const row = conversations.find((item) => item.conversationId === conversationId);
      return {
        available: true,
        preview: row?.preview || "林晓：这条摘要由可见行懒加载。",
        cachedAt: Date.now(),
        errorCode: null,
      };
    },
    async messages(params): Promise<DingTalkMessagesResult> {
      const previewWindow = window as Window & { __dingtalkPreviewMessageCalls?: number };
      previewWindow.__dingtalkPreviewMessageCalls =
        (previewWindow.__dingtalkPreviewMessageCalls ?? 0) + 1;
      await sleep(messageDelay);
      const all = messagesFor(params.conversationId);
      const limit = params.limit ?? 40;
      const eligible =
        params.before === undefined
          ? all
          : all.filter((message) => message.createdAt < (params.before ?? 0));
      const page = eligible.slice(-limit);
      const hasMore = eligible.length > page.length;
      const conversation =
        conversations.find((row) => row.conversationId === params.conversationId) ?? null;
      return {
        available: true,
        conversation: conversation ? { ...conversation } : null,
        messages: (options.duplicateMessages ? [...page, ...page, ...page] : [...page]).reverse(),
        hasMore,
        nextCursor: page[0]?.createdAt ?? null,
        cachedAt: Date.now(),
        errorCode: null,
      };
    },
    async send(params): Promise<DingTalkSendResult> {
      await sleep(320);
      options.onSend?.(params);
      const all = messagesFor(params.conversationId);
      const sentAt = Math.max(Date.now(), (all.at(-1)?.createdAt ?? 0) + 1);
      all.push({
        messageId: `sent-${sentAt}`,
        conversationId: params.conversationId,
        senderName: options.sendEcho ? "许涛" : "我",
        senderId: "me",
        createdAt: sentAt,
        text: params.text,
        unsupported: false,
        mine: true,
      });
      const conversation = conversations.find(
        (row) => row.conversationId === params.conversationId,
      );
      if (conversation) {
        conversation.lastMessageAt = sentAt;
        conversation.preview = `我：${params.text}`;
      }
      if (options.sendEcho === "before") {
        for (let index = 0; index < 5; index += 1)
          for (const listener of listeners) listener(params.conversationId);
        await sleep(350);
      } else if (options.sendEcho === "after") {
        setTimeout(() => {
          for (const listener of listeners) listener(params.conversationId);
        }, 50);
      }
      return {
        ok: true,
        messageId: options.sendEcho === "before" ? null : `sent-${sentAt}`,
        sentAt,
        errorCode: null,
      };
    },
    async members() {
      await sleep(80);
      return {
        available: true,
        members: groupMembers.map((member) => ({ ...member })),
        errorCode: null,
      };
    },
    async resource(params): Promise<DingTalkResourceResult> {
      await sleep(20);
      if (params.resourceId === "media-preview-missing") {
        return {
          available: false,
          dataUrl: null,
          mimeType: null,
          sizeBytes: null,
          errorCode: "download_failed",
        };
      }
      return {
        available: true,
        dataUrl: previewImageDataUrl,
        mimeType: "image/png",
        sizeBytes: 6800,
        errorCode: null,
      };
    },
    async search(params): Promise<DingTalkSearchResult> {
      await sleep(180);
      const query = params.query.trim().toLowerCase();
      const local = conversations
        .filter((row) => `${row.title} ${row.preview ?? ""}`.toLowerCase().includes(query))
        .map((row) => ({ ...row }));
      const groups = remoteSearchGroups
        .filter((row) => row.title.toLowerCase().includes(query))
        .map((row) => ({ ...row }));
      const people = remoteSearchPeople
        .filter((row) => row.name.toLowerCase().includes(query))
        .map((row) => {
          const conversation = conversations.find(
            (item) => item.conversationId === row.conversationId,
          );
          return {
            ...(conversation ?? {
              conversationId: row.conversationId,
              title: row.name,
              singleChat: true,
              unreadCount: 0,
              lastMessageAt: null,
              muted: false,
            }),
            subtitle: row.title,
          };
        });
      const merged = [...local, ...groups, ...people].filter(
        (row, index, all) =>
          all.findIndex((item) => item.conversationId === row.conversationId) === index,
      );
      const matchedMessages: DingTalkMessage[] = [];
      for (const conversation of [...conversations, ...remoteSearchGroups]) {
        for (const message of messagesFor(conversation.conversationId)) {
          if (`${message.text} ${message.cardTitle ?? ""}`.toLowerCase().includes(query)) {
            matchedMessages.push(message);
          }
        }
      }
      matchedMessages.sort((left, right) => right.createdAt - left.createdAt);
      return {
        available: true,
        conversations: merged.slice(0, 20),
        messages: matchedMessages.slice(0, 24),
        errorCode: null,
      };
    },
    async resolve(conversationId, messageIds): Promise<DingTalkResolveResult> {
      const all = messagesFor(conversationId);
      const selected = messageIds?.length
        ? all.filter((message) => messageIds.includes(message.messageId))
        : all.slice(-30);
      return {
        available: true,
        conversation: conversations.find((row) => row.conversationId === conversationId) ?? null,
        messages: selected,
        errorCode: null,
      };
    },
    async markViewed(conversationId, _lastMessageAt, isActive) {
      if (!options.liveUnread) return;
      const open = isActive !== false;
      options.onViewed?.(conversationId, open);
      if (open) {
        active.add(conversationId);
      } else {
        active.delete(conversationId);
        viewed.add(conversationId);
      }
      for (const callback of listeners) callback(conversationId);
    },
    subscribe(listener) {
      listeners.add(listener);
      if (options.pushChangeAfterMs !== undefined) {
        setTimeout(() => {
          const row = conversations.find((item) => item.unreadCount > 0);
          if (!row) return;
          const createdAt = Date.now();
          row.unreadCount += 1;
          row.lastMessageAt = createdAt;
          row.preview = "林晓：刚刚收到一条新消息。";
          messagesFor(row.conversationId).push({
            messageId: `preview-live-${createdAt}`,
            conversationId: row.conversationId,
            senderName: "林晓",
            senderId: "preview-lin",
            createdAt,
            text: "刚刚收到一条新消息。",
            unsupported: false,
            mine: false,
          });
          for (let index = 0; index < (options.changeRepeats ?? 1); index += 1)
            for (const callback of listeners) callback(row.conversationId);
        }, options.pushChangeAfterMs);
      }
      return () => listeners.delete(listener);
    },
  };
}

export function createFakeCodexAgentsClient(
  options: { withAgents?: boolean; dispatchStatus?: DingTalkDispatchStatus } = {},
): RendererCodexAgentsClient {
  const records: CodexAgentRecord[] =
    options.withAgents === false ? [] : agents.map((row) => ({ ...row }));
  let dispatch: DingTalkDispatchSettings = { ...dispatchSettings };

  const summaries = () =>
    records.map(({ developerInstructions: _instructions, ...summary }) => ({ ...summary }));

  return {
    available: () => true,
    async list(): Promise<CodexAgentListResult> {
      await sleep(60);
      return {
        directory: "/home/ubuntu/.codex/agents",
        agents: summaries(),
        issues: [],
      };
    },
    async read(fileName) {
      await sleep(40);
      const record = records.find((row) => row.fileName === fileName);
      if (!record) throw new Error("not_found");
      return { ...record };
    },
    async save(input: CodexAgentSaveParams) {
      await sleep(120);
      const fileName = input.fileName ?? generateAgentFileName(records);
      const record: CodexAgentRecord = {
        fileName,
        name: input.name,
        description: input.description,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        revision: `${Date.now()}-${input.developerInstructions.length}`,
        developerInstructions: input.developerInstructions,
      };
      const index = records.findIndex((row) => row.fileName === fileName);
      if (index >= 0) records[index] = record;
      else records.push(record);
      return record;
    },
    async remove(fileName) {
      await sleep(120);
      const index = records.findIndex((row) => row.fileName === fileName);
      if (index >= 0) records.splice(index, 1);
    },
    async catalog(): Promise<CodexAgentCatalogResult> {
      return agentCatalog;
    },
    async dispatchStatus() {
      await sleep(30);
      return options.dispatchStatus ?? {};
    },
    async dispatchSettings() {
      await sleep(60);
      return cloneDispatch(dispatch);
    },
    async saveDispatchSettings(settings) {
      // Long enough for the saving state to be visible in a screenshot.
      await sleep(800);
      dispatch = cloneDispatch(settings);
      return cloneDispatch(dispatch);
    },
  };
}

function generateAgentFileName(records: readonly CodexAgentRecord[]): string {
  for (;;) {
    const token = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
    const fileName = `agent-${token}.toml`;
    if (!records.some((record) => record.fileName === fileName)) return fileName;
  }
}

function cloneDispatch(settings: DingTalkDispatchSettings): DingTalkDispatchSettings {
  return {
    threshold: settings.threshold,
    agents: Object.fromEntries(
      Object.entries(settings.agents).map(([fileName, agent]) => [
        fileName,
        { ...agent, eventTypes: [...agent.eventTypes] },
      ]),
    ),
  };
}

export function createFakeJarvisClient(): RendererJarvisClient {
  let hasKey = true;
  const hosts: RendererJarvisHost[] = [
    { hostId: "local", displayName: "本机", local: true, reachable: true },
    { hostId: "host-nl", displayName: "荷兰", local: false, reachable: true },
    { hostId: "host-sh", displayName: "腾讯上海", local: false, reachable: true },
    { hostId: "host-google", displayName: "谷歌主机", local: false, reachable: true },
    { hostId: "host-sg", displayName: "甲骨文新加坡", local: false, reachable: true },
  ];
  const installed: JarvisStatus = {
    installed: true,
    version: "0.20.1",
    platform: "darwin-arm64",
    authenticated: true,
    userName: "示例用户",
    userId: 1,
    errorCode: null,
  };
  const missing: JarvisStatus = {
    installed: false,
    version: null,
    platform: null,
    authenticated: false,
    userName: null,
    userId: null,
    errorCode: null,
  };
  return {
    async hosts() {
      await sleep(30);
      return hosts.map((host) => ({ ...host }));
    },
    localAvailable: () => true,
    async status(hostId) {
      await sleep(30);
      return { ...(hostId === "local" ? installed : missing) };
    },
    async settings() {
      await sleep(30);
      return { hasKey, threshold: 0.5 };
    },
    async updateSettings(input) {
      await sleep(120);
      if (input.geminiApiKey !== undefined) hasKey = input.geminiApiKey !== null;
      return { hasKey, threshold: 0.5 };
    },
    async testSettings() {
      await sleep(120);
      return hasKey
        ? { ok: true, latencyMs: 240, errorCode: null }
        : { ok: false, latencyMs: null, errorCode: "missing_key" };
    },
    async searchBugs() {
      throw new Error("not used in preview");
    },
    async install(hostId) {
      return { state: "installed", status: { ...installed } };
    },
    async login() {
      return {
        authUrl: "",
        callbackPort: 0,
        forwardId: null,
        forwardErrorCode: null,
        close() {},
      };
    },
    stopLogin() {},
  };
}

export { agentSummaries };
