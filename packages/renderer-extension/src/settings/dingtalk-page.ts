import SearchIcon from "lucide/dist/esm/icons/search.mjs";
import XIcon from "lucide/dist/esm/icons/x.mjs";

import type { DingTalkConversation, DingTalkMention } from "@codexhost/shared-contracts";

import type { RendererDingTalkClient } from "../renderer-dingtalk-client.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsLocale, RendererSettingsMessages } from "./localization.js";
import {
  conversationMention,
  type DingTalkPageState,
  type ViewMessage,
} from "./dingtalk-page-model.js";
import {
  createElementNode,
  createIcon,
  createIconButton,
  createListEmpty,
  createListSkeleton,
  createMessageSkeleton,
  createOlderMessagesSkeleton,
} from "./dingtalk-page-view.js";
import { createDingTalkConversationList } from "./dingtalk-conversation-list.js";
import { createDingTalkMessageList } from "./dingtalk-message-list.js";
import { createDingTalkComposer } from "./dingtalk-composer.js";
import { createDingTalkMainHeader } from "./dingtalk-main-header.js";
import { createDingTalkPageMenu } from "./dingtalk-page-menu.js";
import { consumeDingTalkReveal, type DingTalkRevealTarget } from "./dingtalk-reveal.js";
import { createDingTalkSearchPanel } from "./dingtalk-search-panel.js";
import { dingtalkPageStrings } from "./dingtalk-page-strings.js";

/**
 * Chat state machine for the DingTalk workbench. DOM builders live in
 * dingtalk-page-view, -menu, -composer and -search-panel; the transcript and
 * conversation column own their incremental rendering.
 */
const SEARCH_DEBOUNCE_MS = 450;
const HIGHLIGHT_MS = 2_500;
const INITIAL_MESSAGE_LIMIT = 30;
const OLDER_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_WINDOW = 200;
const PREVIEW_CONCURRENCY = 3;
const LAST_CONVERSATION_KEY = "codexhost.dingtalk.lastConversation.unread";
const LEGACY_CONVERSATION_KEY = "codexhost.dingtalk.lastConversation";

export interface RendererDingTalkPageOptions {
  createClient(): RendererDingTalkClient | null;
  readLocale(): RendererSettingsLocale;
  /** Embeds a mention into the Composer that opened the workbench. */
  embed(mention: DingTalkMention): Promise<boolean> | boolean;
}

