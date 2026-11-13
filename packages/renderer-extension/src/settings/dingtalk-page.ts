import SearchIcon from "lucide/dist/esm/icons/search.mjs";
import XIcon from "lucide/dist/esm/icons/x.mjs";

import type {
  DingTalkConversation,
  DingTalkMention,
  DingTalkMessage,
} from "@codexhost/shared-contracts";

import type { RendererDingTalkClient } from "../renderer-dingtalk-client.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsLocale, RendererSettingsMessages } from "./localization.js";
import {
  continuesDingTalkGroup,
  conversationMention,
  dayKey,
  type DingTalkPageState,
  type ViewMessage,
} from "./dingtalk-page-model.js";
import {
  createConversationRow,
  createDateSeparator,
  createElementNode,
  createIcon,
  createIconButton,
  createListEmpty,
  createMessageRow,
  createMessageSkeleton,
  createOlderMessagesSkeleton,
  createTimeSeparator,
} from "./dingtalk-page-view.js";
import { createDingTalkComposer } from "./dingtalk-composer.js";
import { createDingTalkMainHeader } from "./dingtalk-main-header.js";
import { createDingTalkPageMenu } from "./dingtalk-page-menu.js";
import { consumeDingTalkReveal, type DingTalkRevealTarget } from "./dingtalk-reveal.js";
import { createDingTalkSearchPanel } from "./dingtalk-search-panel.js";
import { dingtalkPageStrings } from "./dingtalk-page-strings.js";

/**
 * Chat state machine for the DingTalk workbench. DOM builders live in
 * dingtalk-page-view, -menu, -composer and -search-panel; the remaining
 * actions share one message/search/selection state, so they stay together.
 */
