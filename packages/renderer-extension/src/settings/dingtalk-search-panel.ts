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
}

export interface DingTalkSearchPanelOptions {
  document: Document;
  text: DingTalkPageText;
  conversationTitle(conversationId: string): string;
  openConversation(conversationId: string): void;
  openMessage(conversationId: string, messageId: string): void;
  retry(): void;
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
      for (const conversation of result.conversations) {
        group.append(
          createSearchConversationRow(document, conversation, text, state.query, () =>
            options.openConversation(conversation.conversationId),
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
      for (const message of result.messages) {
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
      element.append(group);
    }
  };

  return { element, render };
}
