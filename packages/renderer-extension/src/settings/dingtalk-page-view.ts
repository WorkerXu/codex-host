import createElement from "lucide/dist/esm/createElement.mjs";
import type { IconNode } from "lucide";

import type { DingTalkConversation, DingTalkMessage } from "@codexhost/shared-contracts";

import {
  avatarTone,
  dingtalkInitial,
  formatDingTalkClock,
  formatDingTalkDateLabel,
  formatDingTalkTime,
  highlightSegments,
  unsupportedSummary,
} from "./dingtalk-page-model.js";
import type { DingTalkPageText } from "./dingtalk-page-strings.js";

export function createElementNode<K extends keyof HTMLElementTagNameMap>(
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

export function createIcon(
  document: Document,
  icon: IconNode,
  size = 16,
  className = "dingtalk-icon",
): SVGElement {
  const node = createElement(icon, {
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
    "stroke-width": 1.8,
  });
  node.classList.add(...className.split(" ").filter(Boolean));
  return node;
}

export function createIconButton(
  document: Document,
  label: string,
  icon: IconNode,
  options: { className?: string; size?: number } = {},
): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `dingtalk-icon-button${options.className ? ` ${options.className}` : ""}`;
  node.append(createIcon(document, icon, options.size ?? 18));
  node.setAttribute("aria-label", label);
  node.title = label;
  return node;
}

/** 36px rounded avatar whose soft tone is stable for the conversation. */
export function createAvatar(
  document: Document,
  conversation: Pick<DingTalkConversation, "conversationId" | "title">,
  size: 36 | 28 = 36,
): HTMLElement {
  const avatar = createElementNode(document, "span", `dingtalk-avatar dingtalk-avatar--${size}`);
  avatar.style.setProperty("--avatar-tone", avatarTone(conversation.conversationId));
  avatar.textContent = dingtalkInitial(conversation.title);
  return avatar;
}

function unreadBadge(document: Document, conversation: DingTalkConversation): HTMLElement | null {
  if (conversation.muted) {
    const dot = createElementNode(document, "span", "dingtalk-muted-dot");
    dot.setAttribute("aria-label", "免打扰");
    dot.title = "免打扰";
    return dot;
  }
  if (conversation.unreadCount <= 0) return null;
  const badge = createElementNode(
    document,
    "span",
    "dingtalk-unread",
    conversation.unreadCount > 99 ? "99+" : String(conversation.unreadCount),
  );
  badge.setAttribute("aria-label", `${conversation.unreadCount} 条未读`);
  return badge;
}

export function createConversationRow(
  document: Document,
  conversation: DingTalkConversation,
  text: DingTalkPageText,
  active: boolean,
  onSelect: () => void,
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "dingtalk-conversation";
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(active));
  row.classList.toggle("dingtalk-conversation--active", active);
  const copy = createElementNode(document, "span", "dingtalk-conversation-copy");
  const line = createElementNode(document, "span", "dingtalk-conversation-line");
  const title = createElementNode(
    document,
    "span",
    "dingtalk-conversation-title",
    conversation.title || text.unnamed,
  );
  title.title = conversation.title || text.unnamed;
  const time = createElementNode(
    document,
    "span",
    "dingtalk-conversation-time",
    formatDingTalkTime(conversation.lastMessageAt),
  );
  line.append(title, time);
  const meta = createElementNode(document, "span", "dingtalk-conversation-meta");
  const preview = createElementNode(
    document,
    "span",
    "dingtalk-conversation-preview",
    conversation.preview ?? (conversation.singleChat ? text.direct : text.group),
  );
  meta.append(preview);
  const badge = unreadBadge(document, conversation);
  if (badge) meta.append(badge);
  copy.append(line, meta);
  row.append(createAvatar(document, conversation), copy);
  row.addEventListener("click", onSelect);
  return row;
}