const SEARCH_DEBOUNCE_MS = 450;
const HIGHLIGHT_MS = 2_500;
const INITIAL_MESSAGE_LIMIT = 30;
const OLDER_MESSAGE_LIMIT = 30;

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
      const text = dingtalkPageStrings(locale);
      const state: DingTalkPageState = {
        source: "empty",
        view: "recent",
        conversations: [],
        selectedId: null,
        currentConversation: null,
        messages: [],
        hasMore: false,
        nextCursor: null,
        selectedMessages: new Set(),
        search: null,
        searchQuery: "",
        searchPending: false,
        searchFailed: false,
        listError: false,
        loadingMessages: false,
        messagesError: false,
        loadMoreError: false,
        pendingNewCount: 0,
      };
      let disposed = false;
      let effectiveHost = "local";
      let listGeneration = 0;
      let messageGeneration = 0;
      let searchGeneration = 0;
      let searchTimer: number | null = null;
      let highlightTimer: number | null = null;
      let scrollRequest = 0;
      let searchExpanded = { conversations: false, messages: false };
      let searchCursor = -1;
      let viewInitialized = false;
      let loadingOlderRequest = false;

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
        onRefresh: () => void loadConversations(true),
        onHostChange: (host) => void changeHost(host),
      });
      sidebarHead.append(searchBox, pageMenu.moreButton);

      const listSwitch = createElementNode(document, "div", "dingtalk-list-switch");
      const unreadButton = createElementNode(document, "button", "dingtalk-list-switch-button");
      unreadButton.type = "button";
      unreadButton.textContent = text.unread;
      const recentButton = createElementNode(document, "button", "dingtalk-list-switch-button");
      recentButton.type = "button";
      recentButton.textContent = text.recentReplied;
      listSwitch.append(unreadButton, recentButton);
      const conversationList = createElementNode(document, "div", "dingtalk-conversation-list");
      conversationList.setAttribute("role", "listbox");
      conversationList.setAttribute("aria-label", text.brand);
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
      sidebar.append(sidebarHead, listSwitch, conversationList, searchPanel.element, searchHint);

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

      const composer = createDingTalkComposer({
        document,
        text,
        onSend: () => sendMessage(),
        onEmbedSelected: () => {
          if (!state.selectedId) return;
          void embed(
            conversationMention(state.currentConversation, state.selectedId, [
              ...state.selectedMessages,
            ]),
          );
        },
        onCancelSelection: () => clearSelection(),
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
        listSwitch.hidden = searching || state.listError;
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

      const renderList = (): void => {
        conversationList.replaceChildren();
        unreadButton.setAttribute("aria-pressed", String(state.view === "unread"));
        recentButton.setAttribute("aria-pressed", String(state.view === "recent"));
        unreadButton.classList.toggle(
          "dingtalk-list-switch-button--active",
          state.view === "unread",
        );
        recentButton.classList.toggle(
          "dingtalk-list-switch-button--active",
          state.view === "recent",
        );
        if (state.listError) {
          conversationList.append(
            createListEmpty(document, text.listFailedReason, {
              label: text.retry,
              onClick: () => void loadConversations(true),
            }),
          );
          syncColumnMode();
          return;
        }
        const rows =
          state.view === "unread"
            ? state.conversations.filter(
                (conversation) => conversation.unreadCount > 0 || conversation.muted,
              )
            : state.conversations;
        for (const conversation of rows) {
          conversationList.append(
            createConversationRow(
              document,
              conversation,
              text,
              conversation.conversationId === state.selectedId,
              () => void selectConversation(conversation.conversationId),
            ),
          );
        }
        if (rows.length === 0) {
          conversationList.append(
            createListEmpty(
              document,
              state.view === "unread" && state.conversations.length > 0
                ? text.noUnreadConversations
                : text.noConversations,
            ),
          );
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

      const updateSelectionUi = (): void => {
        const selecting = state.selectedMessages.size > 0;
        root.classList.toggle("dingtalk-workbench--selecting", selecting);
        composer.setSelection(state.selectedMessages.size, state.selectedId !== null);
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

      const setMessageSelected = (messageId: string, checked: boolean): void => {
        if (checked) state.selectedMessages.add(messageId);
        else state.selectedMessages.delete(messageId);
        const row = messageList.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(messageId)}"]`,
        );
        row?.classList.toggle("dingtalk-message--selected", checked);
        const check = row?.querySelector<HTMLInputElement>(".dingtalk-message-check");
        if (check) check.checked = checked;
        updateSelectionUi();
      };

      const renderMessages = (behavior?: { scroll?: "bottom"; distance?: number }): void => {
        messageList.replaceChildren();
        if (state.selectedId === null) {
          renderMainState(createListEmpty(document, text.emptyMessages));
          renderPill();
          return;
        }
        if (state.loadingMessages) {
          renderMainState(createMessageSkeleton(document));
          renderPill();
          return;
        }
        if (state.messagesError) {
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
        if (state.loadMoreError) {
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "dingtalk-load-more-error";
          retry.textContent = text.loadMoreFailed;
          retry.addEventListener("click", () => void loadOlder(true));
          messageList.append(retry);
        }
        if (state.messages.length === 0) {
          messageList.append(
            createElementNode(document, "div", "dingtalk-message-empty", text.emptyMessages),
          );
        }
        let previous: DingTalkMessage | undefined;
        let previousDay = "";
        for (const message of state.messages) {
          const key = dayKey(message.createdAt);
          if (key !== previousDay) {
            messageList.append(createDateSeparator(document, message.createdAt));
            previous = undefined;
            previousDay = key;
          } else if (
            previous !== undefined &&
            message.createdAt - previous.createdAt > 5 * 60_000
          ) {
            messageList.append(createTimeSeparator(document, message.createdAt));
            previous = undefined;
          }
          const continuation = continuesDingTalkGroup(previous, message);
          messageList.append(
            createMessageRow(document, message, text, {
              continuation,
              selected: state.selectedMessages.has(message.messageId),
              onSelect: (checked) => setMessageSelected(message.messageId, checked),
              onActivate: () =>
                setMessageSelected(
                  message.messageId,
                  !state.selectedMessages.has(message.messageId),
                ),
              onRetry: () => void deliver(message),
            }),
          );
          previous = message;
        }
        if (behavior?.scroll === "bottom") scrollToBottom();
        else if (behavior?.distance !== undefined) {
          messageList.scrollTop = messageList.scrollHeight - behavior.distance;
        }
        renderPill();
      };

      const clearSelection = (): void => {
        state.selectedMessages.clear();
        for (const row of messageList.querySelectorAll(".dingtalk-message--selected")) {
          row.classList.remove("dingtalk-message--selected");
        }
        for (const check of messageList.querySelectorAll<HTMLInputElement>(
          ".dingtalk-message-check",
        )) {
          check.checked = false;
        }
        updateSelectionUi();
      };

      const selectConversation = async (conversationId: string, force = false): Promise<void> => {
        if (!client) return;
        if (!force && state.selectedId === conversationId && state.messages.length > 0) return;
        mainHead.closeMenu();
        state.selectedId = conversationId;
        state.currentConversation = conversationFor(conversationId);
        state.messages = [];
        state.hasMore = false;
        state.nextCursor = null;
        state.loadingMessages = true;
        state.messagesError = false;
        state.loadMoreError = false;
        state.pendingNewCount = 0;
        clearSelection();
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
        if (result.conversation) state.currentConversation = result.conversation;
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
        const merged = new Map<string, ViewMessage>();
        for (const message of [...state.messages, ...result.messages]) {
          merged.set(message.messageId, message);
        }
        state.messages = [...merged.values()].sort(
          (left, right) => left.createdAt - right.createdAt,
        );
        state.hasMore = result.hasMore;
        state.nextCursor = result.nextCursor;
        state.loadMoreError = false;
        renderMessages({ distance });
      };

      const refreshLatest = async (conversationId: string): Promise<void> => {
        if (!client) return;
        const generation = messageGeneration;
        const known = new Set(state.messages.map((message) => message.messageId));
        const nearBottom = distanceFromBottom() <= 80;
        const distance = distanceFromBottom();
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
        const fresh = result.messages.filter((message) => !known.has(message.messageId)).length;
        state.messages = [...merged.values()].sort(
          (left, right) => left.createdAt - right.createdAt,
        );
        if (nearBottom) {
          renderMessages({ scroll: "bottom" });
        } else {
          state.pendingNewCount += fresh;
          renderMessages({ distance });
        }
        const newest = state.messages.at(-1);
        if (newest) void client.markViewed(conversationId, newest.createdAt);
      };

      const loadConversations = async (refresh: boolean): Promise<void> => {
        if (!client) {
          state.listError = true;
          renderList();
          return;
        }
        const generation = ++listGeneration;
        const result = await client.conversations(refresh).catch(() => null);
        if (disposed || generation !== listGeneration) return;
        if (!result) {
          state.listError = true;
          renderList();
          pageMenu.setStatus(false, effectiveHost);
          return;
        }
        state.conversations = result.conversations;
        state.source = result.source;
        if (!viewInitialized) {
          state.view = result.source === "unread" ? "unread" : "recent";
          viewInitialized = true;
        }
        state.listError = !result.available;
        pageMenu.setStatus(result.available, effectiveHost);
        renderList();
        if (state.selectedId && !conversationFor(state.selectedId)) {
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
        const decision = await client
          .decide({
            query: normalized,
            conversations: state.conversations.map((conversation) => ({
              conversationId: conversation.conversationId,
              title: conversation.title,
              singleChat: conversation.singleChat,
              lastMessageAt: conversation.lastMessageAt,
              ...(conversation.preview ? { preview: conversation.preview } : {}),
            })),
          })
          .catch(() => null);
        if (disposed || generation !== searchGeneration) return;
        const result = await client
          .search({
            query: normalized,
            route: decision?.route === "conversations" ? "conversations" : "messages",
            ...(decision?.messageQuery ? { messageQuery: decision.messageQuery } : {}),
            fromMe: decision?.fromMe ?? false,
            atMe: decision?.atMe ?? false,
            days: decision?.days ?? 30,
            ...(decision?.conversationIds.length
              ? { conversationIds: decision.conversationIds }
              : {}),
          })
          .catch(() => null);
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
        message.pending = true;
        message.failed = false;
        const distance = distanceFromBottom();
        renderMessages({ distance });
        const result = await client.send({ conversationId, text: message.text }).catch(() => null);
        if (disposed || state.selectedId !== conversationId) return;
        message.pending = false;
        if (!result?.ok) {
          message.failed = true;
          renderMessages({ distance });
          return;
        }
        message.messageId = result.messageId ?? message.messageId;
        message.createdAt = result.sentAt;
        if (state.currentConversation) {
          state.currentConversation.lastMessageAt = result.sentAt;
          state.currentConversation.preview = `我：${message.text}`;
        }
        renderMessages({ scroll: "bottom" });
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
        state.messages.push(pending);
        renderMessages({ scroll: "bottom" });
        void deliver(pending);
      };

      const embed = async (mention: DingTalkMention): Promise<void> => {
        const done = await options.embed(mention);
        if (!done) setNotice(text.embedFailed);
      };

      const loadSettings = async (): Promise<void> => {
        if (!client) return;
        const settings = await client.settings().catch(() => null);
        if (disposed || !settings) return;
        pageMenu.setSettings(settings);
        effectiveHost = settings.effectiveHost;
        pageMenu.setStatus(true, effectiveHost);
      };

      const changeHost = async (host: string | null): Promise<void> => {
        if (!client) return;
        pageMenu.setHostDisabled(true);
        try {
          await client.updateSettings({ defaultHost: host });
          await loadSettings();
          await loadConversations(true);
        } catch {
          pageMenu.setError(text.hostChangeFailed);
        } finally {
          if (!disposed) pageMenu.setHostDisabled(false);
        }
      };

      unreadButton.addEventListener("click", () => {
        if (state.view === "unread") return;
        state.view = "unread";
        renderList();
      });
      recentButton.addEventListener("click", () => {
        if (state.view === "recent") return;
        state.view = "recent";
        renderList();
      });
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
        if (state.selectedMessages.size > 0) {
          clearSelection();
          event.preventDefault();
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
          void loadConversations(false).then(() => {
            if (conversationId && conversationId === state.selectedId) {
              void refreshLatest(conversationId);
            }
          });
        }) ?? (() => undefined);

      updateHeader();
      updateSelectionUi();
      renderMessages();
      void loadSettings();
      void loadConversations(false).then(() => {
        const pending = consumeDingTalkReveal();
        if (pending?.conversationId) void revealTarget(pending);
      });

      return () => {
        disposed = true;
        listGeneration += 1;
        messageGeneration += 1;
        searchGeneration += 1;
        if (searchTimer !== null) view.clearTimeout(searchTimer);
        if (highlightTimer !== null) view.clearTimeout(highlightTimer);
        unsubscribe();
        view.removeEventListener("codexhost:dingtalk-reveal", onReveal);
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKey, true);
      };
    },
  });
}