export function createDingTalkSettingsPage(
  messages: RendererSettingsMessages,
  options: RendererDingTalkPageOptions,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "dingtalk",
    label: messages.pageLabels.dingtalk,
    icon: "routes",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const view = document.defaultView ?? window;
      const locale = options.readLocale();
      const client = options.createClient();
      client?.beginSession();
      const text = dingtalkPageStrings(locale);
      const state: DingTalkPageState = {
        source: "empty",
        conversations: [],
        selectedId: null,
        currentConversation: null,
        messages: [],
        hasMore: false,
        nextCursor: null,
        search: null,
        searchQuery: "",
        searchPending: false,
        searchFailed: false,
        listError: false,
        listLoading: true,
        loadingMessages: false,
        messagesError: false,
        loadMoreError: false,
        pendingNewCount: 0,
      };
      let disposed = false;
      let listGeneration = 0;
      let messageGeneration = 0;
      let searchGeneration = 0;
      let searchTimer: number | null = null;
      let highlightTimer: number | null = null;
      let scrollRequest = 0;
      let searchExpanded = { conversations: false, messages: false };
      let searchCursor = -1;
      let loadingOlderRequest = false;
      const previews = new Map<string, string | null>();
      const previewQueue: string[] = [];
      const previewPending = new Set<string>();
      let previewActive = 0;

      const root = createElementNode(document, "div", "dingtalk-workbench");

      const sidebar = createElementNode(document, "aside", "dingtalk-sidebar");
      const sidebarHead = createElementNode(document, "div", "dingtalk-sidebar-head");
      const searchBox = createElementNode(document, "div", "dingtalk-search");
      searchBox.append(createIcon(document, SearchIcon, 15, "dingtalk-search-icon"));
      const searchInput = createElementNode(document, "input", "dingtalk-search-input");
      searchInput.type = "search";
      searchInput.placeholder = text.searchPlaceholder;
      searchInput.autocomplete = "off";
      searchInput.spellcheck = false;
      const clearSearchButton = createIconButton(document, text.clearSearch, XIcon, {
        className: "dingtalk-search-clear",
        size: 14,
      });
      clearSearchButton.hidden = true;
      searchBox.append(searchInput, clearSearchButton);
      const pageMenu = createDingTalkPageMenu({
        document,
        text,
        onRefresh: () => void loadConversations(),
        onRetry: () => {
          void loadStatus();
          void loadConversations();
        },
      });
      sidebarHead.append(searchBox, pageMenu.moreButton);

      const conversationList = createElementNode(document, "div", "dingtalk-conversation-list");
      conversationList.setAttribute("role", "listbox");
      conversationList.setAttribute("aria-label", text.brand);
      const conversationRows = createDingTalkConversationList({
        document,
        container: conversationList,
        text,
        onSelect: (conversationId) => void selectConversation(conversationId),
      });
      const searchPanel = createDingTalkSearchPanel({
        document,
        text,
        conversationTitle: (conversationId) =>
          conversationFor(conversationId)?.title || text.unnamed,
        openConversation: (conversationId) => void selectConversation(conversationId),
        openMessage: (conversationId, messageId) =>
          void revealTarget({ conversationId, messageIds: [messageId] }),
        retry: () => void runSearch(state.searchQuery),
        expand: (kind) => {
          searchExpanded[kind] = true;
          renderSearch();
        },
      });
      const searchHint = createElementNode(
        document,
        "div",
        "dingtalk-search-hint",
        text.searchKeyboardHint,
      );
      searchHint.hidden = true;
      sidebar.append(sidebarHead, conversationList, searchPanel.element, searchHint);

      const main = createElementNode(document, "section", "dingtalk-main");
      const mainHead = createDingTalkMainHeader({
        document,
        text,
        onEmbed: () => {
          if (!state.selectedId) return;
          void embed(conversationMention(state.currentConversation, state.selectedId));
        },
        onRefresh: () => {
          if (state.selectedId) void selectConversation(state.selectedId, true);
        },
      });

      const notice = createElementNode(document, "div", "dingtalk-main-notice");
      notice.hidden = true;

      const pane = createElementNode(document, "div", "dingtalk-message-pane");
      const messageList = createElementNode(document, "div", "dingtalk-message-list");
      messageList.setAttribute("role", "log");
      messageList.setAttribute("aria-live", "polite");
      const mainState = createElementNode(document, "div", "dingtalk-main-state");
      const loadingOlder = createElementNode(document, "div", "dingtalk-loading-older");
      loadingOlder.hidden = true;
      loadingOlder.append(createOlderMessagesSkeleton(document));
      const newPill = document.createElement("button");
      newPill.type = "button";
      newPill.className = "dingtalk-new-messages";
      newPill.hidden = true;
      pane.append(messageList, mainState, newPill);

      const messageListView = createDingTalkMessageList({
        document,
        container: messageList,
        text,
        loadResource: async (message, resource) => {
          if (!client) {
            return {
              available: false,
              dataUrl: null,
              mimeType: null,
              sizeBytes: null,
              errorCode: "peer_unavailable",
            };
          }
          return await client.resource({
            conversationId: message.conversationId,
            messageId: message.messageId,
            resourceId: resource.resourceId,
            resourceIdType: resource.resourceIdType,
          });
        },
        onImageLoaded: (wasNearBottom) => {
          if (wasNearBottom) scrollToBottom();
        },
        onRetry: (message) => void deliver(message),
      });

      const composer = createDingTalkComposer({
        document,
        text,
        onSend: () => sendMessage(),
      });

      main.append(mainHead.element, notice, pane, composer.element);
      root.append(sidebar, pageMenu.element, main);
      context.content.append(root);

      const setNotice = (value: string | null): void => {
        notice.hidden = value === null;
        notice.textContent = value ?? "";
      };

      const conversationFor = (conversationId: string): DingTalkConversation | null =>
        state.conversations.find((row) => row.conversationId === conversationId) ??
        state.search?.conversations.find((row) => row.conversationId === conversationId) ??
        null;

      const syncColumnMode = (): void => {
        const searching = state.searchQuery.length > 0;
        conversationList.hidden = searching;
        searchPanel.element.hidden = !searching;
        searchHint.hidden = !searching;
      };

      const applySearchCursor = (): void => {
        const rows = [
          ...searchPanel.element.querySelectorAll<HTMLButtonElement>(".dingtalk-search-result"),
        ];
        if (searchCursor >= rows.length) searchCursor = rows.length - 1;
        rows.forEach((row, index) => {
          row.classList.toggle("dingtalk-search-result--cursor", index === searchCursor);
        });
        if (searchCursor >= 0) rows[searchCursor]?.scrollIntoView({ block: "nearest" });
      };

      const applyPreview = (conversationId: string, preview: string | null): void => {
        previews.set(conversationId, preview);
        const row = state.conversations.find(
          (conversation) => conversation.conversationId === conversationId,
        );
        if (row) row.preview = preview ?? undefined;
        const target = conversationList.querySelector<HTMLElement>(
          `[data-conversation-id="${CSS.escape(conversationId)}"] .dingtalk-conversation-preview`,
        );
        if (target) target.textContent = preview ?? "";
      };

      const pumpPreviews = (): void => {
        while (previewActive < PREVIEW_CONCURRENCY && previewQueue.length > 0) {
          const conversationId = previewQueue.shift();
          if (!conversationId || previewPending.has(conversationId)) continue;
          previewPending.add(conversationId);
          previewActive += 1;
          void (async () => {
            const result = await client?.preview(conversationId).catch(() => null);
            if (disposed) return;
            applyPreview(conversationId, result?.preview ?? null);
          })().finally(() => {
            previewPending.delete(conversationId);
            previewActive -= 1;
            if (!disposed) pumpPreviews();
          });
        }
      };

      const requestPreview = (conversationId: string): void => {
        if (!client || previews.has(conversationId) || previewPending.has(conversationId)) return;
        previewQueue.push(conversationId);
        pumpPreviews();
      };

      const previewObserver =
        typeof IntersectionObserver === "undefined"
          ? null
          : new IntersectionObserver(
              (entries) => {
                for (const entry of entries) {
                  if (!entry.isIntersecting) continue;
                  const conversationId = (entry.target as HTMLElement).dataset.conversationId;
                  if (!conversationId) continue;
                  previewObserver?.unobserve(entry.target);
                  requestPreview(conversationId);
                }
              },
              { root: conversationList, rootMargin: "48px" },
            );

      const renderList = (): void => {
        if (state.listError) {
          conversationRows.clear();
          conversationList.replaceChildren(
            createListEmpty(document, text.listFailedReason, {
              label: text.retry,
              onClick: () => void loadConversations(),
            }),
          );
          syncColumnMode();
          return;
        }
        if (state.listLoading && state.conversations.length === 0) {
          conversationRows.clear();
          conversationList.replaceChildren(createListSkeleton(document));
          syncColumnMode();
          return;
        }
        conversationRows.render(state.conversations, state.selectedId);
        for (const conversation of state.conversations) {
          if (previews.has(conversation.conversationId)) continue;
          const row = conversationRows.elementFor(conversation.conversationId);
          if (!row) continue;
          if (!conversation.preview && previewObserver) previewObserver.observe(row);
          else if (!conversation.preview) requestPreview(conversation.conversationId);
        }
        if (state.conversations.length === 0) {
          conversationList.append(createListEmpty(document, text.noUnreadConversations));
        }
        syncColumnMode();
      };

      const renderSearch = (): void => {
        searchPanel.render({
          query: state.searchQuery,
          pending: state.searchPending,
          failed: state.searchFailed,
          result: state.search,
          expanded: searchExpanded,
        });
        searchCursor = -1;
        applySearchCursor();
        syncColumnMode();
      };

      const renderMainState = (content: HTMLElement | null): void => {
        mainState.replaceChildren();
        mainState.hidden = content === null;
        messageList.hidden = content !== null;
        if (content) mainState.append(content);
      };

      const updateHeader = (): void => {
        const conversation = state.currentConversation;
        mainHead.setConversation(conversation);
        composer.setPlaceholder(conversation?.title || "");
      };

      const distanceFromBottom = (): number => messageList.scrollHeight - messageList.scrollTop;

      const scrollToBottom = (): void => {
        const request = ++scrollRequest;
        messageList.scrollTop = messageList.scrollHeight;
        view.requestAnimationFrame(() => {
          if (!disposed && request === scrollRequest) {
            messageList.scrollTop = messageList.scrollHeight;
          }
        });
      };

      const renderPill = (): void => {
        newPill.hidden = state.pendingNewCount === 0;
        newPill.textContent = `↓ ${text.newMessages.replace(
          "{count}",
          String(state.pendingNewCount),
        )}`;
      };

      const renderMessages = (behavior?: { scroll?: "bottom"; distance?: number }): void => {
        if (state.selectedId === null) {
          messageListView.clear();
          renderMainState(createListEmpty(document, text.emptyMessages));
          renderPill();
          return;
        }
        if (state.loadingMessages) {
          messageListView.clear();
          renderMainState(createMessageSkeleton(document));
          renderPill();
          return;
        }
        if (state.messagesError) {
          messageListView.clear();
          renderMainState(
            createListEmpty(document, text.messagesFailed, {
              label: text.retry,
              onClick: () => void selectConversation(state.selectedId ?? "", true),
            }),
          );
          renderPill();
          return;
        }
        renderMainState(null);
        messageListView.reset(state.messages, behavior);
        if (state.messages.length === 0) {
          messageList.append(
            createElementNode(document, "div", "dingtalk-message-empty", text.emptyMessages),
          );
        }
        if (state.loadMoreError) {
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "dingtalk-load-more-error";
          retry.textContent = text.loadMoreFailed;
          retry.addEventListener("click", () => void loadOlder(true));
          messageList.prepend(retry);
        }
        renderPill();
      };

      const selectConversation = async (conversationId: string, force = false): Promise<void> => {
        if (!client) return;
        if (!force && state.selectedId === conversationId && state.messages.length > 0) return;
        mainHead.closeMenu();
        state.selectedId = conversationId;
        state.currentConversation = conversationFor(conversationId);
        try {
          view.localStorage.setItem(LAST_CONVERSATION_KEY, conversationId);
        } catch {
          /* Persisting the last conversation is best effort. */
        }
        state.messages = [];
        state.hasMore = false;
        state.nextCursor = null;
        state.loadingMessages = true;
        state.messagesError = false;
        state.loadMoreError = false;
        state.pendingNewCount = 0;
        updateHeader();
        renderList();
        renderMessages();
        const generation = ++messageGeneration;
        const result = await client
          .messages({ conversationId, limit: INITIAL_MESSAGE_LIMIT })
          .catch(() => null);
        if (disposed || generation !== messageGeneration || state.selectedId !== conversationId)
          return;
        state.loadingMessages = false;
        if (!result) {
          state.messagesError = true;
          renderMessages();
          return;
        }
        if (result.conversation) {
          state.currentConversation = result.conversation;
          state.conversations = state.conversations.map((row) =>
            row.conversationId === conversationId ? { ...row, ...result.conversation } : row,
          );
        }
        state.messages = [...result.messages].sort(
          (left, right) => left.createdAt - right.createdAt,
        );
        state.hasMore = result.hasMore;
        state.nextCursor = result.nextCursor;
        state.messagesError = result.errorCode !== null && state.messages.length === 0;
        updateHeader();
        renderMessages({ scroll: "bottom" });
        const newest = state.messages.at(-1);
        if (newest) void client.markViewed(conversationId, newest.createdAt);
      };

      const loadOlder = async (force = false): Promise<void> => {
        if (
          !client ||
          state.selectedId === null ||
          !state.hasMore ||
          state.nextCursor === null ||
          state.loadingMessages ||
          loadingOlderRequest ||
          (state.loadMoreError && !force)
        ) {
          return;
        }
        const conversationId = state.selectedId;
        const cursor = state.nextCursor;
        const generation = messageGeneration;
        const distance = distanceFromBottom();
        loadingOlderRequest = true;
        loadingOlder.hidden = false;
        messageList.prepend(loadingOlder);
        const result = await client
          .messages({ conversationId, before: cursor, limit: OLDER_MESSAGE_LIMIT })
          .catch(() => null);
        loadingOlder.remove();
        loadingOlder.hidden = true;
        loadingOlderRequest = false;
        if (disposed || generation !== messageGeneration || state.selectedId !== conversationId) {
          return;
        }
        if (!result) {
          state.loadMoreError = true;
          renderMessages({ distance });
          return;
        }
        const known = new Set(state.messages.map((message) => message.messageId));
        const older = result.messages
          .filter((message) => !known.has(message.messageId))
          .sort((left, right) => left.createdAt - right.createdAt);
        const merged = new Map<string, ViewMessage>();
        for (const message of [...state.messages, ...result.messages]) {
          merged.set(message.messageId, message);
        }
        state.messages = [...merged.values()].sort(
          (left, right) => left.createdAt - right.createdAt,
        );
        const overflow = Math.max(0, state.messages.length - MAX_MESSAGE_WINDOW);
        if (overflow > 0) {
          state.messages = state.messages.slice(0, -overflow);
          messageListView.removeNewest(overflow);
        }
        if (older.length > 0) messageListView.prepend(older);
        messageList.scrollTop = messageList.scrollHeight - distance;
        state.hasMore = result.hasMore;
        state.nextCursor = result.nextCursor;
        state.loadMoreError = false;
        renderPill();
      };

      const refreshLatest = async (conversationId: string): Promise<void> => {
        if (!client) return;
        const generation = messageGeneration;
        const known = new Set(state.messages.map((message) => message.messageId));
        const nearBottom = distanceFromBottom() <= 80;
        const result = await client
          .messages({ conversationId, limit: INITIAL_MESSAGE_LIMIT })
          .catch(() => null);
        if (
          disposed ||
          generation !== messageGeneration ||
          state.selectedId !== conversationId ||
          !result
        ) {
          return;
        }
        const merged = new Map<string, ViewMessage>();
        for (const message of [...state.messages, ...result.messages]) {
          merged.set(message.messageId, message);
        }
        if (result.conversation) {
          state.currentConversation = result.conversation;
          updateHeader();
        }
        const fresh = result.messages
          .filter((message) => !known.has(message.messageId))
          .sort((left, right) => left.createdAt - right.createdAt);
        state.messages = [...merged.values()].sort(
          (left, right) => left.createdAt - right.createdAt,
        );
        const overflow = Math.max(0, state.messages.length - MAX_MESSAGE_WINDOW);
        if (overflow > 0) {
          state.messages = state.messages.slice(overflow);
          messageListView.removeOldest(overflow);
        }
        if (fresh.length > 0) messageListView.append(fresh);
        if (nearBottom) {
          scrollToBottom();
        } else {
          state.pendingNewCount += fresh.length;
          renderPill();
        }
        const newest = state.messages.at(-1);
        if (newest) void client.markViewed(conversationId, newest.createdAt);
      };

      const rememberedConversation = (): string | null => {
        for (const key of [LAST_CONVERSATION_KEY, LEGACY_CONVERSATION_KEY]) {
          let remembered: string | null = null;
          try {
            remembered = view.localStorage.getItem(key);
          } catch {
            remembered = null;
          }
          const found = remembered
            ? state.conversations.find((row) => row.conversationId === remembered)
            : undefined;
          if (found) return found.conversationId;
        }
        return state.conversations[0]?.conversationId ?? null;
      };

      const loadConversations = async (): Promise<void> => {
        if (!client) {
          state.listError = true;
          state.listLoading = false;
          renderList();
          return;
        }
        const generation = ++listGeneration;
        state.listLoading = true;
        if (state.conversations.length === 0) renderList();
        const result = await client.conversations().catch(() => null);
        if (disposed || generation !== listGeneration) return;
        state.listLoading = false;
        if (!result) {
          state.listError = true;
          renderList();
          void loadStatus();
          return;
        }
        state.conversations = result.conversations.map((conversation) => ({
          ...conversation,
          ...(previews.has(conversation.conversationId) && !conversation.preview
            ? { preview: previews.get(conversation.conversationId) ?? undefined }
            : {}),
        }));
        state.source = result.source;
        state.listError = !result.available;
        if (!result.available) void loadStatus();
        let choose = state.selectedId === null;
        if (!choose && state.selectedId) {
          const selected = conversationFor(state.selectedId);
          if (selected) {
            state.currentConversation = selected;
            updateHeader();
          } else {
            choose = true;
          }
        }
        if (choose) {
          const target = rememberedConversation();
          state.selectedId = null;
          state.currentConversation = null;
          state.messages = [];
          updateHeader();
          renderMessages();
          renderList();
          if (target) void selectConversation(target);
          return;
        }
        renderList();
        if (state.conversations.length === 0) {
          state.selectedId = null;
          state.currentConversation = null;
          state.messages = [];
          updateHeader();
          renderMessages();
        }
      };

      const runSearch = async (query: string): Promise<void> => {
        if (!client) return;
        const normalized = query.trim();
        if (!normalized) {
          clearSearch();
          return;
        }
        const generation = ++searchGeneration;
        state.searchPending = true;
        state.searchFailed = false;
        state.search = null;
        searchExpanded = { conversations: false, messages: false };
        searchCursor = -1;
        renderSearch();
        const result = await client.search({ query: normalized }).catch(() => null);
        if (disposed || generation !== searchGeneration) return;
        state.searchPending = false;
        if (!result) {
          state.searchFailed = true;
          state.search = null;
        } else {
          state.search = result;
          state.searchFailed = false;
        }
        renderSearch();
      };

      const clearSearch = (): void => {
        searchGeneration += 1;
        if (searchTimer !== null) {
          view.clearTimeout(searchTimer);
          searchTimer = null;
        }
        state.searchQuery = "";
        state.search = null;
        state.searchPending = false;
        state.searchFailed = false;
        searchExpanded = { conversations: false, messages: false };
        searchCursor = -1;
        searchInput.value = "";
        clearSearchButton.hidden = true;
        renderSearch();
      };

      const revealTarget = async (target: DingTalkRevealTarget): Promise<void> => {
        if (target.conversationId) await selectConversation(target.conversationId);
        const ids = target.messageIds ?? [];
        const first = ids[0];
        if (!first) return;
        let row = messageList.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(first)}"]`,
        );
        for (let attempt = 0; attempt < 8 && !row && state.hasMore; attempt += 1) {
          await loadOlder();
          row = messageList.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(first)}"]`);
        }
        if (!row) {
          setNotice(text.notLoaded);
          return;
        }
        row.scrollIntoView({ block: "center" });
        row.classList.add("dingtalk-message--highlight");
        if (highlightTimer !== null) view.clearTimeout(highlightTimer);
        highlightTimer = view.setTimeout(() => {
          row?.classList.remove("dingtalk-message--highlight");
        }, HIGHLIGHT_MS);
      };

      const deliver = async (message: ViewMessage): Promise<void> => {
        if (!client || state.selectedId === null) return;
        const conversationId = state.selectedId;
        const previousId = message.messageId;
        message.pending = true;
        message.failed = false;
        messageListView.update(message, previousId);
        const result = await client.send({ conversationId, text: message.text }).catch(() => null);
        if (disposed || state.selectedId !== conversationId) return;
        message.pending = false;
        if (!result?.ok) {
          message.failed = true;
          messageListView.update(message, previousId);
          return;
        }
        message.messageId = result.messageId ?? message.messageId;
        message.createdAt = result.sentAt;
        if (state.currentConversation) {
          state.currentConversation.lastMessageAt = result.sentAt;
          state.currentConversation.preview = `我：${message.text}`;
        }
        state.conversations = state.conversations.map((row) =>
          row.conversationId === conversationId
            ? { ...row, lastMessageAt: result.sentAt, preview: `我：${message.text}` }
            : row,
        );
        previews.set(conversationId, `我：${message.text}`);
        messageListView.update(message, previousId);
        scrollToBottom();
        renderList();
      };

      const sendMessage = (): void => {
        const value = composer.value();
        if (!value || state.selectedId === null) return;
        const pending: ViewMessage = {
          messageId: `local-${Date.now()}`,
          conversationId: state.selectedId,
          senderName: "我",
          senderId: "me",
          createdAt: Date.now(),
          text: value,
          unsupported: false,
          mine: true,
          pending: true,
        };
        composer.clear();
        const overflow = Math.max(0, state.messages.length + 1 - MAX_MESSAGE_WINDOW);
        if (overflow > 0) {
          state.messages.splice(0, overflow);
          messageListView.removeOldest(overflow);
        }
        state.messages.push(pending);
        messageListView.append([pending]);
        scrollToBottom();
        void deliver(pending);
      };

      const embed = async (mention: DingTalkMention): Promise<void> => {
        const done = await options.embed(mention);
        if (!done) setNotice(text.embedFailed);
      };

      const loadStatus = async (): Promise<void> => {
        if (!client) {
          pageMenu.setStatus(null);
          return;
        }
        const status = await client.status().catch(() => null);
        if (!disposed) pageMenu.setStatus(status);
      };

      searchInput.addEventListener("input", () => {
        const query = searchInput.value.trim();
        state.searchQuery = query;
        clearSearchButton.hidden = query.length === 0;
        if (searchTimer !== null) view.clearTimeout(searchTimer);
        if (query.length === 0) {
          clearSearch();
          return;
        }
        state.searchPending = true;
        state.searchFailed = false;
        state.search = null;
        searchExpanded = { conversations: false, messages: false };
        searchCursor = -1;
        renderSearch();
        searchTimer = view.setTimeout(() => {
          searchTimer = null;
          void runSearch(query);
        }, SEARCH_DEBOUNCE_MS);
      });
      searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          clearSearch();
          return;
        }
        const rows = [
          ...searchPanel.element.querySelectorAll<HTMLButtonElement>(".dingtalk-search-result"),
        ];
        if (rows.length === 0) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          searchCursor =
            searchCursor < 0
              ? step > 0
                ? 0
                : rows.length - 1
              : (searchCursor + step + rows.length) % rows.length;
          applySearchCursor();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const index = searchCursor >= 0 ? searchCursor : 0;
          rows[index]?.click();
        }
      });
      clearSearchButton.addEventListener("click", () => {
        clearSearch();
        searchInput.focus();
      });
      messageList.addEventListener("scroll", () => {
        if (messageList.scrollTop < 80) {
          scrollRequest += 1;
          void loadOlder();
        }
        if (distanceFromBottom() <= 4 && state.pendingNewCount > 0) {
          state.pendingNewCount = 0;
          renderPill();
        }
      });
      newPill.addEventListener("click", () => {
        state.pendingNewCount = 0;
        renderPill();
        scrollToBottom();
      });

      const onReveal = (event: Event): void => {
        const detail = (event as CustomEvent<DingTalkRevealTarget>).detail;
        if (detail) void revealTarget(detail);
      };
      const onPointerDown = (event: PointerEvent): void => {
        const target = event.target;
        if (mainHead.menuOpen) {
          if (!(target instanceof Node) || !mainHead.contains(target)) mainHead.closeMenu();
        }
        if (!pageMenu.open) return;
        if (target instanceof Node && pageMenu.contains(target)) return;
        pageMenu.close();
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        if (mainHead.menuOpen) {
          mainHead.closeMenu();
          event.stopPropagation();
          return;
        }
        if (pageMenu.open) {
          pageMenu.close();
          event.stopPropagation();
          return;
        }
        if (state.searchQuery.length > 0) {
          clearSearch();
          event.preventDefault();
          event.stopPropagation();
        }
      };
      view.addEventListener("codexhost:dingtalk-reveal", onReveal);
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKey, true);

      const unsubscribe =
        client?.subscribe((conversationId) => {
          if (disposed) return;
          void loadConversations().then(() => {
            if (conversationId && conversationId === state.selectedId) {
              void refreshLatest(conversationId);
            }
          });
        }) ?? (() => undefined);

      updateHeader();
      renderMessages();
      void loadStatus();
      void loadConversations().then(() => {
        const pending = consumeDingTalkReveal();
        if (pending?.conversationId) void revealTarget(pending);
      });

      return () => {
        disposed = true;
        listGeneration += 1;
        messageGeneration += 1;
        searchGeneration += 1;
        previewObserver?.disconnect();
        previewQueue.length = 0;
        previewPending.clear();
        previews.clear();
        conversationRows.clear();
        messageListView.dispose();
        if (searchTimer !== null) view.clearTimeout(searchTimer);
        if (highlightTimer !== null) view.clearTimeout(highlightTimer);
        unsubscribe();
        client?.endSession();
        view.removeEventListener("codexhost:dingtalk-reveal", onReveal);
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKey, true);
      };
    },
  });
}