export function appendHighlighted(
  document: Document,
  container: HTMLElement,
  value: string,
  query: string,
): void {
  for (const segment of highlightSegments(value, query)) {
    if (!segment.match) {
      container.append(document.createTextNode(segment.text));
      continue;
    }
    const mark = createElementNode(document, "mark", "dingtalk-search-mark", segment.text);
    container.append(mark);
  }
}

export function createSearchConversationRow(
  document: Document,
  conversation: DingTalkConversation,
  text: DingTalkPageText,
  query: string,
  onSelect: () => void,
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "dingtalk-search-result dingtalk-search-result--conversation";
  const copy = createElementNode(document, "span", "dingtalk-search-copy");
  const title = createElementNode(document, "span", "dingtalk-search-title");
  appendHighlighted(document, title, conversation.title || text.unnamed, query);
  const preview = createElementNode(document, "span", "dingtalk-search-preview");
  appendHighlighted(
    document,
    preview,
    conversation.preview ?? (conversation.singleChat ? text.direct : text.group),
    query,
  );
  copy.append(title, preview);
  const time = createElementNode(
    document,
    "span",
    "dingtalk-search-time",
    formatDingTalkTime(conversation.lastMessageAt),
  );
  row.append(createAvatar(document, conversation, 28), copy, time);
  row.addEventListener("click", onSelect);
  return row;
}

export function createSearchMessageRow(
  document: Document,
  message: DingTalkMessage,
  conversationTitle: string,
  query: string,
  onSelect: () => void,
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "dingtalk-search-result dingtalk-search-result--message";
  const copy = createElementNode(document, "span", "dingtalk-search-copy");
  const head = createElementNode(document, "span", "dingtalk-search-heading-line");
  const title = createElementNode(document, "span", "dingtalk-search-title", conversationTitle);
  const sender = createElementNode(
    document,
    "span",
    "dingtalk-search-sender",
    message.mine ? "我" : message.senderName,
  );
  const time = createElementNode(
    document,
    "span",
    "dingtalk-search-time",
    formatDingTalkClock(message.createdAt),
  );
  head.append(title, sender, time);
  const body = createElementNode(document, "span", "dingtalk-search-preview");
  if (message.unsupported) body.textContent = unsupportedSummary(message);
  else appendHighlighted(document, body, message.text.replace(/\s+/gu, " ").trim(), query);
  copy.append(head, body);
  row.append(copy);
  row.addEventListener("click", onSelect);
  return row;
}

export interface MessageRowOptions {
  continuation: boolean;
  selected: boolean;
  onSelect(checked: boolean): void;
  onRetry?(): void;
}

