import type {
  DingTalkConversation,
  DingTalkMessage,
  DingTalkMention,
  DingTalkSearchResult,
} from "@codexhost/shared-contracts";

import type { RendererDingTalkClient } from "../renderer-dingtalk-client.js";
import { dingtalkErrorText } from "../renderer-dingtalk-client.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import {
  conversationMention,
  dingtalkInitial,
  formatDingTalkTime,
  messagePreview,
} from "./dingtalk-page-model.js";
import type { RendererSettingsLocale, RendererSettingsMessages } from "./localization.js";
import { createDingTalkMark } from "./dingtalk-icon.js";
import { dingtalkPageStrings } from "./dingtalk-page-strings.js";

const SEARCH_DEBOUNCE_MS = 450;
const HIGHLIGHT_MS = 2_500;
const RENDERED_MESSAGE_LIMIT = 400;

export interface RendererDingTalkPageOptions {
  createClient(): RendererDingTalkClient | null;
  readLocale(): RendererSettingsLocale;
  /** Embeds a mention into the Composer that opened the workbench. */
  embed(mention: DingTalkMention): Promise<boolean> | boolean;
}

interface PageState {
  source: "unread" | "recent-replied" | "empty";
  conversations: DingTalkConversation[];
  statusText: string;
  selectedId: string | null;
  currentConversation: DingTalkConversation | null;
  messages: DingTalkMessage[];
  hasMore: boolean;
  nextCursor: number | null;
  selectedMessages: Set<string>;
  search: DingTalkSearchResult | null;
  searchPending: boolean;
  error: string | null;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(
  document: Document,
  label: string,
  className = "settings-button",
): HTMLButtonElement {
  const node = element(document, "button", className, label);
  node.type = "button";
  return node;
}

function iconButton(document: Document, label: string, text: string): HTMLButtonElement {
  const node = button(document, text, "dingtalk-icon-button");
  node.setAttribute("aria-label", label);
  node.title = label;
  return node;
}

/** Notifies a mounted page, or queues the target for the next mount. */
const PENDING_KEY = "__codexhostDingTalkRevealV1";
interface RevealTarget {
  conversationId?: string;
  messageIds?: string[];
}

export function requestDingTalkReveal(target: RevealTarget): void {
  (window as Window & { [PENDING_KEY]?: RevealTarget })[PENDING_KEY] = target;
  window.dispatchEvent(new CustomEvent("codexhost:dingtalk-reveal", { detail: target }));
}

export function consumeDingTalkReveal(): RevealTarget | null {
  const holder = window as Window & { [PENDING_KEY]?: RevealTarget };
  const target = holder[PENDING_KEY] ?? null;
  Reflect.deleteProperty(holder, PENDING_KEY);
  return target;
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
      const state: PageState = {
        source: "empty",
        conversations: [],
        statusText: "",
        selectedId: null,
        currentConversation: null,
        messages: [],
        hasMore: false,
        nextCursor: null,
        selectedMessages: new Set(),
        search: null,
        searchPending: false,
        error: null,
      };
      let disposed = false;
      let effectiveHost = "local";
      let requestGeneration = 0;
      let searchTimer: number | null = null;
      let highlightTimer: number | null = null;

      const root = element(document, "div", "dingtalk-workbench");
      const sidebar = element(document, "aside", "dingtalk-sidebar");
      const sidebarHead = element(document, "div", "dingtalk-sidebar-head");
      const brand = element(document, "div", "dingtalk-brand");
      brand.append(createDingTalkMark(document, 20));
      brand.append(element(document, "span", "dingtalk-brand-title", text.brand));
      const status = element(document, "span", "dingtalk-status", text.connecting);
      const refresh = iconButton(document, text.refresh, "⟳");
      sidebarHead.append(brand, status, refresh);

      const searchBox = element(document, "div", "dingtalk-search");
      const searchInput = element(document, "input", "dingtalk-search-input");
      searchInput.type = "search";
      searchInput.placeholder = text.searchPlaceholder;
      searchInput.autocomplete = "off";
      searchBox.append(searchInput);

      const hostRow = element(document, "div", "dingtalk-host-row");
      const hostLabel = element(document, "span", "dingtalk-host-label", text.hostLabel);
      const hostSelect = element(document, "select", "dingtalk-host-select");
      hostSelect.setAttribute("aria-label", text.hostLabel);
      hostRow.append(hostLabel, hostSelect);
      const sourceLabel = element(document, "div", "dingtalk-source-label", "");
      const conversationList = element(document, "div", "dingtalk-conversation-list");
      conversationList.setAttribute("role", "listbox");
      sidebar.append(sidebarHead, searchBox, hostRow, sourceLabel, conversationList);

      const main = element(document, "section", "dingtalk-main");
      const mainHead = element(document, "div", "dingtalk-main-head");
      const title = element(document, "div", "dingtalk-main-title", text.selectConversation);
      const subtitle = element(document, "div", "dingtalk-main-subtitle", "");
      const headCopy = element(document, "div", "dingtalk-main-copy");
      headCopy.append(title, subtitle);
      const headActions = element(document, "div", "dingtalk-main-actions");
      const embedConversation = button(document, text.embedConversation);
      embedConversation.disabled = true;
      const embedSelected = button(document, text.embedSelected);
      embedSelected.disabled = true;
      headActions.append(embedConversation, embedSelected);
      mainHead.append(headCopy, headActions);

      const notice = element(document, "div", "dingtalk-notice");
      notice.hidden = true;
      const searchResults = element(document, "div", "dingtalk-search-results");
      searchResults.hidden = true;
      const messageList = element(document, "div", "dingtalk-message-list");
      messageList.setAttribute("role", "log");
      const emptyState = element(document, "div", "dingtalk-empty", text.emptyMessages);
      const composer = element(document, "div", "dingtalk-composer");
      const composerInput = element(document, "textarea", "dingtalk-composer-input");
      composerInput.rows = 2;
      composerInput.placeholder = text.sendPlaceholder;
      const send = button(document, text.send, "settings-button dingtalk-send");
      send.disabled = true;
      const composerStatus = element(document, "span", "dingtalk-composer-status", "");
      composer.append(composerInput, send, composerStatus);
      main.append(mainHead, notice, searchResults, messageList, emptyState, composer);

      root.append(sidebar, main);
      context.content.append(root);

      const setStatus = (value: string, failed = false): void => {
        status.textContent = value;
        status.classList.toggle("dingtalk-status--error", failed);
      };
      const setNotice = (value: string | null): void => {
        notice.hidden = !value;
        notice.textContent = value ?? "";
        notice.classList.toggle(
          "dingtalk-notice--error",
          Boolean(value && /失败|错误|failed|error/iu.test(value)),
        );
      };

      const renderList = (): void => {
        conversationList.replaceChildren();
        sourceLabel.textContent =
          state.source === "recent-replied"
            ? text.recentReplied
            : state.source === "unread"
              ? text.unread
              : "";
        sourceLabel.hidden = sourceLabel.textContent === "";
        for (const conversation of state.conversations) {
          const row = element(document, "button", "dingtalk-conversation");
          row.type = "button";
          row.setAttribute("role", "option");
          row.setAttribute(
            "aria-selected",
            String(conversation.conversationId === state.selectedId),
          );
          row.classList.toggle(
            "dingtalk-conversation--active",
            conversation.conversationId === state.selectedId,
          );
          const avatar = element(
            document,
            "span",
            "dingtalk-avatar",
            dingtalkInitial(conversation.title),
          );
          const copy = element(document, "span", "dingtalk-conversation-copy");
          const line = element(document, "span", "dingtalk-conversation-line");
          const label = element(
            document,
            "span",
            "dingtalk-conversation-title",
            conversation.title || text.unnamed,
          );
          const time = element(
            document,
            "span",
            "dingtalk-conversation-time",
            formatDingTalkTime(conversation.lastMessageAt),
          );
          line.append(label, time);
          const meta = element(document, "span", "dingtalk-conversation-meta");
          const preview = element(
            document,
            "span",
            "dingtalk-conversation-preview",
            conversation.preview ?? (conversation.singleChat ? text.direct : text.group),
          );
          meta.append(preview);
          if (conversation.muted) {
            meta.append(element(document, "span", "dingtalk-muted", text.muted));
          }
          if (conversation.unreadCount > 0) {
            meta.append(
              element(
                document,
                "span",
                "dingtalk-unread",
                String(Math.min(99, conversation.unreadCount)),
              ),
            );
          }
          copy.append(line, meta);
          row.append(avatar, copy);
          row.addEventListener("click", () => void selectConversation(conversation.conversationId));
          conversationList.append(row);
        }
        if (state.conversations.length === 0) {
          conversationList.append(
            element(
              document,
              "div",
              "dingtalk-empty dingtalk-empty--list",
              state.error ? text.listFailed : text.noConversations,
            ),
          );
        }
      };

      const renderMessages = (): void => {
        messageList.replaceChildren();
        emptyState.hidden = state.messages.length > 0;
        const conversation =
          state.conversations.find((row) => row.conversationId === state.selectedId) ??
          state.search?.conversations.find((row) => row.conversationId === state.selectedId) ??
          null;
        title.textContent = conversation?.title || text.selectConversation;
        subtitle.textContent = conversation
          ? conversation.singleChat
            ? text.direct
            : text.group
          : "";
        embedConversation.disabled = !conversation;
        embedSelected.disabled = state.selectedMessages.size === 0 || !state.selectedId;
        const visible = state.messages.slice(-RENDERED_MESSAGE_LIMIT);
        for (const message of visible) {
          const row = element(document, "div", "dingtalk-message");
          row.dataset.messageId = message.messageId;
          row.classList.toggle("dingtalk-message--mine", message.mine);
          row.classList.toggle(
            "dingtalk-message--selected",
            state.selectedMessages.has(message.messageId),
          );
          const check = element(document, "input", "dingtalk-message-check");
          check.type = "checkbox";
          check.checked = state.selectedMessages.has(message.messageId);
          check.setAttribute("aria-label", text.selectMessage);
          check.addEventListener("change", () => {
            if (check.checked) state.selectedMessages.add(message.messageId);
            else state.selectedMessages.delete(message.messageId);
            row.classList.toggle("dingtalk-message--selected", check.checked);
            embedSelected.disabled = state.selectedMessages.size === 0 || !state.selectedId;
          });
          const bubble = element(document, "div", "dingtalk-message-bubble");
          const meta = element(document, "div", "dingtalk-message-meta");
          meta.append(
            element(document, "span", "dingtalk-message-sender", message.senderName),
            element(
              document,
              "span",
              "dingtalk-message-time",
              formatDingTalkTime(message.createdAt),
            ),
          );
          bubble.append(meta);
          if (message.unsupported) {
            const summary = message.text.replace(/\s+/gu, " ").trim().slice(0, 80);
            bubble.append(
              element(
                document,
                "div",
                "dingtalk-message-unsupported",
                summary ? `${summary} · ${text.mobileOnly}` : text.mobileOnly,
              ),
            );
          } else {
            bubble.append(element(document, "div", "dingtalk-message-text", message.text));
          }
          row.append(check, bubble);
          messageList.append(row);
        }
        const scroller = messageList;
        requestAnimationFrame(() => {
          if (disposed) return;
          scroller.scrollTop = scroller.scrollHeight;
        });
      };

      const renderSearch = (): void => {
        searchResults.replaceChildren();
        const result = state.search;
        if (
          !result ||
          (!state.searchPending &&
            result.messages.length === 0 &&
            result.conversations.length === 0 &&
            state.error === null)
        ) {
          searchResults.hidden = true;
          return;
        }
        searchResults.hidden = false;
        const head = element(document, "div", "dingtalk-search-results-head");
        head.append(
          element(document, "span", "", state.searchPending ? text.searching : text.searchResults),
        );
        const close = iconButton(document, text.clearSearch, "✕");
        close.addEventListener("click", () => {
          state.search = null;
          searchInput.value = "";
          renderSearch();
        });
        head.append(close);
        searchResults.append(head);
        for (const conversation of result.conversations) {
          const row = button(
            document,
            `${conversation.title || text.unnamed} · ${
              conversation.singleChat ? text.direct : text.group
            }`,
            "dingtalk-search-row",
          );
          row.addEventListener("click", () => {
            void selectConversation(conversation.conversationId);
            state.search = null;
            renderSearch();
          });
          searchResults.append(row);
        }
        for (const message of result.messages.slice(0, 20)) {
          const row = element(document, "div", "dingtalk-search-message");
          const meta = element(
            document,
            "span",
            "dingtalk-search-message-meta",
            `${message.senderName} · ${formatDingTalkTime(message.createdAt)}`,
          );
          const body = element(
            document,
            "span",
            "dingtalk-search-message-text",
            messagePreview(message),
          );
          row.append(meta, body);
          row.addEventListener("click", () => {
            void revealTarget({
              conversationId: message.conversationId,
              messageIds: [message.messageId],
            });
          });
          searchResults.append(row);
        }
        if (
          !state.searchPending &&
          result.conversations.length === 0 &&
          result.messages.length === 0
        ) {
          searchResults.append(element(document, "div", "dingtalk-empty", text.noSearchResults));
        }
      };

      const revealTarget = async (target: RevealTarget): Promise<void> => {
        if (target.conversationId) await selectConversation(target.conversationId);
        const ids = target.messageIds ?? [];
        if (ids.length === 0) return;
        const first = ids[0];
        if (!first) return;
        let row = messageList.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(first)}"]`,
        );
        for (let attempt = 0; attempt < 6 && !row && state.hasMore; attempt += 1) {
          await loadOlder();
          row = messageList.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(first)}"]`);
        }
        if (row) {
          row.scrollIntoView({ block: "center" });
          row.classList.add("dingtalk-message--highlight");
          if (highlightTimer) view.clearTimeout(highlightTimer);
          highlightTimer = view.setTimeout(() => {
            row.classList.remove("dingtalk-message--highlight");
          }, HIGHLIGHT_MS);
          return;
        }
        setNotice(text.notLoaded);
      };

      const loadConversations = async (refresh: boolean): Promise<void> => {
        if (!client) {
          setStatus(text.unavailable, true);
          return;
        }
        const generation = ++requestGeneration;
        const result = await client.conversations(refresh).catch((error: unknown) => {
          setStatus(dingtalkErrorText(error instanceof Error ? error.message : null, locale), true);
          return null;
        });
        if (disposed || generation !== requestGeneration || !result) return;
        state.conversations = result.conversations;
        state.source = result.source;
        state.error = result.errorCode;
        setStatus(
          result.available ? text.connected.replace("{host}", effectiveHost) : text.unavailable,
          !result.available,
        );
        if (result.source === "recent-replied") setNotice(text.recentRepliedNotice);
        else setNotice(null);
        renderList();
        if (
          !state.selectedId ||
          !state.conversations.some((row) => row.conversationId === state.selectedId)
        ) {
          const first = state.conversations[0];
          if (first) await selectConversation(first.conversationId);
          else {
            state.messages = [];
            renderMessages();
          }
        }
      };

      const selectConversation = async (conversationId: string): Promise<void> => {
        if (!client) return;
        state.selectedId = conversationId;
        state.currentConversation =
          state.conversations.find((row) => row.conversationId === conversationId) ??
          state.search?.conversations.find((row) => row.conversationId === conversationId) ??
          null;
        state.selectedMessages.clear();
        state.search = null;
        renderList();
        renderSearch();
        const generation = ++requestGeneration;
        title.textContent = text.loading;
        const result = await client.messages({ conversationId, limit: 40 }).catch(() => null);
        if (disposed || generation !== requestGeneration || state.selectedId !== conversationId)
          return;
        if (!result) {
          setNotice(text.messagesFailed);
          return;
        }
        state.messages = result.messages;
        state.hasMore = result.hasMore;
        state.nextCursor = result.nextCursor;
        state.error = result.errorCode;
        if (result.conversation) state.currentConversation = result.conversation;
        renderMessages();
        renderList();
        const newest = result.messages[0];
        if (newest) void client.markViewed(conversationId, newest.createdAt);
      };

      const loadOlder = async (): Promise<void> => {
        if (!client || !state.selectedId || !state.hasMore || !state.nextCursor) return;
        const conversationId = state.selectedId;
        const cursor = state.nextCursor;
        const generation = requestGeneration;
        const result = await client
          .messages({ conversationId, before: cursor, limit: 40 })
          .catch(() => null);
        if (
          disposed ||
          generation !== requestGeneration ||
          !result ||
          state.selectedId !== conversationId
        )
          return;
        const merged = new Map<string, DingTalkMessage>();
        for (const message of [...state.messages, ...result.messages]) {
          merged.set(message.messageId, message);
        }
        state.messages = [...merged.values()].sort(
          (left, right) => right.createdAt - left.createdAt,
        );
        state.hasMore = result.hasMore;
        state.nextCursor = result.nextCursor;
        const previousHeight = messageList.scrollHeight;
        renderMessages();
        messageList.scrollTop = messageList.scrollHeight - previousHeight;
      };

      const runSearch = async (): Promise<void> => {
        const query = searchInput.value.trim();
        if (!client || !query) {
          state.search = null;
          renderSearch();
          return;
        }
        state.searchPending = true;
        state.search = {
          available: true,
          route: "messages",
          conversations: [],
          messages: [],
          errorCode: null,
        };
        renderSearch();
        const decision = await client
          .decide({
            query,
            conversations: state.conversations.map((conversation) => ({
              conversationId: conversation.conversationId,
              title: conversation.title,
              singleChat: conversation.singleChat,
              lastMessageAt: conversation.lastMessageAt,
              ...(conversation.preview ? { preview: conversation.preview } : {}),
            })),
          })
          .catch(() => null);
        if (disposed) return;
        const result = await client
          .search({
            query,
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
        if (disposed) return;
        state.searchPending = false;
        state.search = result ?? {
          available: false,
          route: "messages",
          conversations: [],
          messages: [],
          errorCode: "dws_failed",
        };
        if (!decision?.available && result) setNotice(text.searchFallback);
        renderSearch();
      };

      const embed = async (mention: DingTalkMention): Promise<void> => {
        const done = await options.embed(mention);
        if (!done) setNotice(text.embedFailed);
      };

      embedConversation.addEventListener("click", () => {
        if (!state.selectedId) return;
        void embed(conversationMention(state.currentConversation, state.selectedId));
      });
      embedSelected.addEventListener("click", () => {
        if (!state.selectedId) return;
        void embed(
          conversationMention(state.currentConversation, state.selectedId, [
            ...state.selectedMessages,
          ]),
        );
      });
      send.addEventListener("click", () => void sendMessage());
      const sendMessage = async (): Promise<void> => {
        const value = composerInput.value.trim();
        if (!client || !state.selectedId || !value) return;
        send.disabled = true;
        composerStatus.textContent = text.sending;
        composerStatus.classList.remove("dingtalk-composer-status--error");
        const result = await client
          .send({ conversationId: state.selectedId, text: value })
          .catch(() => null);
        if (disposed) return;
        send.disabled = false;
        if (result?.ok) {
          composerInput.value = "";
          composerStatus.textContent = "";
          send.disabled = true;
          const conversation = state.conversations.find(
            (row) => row.conversationId === state.selectedId,
          );
          if (conversation) conversation.lastMessageAt = result.sentAt;
          await selectConversation(state.selectedId);
        } else {
          composerStatus.textContent = text.sendFailed;
          composerStatus.classList.add("dingtalk-composer-status--error");
          send.disabled = false;
        }
      };
      composerInput.addEventListener("input", () => {
        send.disabled = composerInput.value.trim().length === 0;
      });
      composerInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        void sendMessage();
      });
      searchInput.addEventListener("input", () => {
        if (searchTimer) view.clearTimeout(searchTimer);
        searchTimer = view.setTimeout(() => {
          searchTimer = null;
          void runSearch();
        }, SEARCH_DEBOUNCE_MS);
      });
      refresh.addEventListener("click", () => void loadConversations(true));
      messageList.addEventListener("scroll", () => {
        if (messageList.scrollTop < 48) void loadOlder();
      });

      const onReveal = (event: Event): void => {
        const detail = (event as CustomEvent<RevealTarget>).detail;
        if (detail) void revealTarget(detail);
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape" && state.selectedMessages.size > 0) {
          state.selectedMessages.clear();
          renderMessages();
        }
      };
      view.addEventListener("codexhost:dingtalk-reveal", onReveal);
      document.addEventListener("keydown", onKey, true);

      const unsubscribe =
        client?.subscribe((conversationId) => {
          if (disposed) return;
          void loadConversations(false).then(() => {
            if (
              conversationId &&
              conversationId === state.selectedId &&
              messageList.scrollTop >= messageList.scrollHeight - messageList.clientHeight - 40
            ) {
              void client
                .messages({ conversationId, before: Date.now(), limit: 40 })
                .then((result) => {
                  if (disposed || state.selectedId !== conversationId) return;
                  state.messages = result.messages;
                  state.hasMore = result.hasMore;
                  state.nextCursor = result.nextCursor;
                  renderMessages();
                })
                .catch(() => undefined);
            }
          });
        }) ?? (() => undefined);

      const loadSettings = async (): Promise<void> => {
        if (!client) return;
        const settings = await client.settings().catch(() => null);
        if (disposed || !settings) return;
        hostSelect.replaceChildren();
        const auto = element(document, "option", "", text.hostAuto);
        auto.value = "";
        hostSelect.append(auto);
        for (const host of settings.hosts) {
          const option = element(document, "option", "", host.local ? text.hostLocal : host.name);
          option.value = host.name;
          hostSelect.append(option);
        }
        if (
          settings.defaultHost &&
          !settings.hosts.some((host) => host.name === settings.defaultHost)
        ) {
          const configured = element(document, "option", "", settings.defaultHost);
          configured.value = settings.defaultHost;
          hostSelect.append(configured);
        }
        hostSelect.value = settings.defaultHost ?? "";
        hostSelect.title = text.hostEffective.replace("{name}", settings.effectiveHost);
        effectiveHost = settings.effectiveHost;
        setStatus(text.connected.replace("{host}", effectiveHost));
      };
      hostSelect.addEventListener("change", () => {
        if (!client) return;
        hostSelect.disabled = true;
        void client
          .updateSettings({ defaultHost: hostSelect.value || null })
          .then(() => loadSettings())
          .then(() => loadConversations(true))
          .catch(() => setStatus(text.hostChangeFailed, true))
          .finally(() => {
            if (!disposed) hostSelect.disabled = false;
          });
      });

      void loadSettings();
      void loadConversations(false).then(() => {
        const pending = consumeDingTalkReveal();
        if (pending && pending.conversationId) void revealTarget(pending);
      });
      return () => {
        disposed = true;
        requestGeneration += 1;
        if (searchTimer) view.clearTimeout(searchTimer);
        if (highlightTimer) view.clearTimeout(highlightTimer);
        unsubscribe();
        view.removeEventListener("codexhost:dingtalk-reveal", onReveal);
        document.removeEventListener("keydown", onKey, true);
      };
    },
  });
}
