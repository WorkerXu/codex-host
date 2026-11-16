import type { DingTalkConversation } from "@codexhost/shared-contracts";

import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import { createConversationRow, updateConversationRow } from "./dingtalk-page-view.js";

export interface DingTalkConversationListOptions {
  document: Document;
  container: HTMLElement;
  text: DingTalkPageText;
  onSelect(conversationId: string): void;
}

export interface DingTalkConversationList {
  render(conversations: readonly DingTalkConversation[], selectedId: string | null): void;
  elementFor(conversationId: string): HTMLButtonElement | null;
  clear(): void;
}

/**
 * Keeps one row per conversation id. A change notification rewrites only the
 * rows it touches; unaffected rows keep their DOM, listeners and observers.
 */
export function createDingTalkConversationList(
  options: DingTalkConversationListOptions,
): DingTalkConversationList {
  const { document, container, text } = options;
  const rows = new Map<string, HTMLButtonElement>();

  const api: DingTalkConversationList = {
    render(conversations, selectedId) {
      for (const child of [...container.children]) {
        if (!(child as HTMLElement).dataset.conversationId) child.remove();
      }
      const wanted = new Set(conversations.map((row) => row.conversationId));
      for (const [id, row] of rows) {
        if (wanted.has(id)) continue;
        rows.delete(id);
        row.remove();
      }
      let cursor: Element | null = container.firstElementChild;
      for (const conversation of conversations) {
        const id = conversation.conversationId;
        let row = rows.get(id);
        if (!row) {
          row = createConversationRow(document, conversation, text, id === selectedId, () =>
            options.onSelect(id),
          );
          rows.set(id, row);
        } else {
          updateConversationRow(document, row, conversation, text, id === selectedId);
        }
        if (row === cursor) {
          cursor = cursor.nextElementSibling;
        } else {
          container.insertBefore(row, cursor);
        }
      }
    },
    elementFor(conversationId) {
      return rows.get(conversationId) ?? null;
    },
    clear() {
      for (const row of rows.values()) row.remove();
      rows.clear();
    },
  };
  return api;
}
