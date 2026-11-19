import { createDingTalkOpenTimings } from "./dingtalk-open-timings.js";
import SearchIcon from "lucide/dist/esm/icons/search.mjs";
import XIcon from "lucide/dist/esm/icons/x.mjs";

import type {
  DingTalkConversation,
  DingTalkMention,
  DingTalkMessage,
} from "@codexhost/shared-contracts";

import type { RendererDingTalkClient } from "../renderer-dingtalk-client.js";
import type { RendererDingTalkDispatchClient } from "../renderer-dingtalk-dispatch-client.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsLocale, RendererSettingsMessages } from "./localization.js";
import {
  conversationMention,
  mergeDingTalkMessages,
  messagePreview,
  type DingTalkPageState,
  type ViewMessage,
} from "./dingtalk-page-model.js";
import {
  createElementNode,
  createIcon,
  createIconButton,
  createConversationEmpty,
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
import { createDingTalkAgentPanel } from "./dingtalk-agent-panel.js";
import type { MessageDispatchedAgent } from "./dingtalk-page-view.js";

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
const HOVER_PREFETCH_MS = 150;
/** A memory-backed open answers in a few milliseconds; only a miss shows a skeleton. */
const SKELETON_DELAY_MS = 150;
const LAST_CONVERSATION_KEY = "codexhost.dingtalk.lastConversation.unread";
const LEGACY_CONVERSATION_KEY = "codexhost.dingtalk.lastConversation";

export interface RendererDingTalkPageOptions {
  createClient(): RendererDingTalkClient | null;
  /** Manual dispatch is local to the desktop Host that owns the agents. */
  createDispatchClient?(): RendererDingTalkDispatchClient | null;
  readLocale(): RendererSettingsLocale;
  /** Embeds a mention into the Composer that opened the workbench. */
  embed(mention: DingTalkMention): Promise<boolean> | boolean;
  openThread?(threadId: string): void;
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
      const dispatchClient = options.createDispatchClient?.() ?? null;
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
      let sendSequence = 0;
      let searchExpanded = { conversations: false, messages: false };
      let searchCursor = -1;
      let loadingOlderRequest = false;
      let loadedOlderPages = false;
      const prefetchedIds = new Set<string>();
      const hoverBound = new WeakSet<HTMLElement>();
      const hoverTimers = new Map<string, number>();
      let visibleObserver: IntersectionObserver | null = null;
      let skeletonVisible = false;
      let skeletonTimer: number | null = null;
      const previewQueue: string[] = [];
      const previewPending = new Set<string>();
      const previewAttempted = new Set<string>();
      let previewActive = 0;
      const dispatchMarks = new Map<string, MessageDispatchedAgent[]>();
      const dispatchKey = (message: DingTalkMessage): string =>
        `${message.conversationId}\u0000${message.messageId}`;
      const marksFor = (message: DingTalkMessage): readonly MessageDispatchedAgent[] =>
        dispatchMarks.get(dispatchKey(message)) ?? message.dispatchedAgents ?? [];
      let panelMessage: ViewMessage | null = null;
      let panel: ReturnType<typeof createDingTalkAgentPanel> | null = null;
      const openTimings = createDingTalkOpenTimings({
        view,
        report: (conversationId, paintMs, renderMs, imagesMs) => {
          void client
            ?.timing?.(conversationId, paintMs, renderMs, imagesMs)
            ?.catch(() => undefined);
        },
      });

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
          void loadStatus(true);
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
        // Menus live beside the workbench so `dingtalk.css` (inside the
        // settings shadow root) styles them.
        overlayHost: root,
        text,
        onDispatch: (message) => {
          if (state.selectedId === null) return;
          panelMessage = message;
          panel?.show({
            conversationId: message.conversationId,
            messageId: message.messageId,
            excerpt: messagePreview(message),
          });
        },
        onReply: (message) => composer.prefillMention(message.senderName),
        dispatchedAgents: marksFor,
        ...(options.openThread ? { onOpenThread: options.openThread } : {}),
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
        onImageStarted: openTimings.imageStarted,
        onImageSettled: openTimings.imageSettled,
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

      panel = createDingTalkAgentPanel({
        document,
        text,
        client: dispatchClient,
        hasDispatched: (fileName) =>
          panelMessage !== null &&
          marksFor(panelMessage).some((mark) => mark.fileName === fileName),
        onRun: (results) => {
          const message = panelMessage;
          if (!message) return;
          const key = dispatchKey(message);
          const marks = [...marksFor(message)];
          const errors: string[] = [];
          for (const result of results) {
            if (result.threadId) {
              const mark: MessageDispatchedAgent = {
                fileName: result.fileName,
                name: result.name,
                threadId: result.threadId,
              };
              const index = marks.findIndex((entry) => entry.fileName === result.fileName);
              if (index >= 0) marks[index] = mark;
              else marks.push(mark);
            } else if (result.error) {
              errors.push(`${result.name}：${result.error}`);
            }
          }
          dispatchMarks.set(key, marks);
          const current =
            state.messages.find(
              (entry) =>
                entry.messageId === message.messageId &&
                entry.conversationId === message.conversationId,
            ) ?? message;
          messageListView.update(current);
          panelMessage = null;
          if (errors.length > 0) setNotice(errors.join("；"));
        },
        onClose: () => {
          panelMessage = null;
        },
      });

      const tooltip = createElementNode(document, "div", "dingtalk-tooltip");
      tooltip.setAttribute("role", "tooltip");
      tooltip.hidden = true;

      main.append(mainHead.element, notice, pane, composer.element);
      root.append(sidebar, pageMenu.element, main, panel.element, tooltip);
      context.content.append(root);

      const tooltipAnchor = (event: Event): HTMLElement | null => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return null;
        const anchor = target.closest<HTMLElement>("[data-tooltip]");
        return anchor && root.contains(anchor) ? anchor : null;
      };
      const showTooltip = (anchor: HTMLElement): void => {
        const label = anchor.dataset.tooltip?.trim();
        if (!label) return;
        tooltip.textContent = label;
        tooltip.hidden = false;
        const rect = anchor.getBoundingClientRect();
        const size = tooltip.getBoundingClientRect();
        const gap = 6;
        const left = Math.min(
          Math.max(8, rect.left + rect.width / 2 - size.width / 2),
          view.innerWidth - size.width - 8,
        );
        const above = rect.top - gap - size.height;
        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(above >= 8 ? above : rect.bottom + gap)}px`;
      };
      const hideTooltip = (): void => {
        tooltip.hidden = true;
      };
      root.addEventListener("pointerover", (event) => {
        const anchor = tooltipAnchor(event);
        if (anchor) showTooltip(anchor);
      });
      root.addEventListener("pointerout", (event) => {
        const anchor = tooltipAnchor(event);
        if (!anchor) return;
        const related = event.relatedTarget;
        if (related instanceof Node && anchor.contains(related)) return;
        hideTooltip();
      });
      root.addEventListener("focusin", (event) => {
        const anchor = tooltipAnchor(event);
        if (anchor) showTooltip(anchor);
      });
      root.addEventListener("focusout", hideTooltip);
      messageList.addEventListener("scroll", () => {
        hideTooltip();
        messageListView.closeMenus();
      });

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

      const syncColumnMode = (): void => {
        const searching = state.searchQuery.length > 0;
        conversationList.hidden = searching;
        searchPanel.element.hidden = !searching;
        if (state.selectedId === null) renderMessages();
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
        previewAttempted.add(conversationId);
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
          if (
            !conversationId ||
            previewPending.has(conversationId) ||
            previewAttempted.has(conversationId)
          )
            continue;
          previewPending.add(conversationId);
          previewActive += 1;
          void (async () => {
            const generation = listGeneration;
            const result = await client?.preview(conversationId).catch(() => null);
            if (disposed || generation !== listGeneration) return;
            applyPreview(conversationId, result?.preview ?? null);
          })().finally(() => {
            previewPending.delete(conversationId);
            previewActive -= 1;
            if (!disposed) {
              pumpPreviews();
              renderList();
            }
          });
        }
      };

      const requestPreview = (conversationId: string): void => {
        if (!client || previewPending.has(conversationId) || previewAttempted.has(conversationId))
          return;
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

      /** A memory hit paints before this fires; only a live miss shows a skeleton. */
      const beginSkeleton = (): void => {
        if (skeletonTimer !== null) view.clearTimeout(skeletonTimer);
        skeletonVisible = false;
        skeletonTimer = view.setTimeout(() => {
          skeletonTimer = null;
          if (disposed || !state.loadingMessages) return;
          skeletonVisible = true;
          renderMessages();
        }, SKELETON_DELAY_MS);
      };

      const clearSkeleton = (): void => {
        if (skeletonTimer !== null) {
          view.clearTimeout(skeletonTimer);
          skeletonTimer = null;
        }
        skeletonVisible = false;
      };

      /** Warms every visible row at background priority, once per page visit. */
      const requestPrefetch = (ids: readonly string[], force = false): void => {
        if (!client) return;
        const fresh = [...new Set(ids)].filter(
          (conversationId) =>
            conversationId !== state.selectedId && (force || !prefetchedIds.has(conversationId)),
        );
        if (fresh.length === 0) return;
        for (const conversationId of fresh) prefetchedIds.add(conversationId);
        void client.prefetch(fresh).catch(() => {
          for (const id of fresh) prefetchedIds.delete(id);
        });
      };

      const bindHoverPrefetch = (conversationId: string, row: HTMLElement): void => {
        if (hoverBound.has(row)) return;
        hoverBound.add(row);
        row.addEventListener("pointerenter", () => {
          if (conversationId === state.selectedId) return;
          const timer = view.setTimeout(() => {
            hoverTimers.delete(conversationId);
            requestPrefetch([conversationId], true);
          }, HOVER_PREFETCH_MS);
          hoverTimers.set(conversationId, timer);
        });
        row.addEventListener("pointerleave", () => {
          const timer = hoverTimers.get(conversationId);
          if (timer !== undefined) view.clearTimeout(timer);
          hoverTimers.delete(conversationId);
        });
      };

      if (typeof IntersectionObserver !== "undefined") {
        visibleObserver = new IntersectionObserver(
          (entries) => {
            requestPrefetch(
              entries
                .filter((entry) => entry.isIntersecting)
                .map((entry) => (entry.target as HTMLElement).dataset.conversationId ?? "")
                .filter(Boolean),
            );
          },
          { root: conversationList, rootMargin: "120px" },
        );
      }

      /** Observes the rows the list currently shows; no-op for rows already warm. */
      const warmVisibleConversations = (): void => {
        if (!client || state.conversations.length === 0) return;
        if (!visibleObserver) {
          requestPrefetch(state.conversations.map((row) => row.conversationId));
          return;
        }
        for (const { conversationId } of state.conversations) {
          const row = conversationRows.elementFor(conversationId);
          if (!row) continue;
          bindHoverPrefetch(conversationId, row);
          visibleObserver.observe(row);
        }
      };

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
        warmVisibleConversations();
        for (const conversation of state.conversations) {
          if (previewAttempted.has(conversation.conversationId)) continue;
          const row = conversationRows.elementFor(conversation.conversationId);
          if (!row) continue;
          if (!conversation.preview && previewObserver) previewObserver.observe(row);
          else if (!conversation.preview) requestPreview(conversation.conversationId);
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
        mainHead.element.hidden = conversation === null;
        composer.element.hidden = conversation === null;
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
          const noUnread =
            state.searchQuery.length === 0 &&
            state.conversations.length === 0 &&
            !state.listLoading &&
            !state.listError;
          renderMainState(
            createConversationEmpty(
              document,
              noUnread ? text.noUnreadConversations : text.emptyMessages,
            ),
          );
          renderPill();
          return;
        }
        if (state.loadingMessages) {
          messageListView.clear();
          if (!skeletonVisible) {
            renderMainState(null);
            renderPill();
            return;
          }
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
        const openStartedAt = view.performance.now();
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
        loadedOlderPages = false;
        composer.reset();
        updateHeader();
        renderList();
        beginSkeleton();
        renderMessages();
        const generation = ++messageGeneration;
        const result = await client
          .messages({ conversationId, limit: INITIAL_MESSAGE_LIMIT })
          .catch(() => null);
        clearSkeleton();
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
        state.messages = mergeDingTalkMessages([], result.messages);
        state.hasMore = result.hasMore;
        state.nextCursor = result.nextCursor;
        state.messagesError = result.errorCode !== null && state.messages.length === 0;
        updateHeader();
        openTimings.begin(conversationId, state.messages, openStartedAt);
        const renderStarted = view.performance.now();
        renderMessages({ scroll: "bottom" });
        openTimings.rendered(view.performance.now() - renderStarted);
        const newest = state.messages.at(-1);
        if (newest) void client.markViewed(conversationId, newest.createdAt, true);
        // The @ picker is the only member consumer; warm it after the transcript
        // paints so the first picker opens without a live read.
        if (state.currentConversation?.singleChat === false) {
          void client.members(conversationId).catch(() => null);
        }
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
        loadedOlderPages = true;
        const known = new Set(state.messages.map((message) => message.messageId));
        const older = mergeDingTalkMessages([], result.messages)
          .filter((message) => !known.has(message.messageId))
          .sort((left, right) => left.createdAt - right.createdAt);
        state.messages = mergeDingTalkMessages(state.messages, result.messages);
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
        const known = new Set(state.messages.map((message) => message.messageId));
        if (result.conversation) {
          state.currentConversation = result.conversation;
          updateHeader();
        }
        const fresh = mergeDingTalkMessages([], result.messages)
          .filter((message) => !known.has(message.messageId))
          .sort((left, right) => left.createdAt - right.createdAt);
        state.messages = mergeDingTalkMessages(state.messages, result.messages);
        if (!loadedOlderPages) {
          // The window is still the latest page, so its cursor is authoritative.
          state.hasMore = result.hasMore;
          state.nextCursor = result.nextCursor;
        }
        const overflow = Math.max(0, state.messages.length - MAX_MESSAGE_WINDOW);
        if (overflow > 0) {
          state.messages = state.messages.slice(overflow);
          messageListView.removeOldest(overflow);
        }
        if ([...known].some((id) => !state.messages.some((message) => message.messageId === id))) {
          messageListView.reset(state.messages, nearBottom ? { scroll: "bottom" } : { distance });
        } else
          messageListView.append(
            result.messages.filter((message) =>
              state.messages.some((current) => current.messageId === message.messageId),
            ),
          );
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
        previewObserver?.disconnect();
        previewQueue.length = 0;
        previewAttempted.clear();
        state.conversations = result.conversations.map((row) => ({ ...row }));
        // Keep only the row that is actually open; never reuse it after leaving the page.
        if (
          state.currentConversation &&
          !state.conversations.some((row) => row.conversationId === state.selectedId)
        ) {
          state.conversations.unshift({
            ...state.currentConversation,
            unreadCount: 0,
            atMe: false,
          });
        }
        void client
          .details(result.conversations)
          .then((details) => {
            if (disposed || generation !== listGeneration) return;
            const byId = new Map(details.map((row) => [row.conversationId, row]));
            state.conversations = state.conversations.map((row) => {
              const detail = byId.get(row.conversationId);
              return detail
                ? {
                    ...row,
                    groupType: detail.groupType,
                    memberCount: detail.memberCount,
                    atMe: row.conversationId !== state.selectedId && detail.atMe === true,
                  }
                : row;
            });
            const selected = state.conversations.find(
              (row) => row.conversationId === state.selectedId,
            );
            if (selected) {
              state.currentConversation = selected;
              updateHeader();
            }
            renderList();
          })
          .catch(() => undefined);
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
        const generation = messageGeneration;
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
        if (disposed || generation !== messageGeneration || state.selectedId !== conversationId)
          return;
        if (!state.messages.includes(message)) return;
        message.pending = false;
        if (!result?.ok) {
          message.failed = true;
          messageListView.update(message, previousId);
          return;
        }
        message.messageId = result.messageId ?? message.messageId;
        if (result.messageId) delete message.echoStartedAt;
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
        state.messages = mergeDingTalkMessages([], state.messages);
        renderMessages({ scroll: "bottom" });
        scrollToBottom();
        renderList();
        void refreshLatest(conversationId);
      };

      const sendMessage = (payload: {
        text: string;
        displayText: string;
        atOpenDingTalkIds: string[];
        atAll: boolean;
      }): void => {
        if (state.selectedId === null) return;
        const pending: ViewMessage = {
          messageId: `local-${Date.now()}-${++sendSequence}`,
          conversationId: state.selectedId,
          senderName: "我",
          senderId: "me",
          createdAt: Date.now(),
          text: payload.displayText,
          unsupported: false,
          mine: true,
          pending: true,
          echoStartedAt: Date.now(),
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

      const loadStatus = async (refresh = false): Promise<void> => {
        if (!client) {
          pageMenu.setStatus(null);
          return;
        }
        const status = await client.status(refresh).catch(() => null);
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
        if (
          !path.some(
            (node) =>
              node instanceof HTMLElement && node.classList.contains("dingtalk-message-menu"),
          )
        ) {
          messageListView.closeMenus();
        }
        const inside = (menu: { contains(node: Node): boolean }): boolean =>
          path.some((node) => node instanceof Node && menu.contains(node));
        if (mainHead.menuOpen && !inside(mainHead)) mainHead.closeMenu();
        if (!pageMenu.open) return;
        if (inside(pageMenu)) return;
        pageMenu.close();
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        if (panel?.open) {
          panel.close();
          event.stopPropagation();
          return;
        }
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
          void loadConversations();
          // The open transcript must not wait for an independent unread-list read.
          if (state.selectedId && !state.loadingMessages) void refreshLatest(state.selectedId);
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
        clearSkeleton();
        poll.stop();
        document.removeEventListener("visibilitychange", onVisibility);
        lightbox.dispose();
        panel?.dispose();
        composer.dispose();
        pageMenu.close();
        mainHead.closeMenu();
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
        visibleObserver?.disconnect();
        for (const timer of hoverTimers.values()) view.clearTimeout(timer);
        hoverTimers.clear();
        openTimings.dispose();
        previewQueue.length = 0;
        previewPending.clear();
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
