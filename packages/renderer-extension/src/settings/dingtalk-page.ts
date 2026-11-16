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
import { createDingTalkLightbox, type DingTalkLightboxImage } from "./dingtalk-lightbox.js";
import { startDingTalkPoll } from "./dingtalk-poll.js";
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
      sidebar.append(sidebarHead, conversationList, searchPanel.element);

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
        onImageClick: (message, resource) => openImage(message, resource),
        onRetry: (message) => void deliver(message),
      });

      const composer = createDingTalkComposer({
        document,
        text,
        onSend: (payload) => sendMessage(payload),
        isGroup: () => state.currentConversation?.singleChat === false,
        loadMembers: async () => {
          if (!client || !state.selectedId) {
            return { available: false, members: [], errorCode: "peer_unavailable" };
          }
          return await client.members(state.selectedId);
        },
      });

      main.append(mainHead.element, notice, pane, composer.element);
      root.append(sidebar, pageMenu.element, main);
      context.content.append(root);

      const lightbox = createDingTalkLightbox({
        document,
        host: root,
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
      });

      const conversationImages = (): DingTalkLightboxImage[] =>
        state.messages.flatMap((message) =>
          (message.resources ?? [])
            .filter((resource) => resource.kind === "image")
            .map((resource) => ({ message, resource })),
        );

      function openImage(
        message: ViewMessage,
        resource: NonNullable<ViewMessage["resources"]>[number],
      ): void {
        const all = conversationImages();
        const index = all.findIndex(
          (entry) =>
            entry.message.messageId === message.messageId &&
            entry.resource.resourceId === resource.resourceId,
        );
        lightbox.open(all, index < 0 ? 0 : index);
      }

      const setNotice = (value: string | null): void => {
        notice.hidden = value === null;
        notice.textContent = value ?? "";
      };

      const conversationFor = (conversationId: string): DingTalkConversation | null =>
        state.conversations.find((row) => row.conversationId === conversationId) ??
        state.search?.conversations.find((row) => row.conversationId === conversationId) ??
        null;

      const syncMainVisibility = (): void => {
        main.hidden =
          state.searchQuery.length === 0 &&
          state.conversations.length === 0 &&
          !state.listLoading &&
          !state.listError &&
          state.selectedId === null;
      };

      const syncColumnMode = (): void => {
        const searching = state.searchQuery.length > 0;
        conversationList.hidden = searching;
        searchPanel.element.hidden = !searching;
        syncMainVisibility();
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

      const distanceFromBottom = (): number =>
        messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight;

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
        if (!force && state.selectedId === conversationId && state.messages.length > 0) {
          // Auto-selection and a later click can race; the row is already open,
          // but a stale badge must still be cleared through the same route.
          const existing = conversationFor(conversationId);
          if (existing && (existing.unreadCount > 0 || existing.atMe === true)) {
            const cleared = { ...existing, unreadCount: 0, atMe: false };
            state.currentConversation = cleared;
            state.conversations = state.conversations.map((row) =>
              row.conversationId === conversationId ? cleared : row,
            );
            updateHeader();
            renderList();
            void client.markViewed(
              conversationId,
              existing.lastMessageAt ?? state.messages.at(-1)?.createdAt ?? 0,
              true,
            );
          }
          renderList();
          return;
        }
        if (state.selectedId && state.selectedId !== conversationId) {
          const previous = conversationFor(state.selectedId);
          void client.markViewed(
            state.selectedId,
            previous?.lastMessageAt ?? state.messages.at(-1)?.createdAt ?? 0,
            false,
          );
        }
        mainHead.closeMenu();
        state.selectedId = conversationId;
        state.currentConversation = conversationFor(conversationId);
        // The row must lose its badge before the messages arrive; the Host
        // keeps it in the unread column while this page stays open.
        const opening = state.currentConversation;
        if (opening && (opening.unreadCount > 0 || opening.atMe === true)) {
          const cleared = { ...opening, unreadCount: 0, atMe: false };
          state.currentConversation = cleared;
          state.conversations = state.conversations.map((row) =>
            row.conversationId === conversationId ? cleared : row,
          );
          void client.markViewed(conversationId, opening.lastMessageAt ?? 0, true);
        }
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
        composer.reset();
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
          const viewed: DingTalkConversation = {
            ...result.conversation,
            unreadCount: 0,
            atMe: false,
          };
          state.currentConversation = viewed;
          state.conversations = state.conversations.map((row) =>
            row.conversationId === conversationId ? { ...row, ...viewed } : row,
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
        if (newest) void client.markViewed(conversationId, newest.createdAt, true);
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
        if (newest) void client.markViewed(conversationId, newest.createdAt, true);
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
          if (state.selectedId) {
            const previous = conversationFor(state.selectedId);
            void client.markViewed(
              state.selectedId,
              state.messages.at(-1)?.createdAt ?? previous?.lastMessageAt ?? 0,
              false,
            );
          }
          const target = rememberedConversation();
          state.selectedId = null;
          state.currentConversation = null;
          state.messages = [];
          composer.reset();
          updateHeader();
          renderMessages();
          renderList();
          if (target) void selectConversation(target);
          return;
        }
        renderList();
        if (state.conversations.length === 0) {
          if (state.selectedId) {
            void client.markViewed(
              state.selectedId,
              state.messages.at(-1)?.createdAt ?? state.currentConversation?.lastMessageAt ?? 0,
              false,
            );
          }
          state.selectedId = null;
          state.currentConversation = null;
          state.messages = [];
          composer.reset();
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
        const result = await client
          .send({
            conversationId,
            text: message.sendText ?? message.text,
            ...(message.atOpenDingTalkIds && message.atOpenDingTalkIds.length > 0
              ? { atOpenDingTalkIds: message.atOpenDingTalkIds }
              : {}),
            ...(message.atAll === true ? { atAll: true } : {}),
          })
          .catch(() => null);
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

      const sendMessage = (payload: {
        text: string;
        displayText: string;
        atOpenDingTalkIds: string[];
        atAll: boolean;
      }): void => {
        if (state.selectedId === null) return;
        const pending: ViewMessage = {
          messageId: `local-${Date.now()}`,
          conversationId: state.selectedId,
          senderName: "我",
          senderId: "me",
          createdAt: Date.now(),
          text: payload.displayText,
          unsupported: false,
          mine: true,
          pending: true,
          sendText: payload.text,
          ...(payload.atOpenDingTalkIds.length > 0
            ? { atOpenDingTalkIds: payload.atOpenDingTalkIds }
            : {}),
          ...(payload.atAll ? { atAll: true } : {}),
        };
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
        if (distanceFromBottom() <= 80 && state.pendingNewCount > 0) {
          state.pendingNewCount = 0;
          renderPill();
        }
      });
      messageList.addEventListener("wheel", () => {
        if (distanceFromBottom() <= 80 && state.pendingNewCount > 0) {
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
        // Event.target is retargeted to the shadow host for this document-level
        // listener; composedPath keeps the real menu nodes visible.
        const path = event.composedPath();
        const inside = (menu: { contains(node: Node): boolean }): boolean =>
          path.some((node) => node instanceof Node && menu.contains(node));
        if (mainHead.menuOpen && !inside(mainHead)) mainHead.closeMenu();
        if (!pageMenu.open) return;
        if (inside(pageMenu)) return;
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
        client?.subscribe(() => {
          if (disposed) return;
          void loadConversations().then(() => {
            // A coalesced notification carries one id, but the list refresh is
            // global; refresh whatever transcript is open now.
            if (state.selectedId) void refreshLatest(state.selectedId);
          });
        }) ?? (() => undefined);

      const poll = startDingTalkPoll({
        isVisible: () =>
          !disposed && document.visibilityState !== "hidden" && state.searchQuery.length === 0,
        pollConversation: () => {
          const conversationId = state.selectedId;
          if (!conversationId || state.loadingMessages) return;
          return refreshLatest(conversationId);
        },
        pollList: () => loadConversations(),
      });
      const onVisibility = (): void => {
        if (document.visibilityState === "visible") poll.pollNow();
      };
      document.addEventListener("visibilitychange", onVisibility);

      updateHeader();
      renderMessages();
      void loadStatus();
      void loadConversations().then(() => {
        const pending = consumeDingTalkReveal();
        if (pending?.conversationId) void revealTarget(pending);
      });

      return () => {
        disposed = true;
        poll.stop();
        document.removeEventListener("visibilitychange", onVisibility);
        lightbox.dispose();
        composer.dispose();
        if (client && state.selectedId) {
          const row = conversationFor(state.selectedId);
          void client.markViewed(
            state.selectedId,
            state.messages.at(-1)?.createdAt ?? row?.lastMessageAt ?? 0,
            false,
          );
        }
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
