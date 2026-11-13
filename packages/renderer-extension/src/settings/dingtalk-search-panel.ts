import type { DingTalkSearchResult } from "@codexhost/shared-contracts";

import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import {
  createElementNode,
  createListEmpty,
  createListSkeleton,
  createSearchConversationRow,
  createSearchMessageRow,
} from "./dingtalk-page-view.js";

export interface DingTalkSearchPanelState {
  query: string;
  pending: boolean;
  failed: boolean;
  result: DingTalkSearchResult | null;
  expanded: { conversations: boolean; messages: boolean };
}

export interface DingTalkSearchPanelHandlers {
  expand(kind: "conversations" | "messages"): void;
}

export interface DingTalkSearchPanelOptions {
  document: Document;
  text: DingTalkPageText;
  conversationTitle(conversationId: string): string;
  openConversation(conversationId: string): void;
  openMessage(conversationId: string, messageId: string): void;
  retry(): void;
  expand: DingTalkSearchPanelHandlers["expand"];
}

export interface DingTalkSearchPanel {
  readonly element: HTMLElement;
  render(state: DingTalkSearchPanelState): void;
}

export function createDingTalkSearchPanel(
  options: DingTalkSearchPanelOptions,
): DingTalkSearchPanel {
  const { document, text } = options;
  const element = createElementNode(document, "div", "dingtalk-search-results");
  element.hidden = true;

  const render = (state: DingTalkSearchPanelState): void => {
    element.replaceChildren();
    if (state.query.length === 0) return;
    if (state.pending) {
      element.append(createListSkeleton(document));
      return;
    }
    if (state.failed) {
      element.append(
        createListEmpty(document, text.searchFailed, {
          label: text.retry,
          onClick: options.retry,
        }),
      );
      return;
    }
    const result = state.result;
    if (!result || (result.conversations.length === 0 && result.messages.length === 0)) {
      element.append(createListEmpty(document, text.noSearchResults));
      return;
    }
    if (result.conversations.length > 0) {
      const group = createElementNode(document, "div", "dingtalk-search-group");
      group.append(
        createElementNode(document, "div", "dingtalk-search-group-label", text.searchConversations),
      );
      const visible = state.expanded.conversations
        ? result.conversations
        : result.conversations.slice(0, 3);
      for (const conversation of visible) {
        group.append(
          createSearchConversationRow(document, conversation, text, state.query, () =>
            options.openConversation(conversation.conversationId),
          ),
        );
      }
      if (!state.expanded.conversations && result.conversations.length > 3) {
        group.append(
          moreButton(
            document,
            text.searchMore.replace("{count}", String(result.conversations.length)),
            () => options.expand("conversations"),
          ),
        );
      }
      element.append(group);
    }
    if (result.messages.length > 0) {
      const group = createElementNode(document, "div", "dingtalk-search-group");
      group.append(
        createElementNode(document, "div", "dingtalk-search-group-label", text.searchMessages),
      );
      const visible = state.expanded.messages ? result.messages : result.messages.slice(0, 3);
      for (const message of visible) {
        group.append(
          createSearchMessageRow(
            document,
            message,
            options.conversationTitle(message.conversationId),
            state.query,
            () => options.openMessage(message.conversationId, message.messageId),
          ),
        );
      }
      if (!state.expanded.messages && result.messages.length > 3) {
        group.append(
          moreButton(
            document,
            text.searchMore.replace("{count}", String(result.messages.length)),
            () => options.expand("messages"),
          ),
        );
      }
      element.append(group);
    }
  };

  return { element, render };
}

function moreButton(document: Document, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dingtalk-search-more";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}
