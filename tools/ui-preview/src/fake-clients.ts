import type {
  CodexAgentCatalogResult,
  CodexAgentListResult,
  CodexAgentRecord,
  CodexAgentSaveParams,
  DingTalkConversationsResult,
  DingTalkMessage,
  DingTalkMessagesResult,
  DingTalkResolveResult,
  DingTalkResourceResult,
  DingTalkSearchResult,
  DingTalkSendResult,
  DingTalkSettings,
  DingTalkStatus,
  DingTalkDispatchSettings,
} from "@codexhost/shared-contracts";

import type { RendererCodexAgentsClient } from "../../../packages/renderer-extension/src/renderer-codex-agents-client.js";
import type { RendererDingTalkClient } from "../../../packages/renderer-extension/src/renderer-dingtalk-client.js";
import {
  agentCatalog,
  agentSummaries,
  agents,
  conversations,
  dingTalkSettings,
  dispatchSettings,
  messagesFor,
  previewImageDataUrl,
  remoteSearchGroups,
  remoteSearchPeople,
} from "./fixtures.js";

export interface FakeDingTalkOptions {
  empty?: boolean;
  error?: boolean;
  messageDelayMs?: number;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export function createFakeDingTalkClient(
  options: FakeDingTalkOptions = {},
): RendererDingTalkClient {
  const messageDelay = options.messageDelayMs ?? 120;
  let currentSettings = { ...dingTalkSettings };
  const listeners = new Set<(conversationId: string | null) => void>();

  const conversationsResult = (view: "unread" | "recent"): DingTalkConversationsResult => {
    const rows =
      view === "recent"
        ? conversations.slice(0, 10).map((row) => ({
            ...row,
            unreadCount: 0,
            preview: row.preview?.startsWith("我：") ? row.preview : `我：${row.preview ?? "收到"}`,
          }))
        : conversations.map((row) => ({ ...row }));
    return {
      available: !options.error,
      source: options.empty ? "empty" : view,
      conversations: options.empty || options.error ? [] : rows,
      cachedAt: Date.now(),
      refreshing: false,
      errorCode: options.error ? "cli_failed" : null,
    };
  };

  return {
    available: () => true,
    async status(): Promise<DingTalkStatus> {
      return {
        installed: true,
        authenticated: true,
        userName: "预览用户",
        userId: "user-preview",
        corpName: "示例公司",
        defaultHost: currentSettings.effectiveHost,
        defaultHostId: currentSettings.effectiveHostId,
        errorCode: null,
      };
    },
    async settings(): Promise<DingTalkSettings> {
      return { ...currentSettings, hosts: currentSettings.hosts.map((host) => ({ ...host })) };
    },
    async updateSettings(params) {
      currentSettings = { ...currentSettings, defaultHost: params.defaultHost };
      return currentSettings;
    },
    async conversations(params = {}): Promise<DingTalkConversationsResult> {
      await sleep(40);
      return conversationsResult(params.view ?? "unread");
    },
    async preview(conversationId) {
      await sleep(20);
      const row = conversations.find((item) => item.conversationId === conversationId);
      return {
        available: true,
        preview: row?.preview || "吴菁：这条摘要由可见行懒加载。",
        cachedAt: Date.now(),
        errorCode: null,
      };
    },
    async messages(params): Promise<DingTalkMessagesResult> {
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
        messages: [...page].reverse(),
        hasMore,
        nextCursor: page[0]?.createdAt ?? null,
        cachedAt: Date.now(),
        errorCode: null,
      };
    },
    async send(params): Promise<DingTalkSendResult> {
      await sleep(320);
      const all = messagesFor(params.conversationId);
      const sentAt = Math.max(Date.now(), (all.at(-1)?.createdAt ?? 0) + 1);
      all.push({
        messageId: `sent-${sentAt}`,
        conversationId: params.conversationId,
        senderName: "我",
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
      return { ok: true, messageId: `sent-${sentAt}`, sentAt, errorCode: null };
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
    async markViewed() {
      // Preview fixtures keep unread counts stable for repeatable screenshots.
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createFakeCodexAgentsClient(
  options: { withAgents?: boolean } = {},
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
      const fileName = input.fileName ?? `${input.name}.toml`;
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
    async dispatchSettings() {
      await sleep(60);
      return {
        ...dispatch,
        eventTypes: [...dispatch.eventTypes],
        participatingAgents: [...dispatch.participatingAgents],
      };
    },
    async saveDispatchSettings(settings) {
      // Long enough for the disabled-state screenshot to see the greyed body.
      await sleep(800);
      dispatch = {
        ...settings,
        eventTypes: [...settings.eventTypes],
        participatingAgents: [...settings.participatingAgents],
      };
      return { ...dispatch };
    },
  };
}

export { agentSummaries };