export function createMessageRow(
  document: Document,
  message: DingTalkMessage & { pending?: boolean; failed?: boolean },
  text: DingTalkPageText,
  options: MessageRowOptions,
): HTMLElement {
  const row = createElementNode(document, "div", "dingtalk-message");
  row.dataset.messageId = message.messageId;
  row.classList.toggle("dingtalk-message--mine", message.mine);
  row.classList.toggle("dingtalk-message--continuation", options.continuation);
  row.classList.toggle("dingtalk-message--selected", options.selected);
  row.classList.toggle("dingtalk-message--pending", Boolean(message.pending));
  row.classList.toggle("dingtalk-message--failed", Boolean(message.failed));

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "dingtalk-message-check";
  check.checked = options.selected;
  check.setAttribute("aria-label", text.selectMessage);
  check.title = text.selectMessage;
  check.addEventListener("change", () => options.onSelect(check.checked));

  if (!message.mine && !options.continuation) {
    const sender = createElementNode(document, "span", "dingtalk-message-avatar");
    sender.style.setProperty(
      "--avatar-tone",
      avatarTone(`${message.senderId ?? message.senderName}`),
    );
    sender.textContent = dingtalkInitial(message.senderName || "?");
    row.append(check, sender);
  } else if (!message.mine) {
    row.append(check, createElementNode(document, "span", "dingtalk-message-avatar-spacer"));
  } else {
    row.append(check);
  }

  const body = createElementNode(document, "div", "dingtalk-message-body");
  if (!options.continuation && !message.mine) {
    const meta = createElementNode(document, "div", "dingtalk-message-meta");
    meta.append(
      createElementNode(document, "span", "dingtalk-message-sender", message.senderName),
      createElementNode(
        document,
        "span",
        "dingtalk-message-time",
        formatDingTalkClock(message.createdAt),
      ),
    );
    body.append(meta);
  } else if (!options.continuation && message.mine) {
    const meta = createElementNode(
      document,
      "div",
      "dingtalk-message-meta dingtalk-message-meta--mine",
    );
    meta.append(
      createElementNode(
        document,
        "span",
        "dingtalk-message-time",
        formatDingTalkClock(message.createdAt),
      ),
    );
    body.append(meta);
  }

  const line = createElementNode(document, "div", "dingtalk-message-line");
  const bubble = createElementNode(document, "div", "dingtalk-message-bubble");
  if (message.unsupported) {
    bubble.append(
      createElementNode(
        document,
        "span",
        "dingtalk-message-unsupported",
        unsupportedSummary(message),
      ),
    );
  } else {
    bubble.append(createElementNode(document, "span", "dingtalk-message-text", message.text));
  }
  if (message.pending) {
    bubble.append(createElementNode(document, "span", "dingtalk-send-spinner"));
  }
  if (message.failed) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "dingtalk-send-retry";
    retry.textContent = "!";
    retry.setAttribute("aria-label", text.retrySend);
    retry.title = text.sendFailed;
    retry.addEventListener("click", () => options.onRetry?.());
    line.append(bubble, retry);
  } else {
    line.append(bubble);
  }
  body.append(line);
  row.append(body);
  return row;
}

export function createDateSeparator(
  document: Document,
  value: number,
  now = Date.now(),
): HTMLElement {
  const separator = createElementNode(document, "div", "dingtalk-date-separator");
  separator.append(
    createElementNode(
      document,
      "span",
      "dingtalk-date-separator-label",
      formatDingTalkDateLabel(value, now),
    ),
  );
  return separator;
}

export function createListEmpty(
  document: Document,
  message: string,
  action?: { label: string; onClick(): void },
): HTMLElement {
  const empty = createElementNode(document, "div", "dingtalk-empty-list");
  empty.append(createElementNode(document, "span", "dingtalk-empty-text", message));
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dingtalk-text-button";
    button.textContent = action.label;
    button.addEventListener("click", action.onClick);
    empty.append(button);
  }
  return empty;
}

export function createListSkeleton(document: Document): HTMLElement {
  const skeleton = createElementNode(document, "div", "dingtalk-skeleton-list");
  for (let index = 0; index < 6; index += 1) {
    const row = createElementNode(document, "div", "dingtalk-skeleton-row");
    const avatar = createElementNode(
      document,
      "span",
      "dingtalk-skeleton dingtalk-skeleton-avatar",
    );
    const copy = createElementNode(document, "span", "dingtalk-skeleton-copy");
    copy.append(
      createElementNode(
        document,
        "span",
        "dingtalk-skeleton dingtalk-skeleton-line dingtalk-skeleton-line--title",
      ),
      createElementNode(
        document,
        "span",
        "dingtalk-skeleton dingtalk-skeleton-line dingtalk-skeleton-line--preview",
      ),
    );
    row.append(avatar, copy);
    skeleton.append(row);
  }
  return skeleton;
}

export function createMessageSkeleton(document: Document): HTMLElement {
  const skeleton = createElementNode(document, "div", "dingtalk-message-skeleton");
  for (let index = 0; index < 3; index += 1) {
    const row = createElementNode(
      document,
      "div",
      `dingtalk-message-skeleton-row${index === 1 ? " dingtalk-message-skeleton-row--mine" : ""}`,
    );
    row.append(createElementNode(document, "span", "dingtalk-skeleton dingtalk-skeleton-bubble"));
    skeleton.append(row);
  }
  return skeleton;
}
