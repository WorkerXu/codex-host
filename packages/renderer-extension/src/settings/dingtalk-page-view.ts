import type { IconNode } from "lucide";
import BellOffIcon from "lucide/dist/esm/icons/bell-off.mjs";
import BotIcon from "lucide/dist/esm/icons/bot.mjs";
import EllipsisIcon from "lucide/dist/esm/icons/ellipsis.mjs";
import MessagesSquareIcon from "lucide/dist/esm/icons/messages-square.mjs";
import ReplyIcon from "lucide/dist/esm/icons/reply.mjs";

import type {
  DingTalkConversation,
  DingTalkMessage,
  DingTalkMessageResource,
} from "@codexhost/shared-contracts";

import {
  avatarTone,
  dingtalkAvatarLabel,
  formatDingTalkClock,
  formatDingTalkDateLabel,
  formatDingTalkFileSize,
  formatDingTalkTime,
  formatDingTalkTimeMark,
  highlightSegments,
  unsupportedSummary,
} from "./dingtalk-page-model.js";
import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import { appendDingTalkMarkdown } from "./dingtalk-markdown.js";

const LONG_TEXT_LIMIT = 8_000;
const LONG_TEXT_PREVIEW = 1_500;

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

/** Builds the lucide icon node with this document, so test DOMs stay isolated. */
function appendIconNode(
  document: Document,
  parent: SVGElement | Element,
  node: IconNode[number],
): void {
  const tag = node[0];
  const attributes = node[1] as Record<string, unknown>;
  const children = (node as unknown as { 2?: IconNode })[2];
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  for (const child of children ?? []) appendIconNode(document, element, child);
  parent.appendChild(element);
}

export function createIcon(
  document: Document,
  icon: IconNode,
  size = 16,
  className = "dingtalk-icon",
): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    xmlns: "http://www.w3.org/2000/svg",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.8,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  })) {
    node.setAttribute(name, String(value));
  }
  for (const child of icon) appendIconNode(document, node, child);
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

/** 36px rounded-square avatar with the native DingTalk default treatment. */
export function createAvatar(
  document: Document,
  conversation: Pick<DingTalkConversation, "conversationId" | "title" | "singleChat">,
  size: 40 | 28 = 40,
): HTMLElement {
  const avatar = createElementNode(document, "span", `dingtalk-avatar dingtalk-avatar--${size}`);
  avatar.style.setProperty("--avatar-tone", avatarTone(conversation.conversationId));
  avatar.textContent = dingtalkAvatarLabel(conversation.title);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function unreadBadge(document: Document, conversation: DingTalkConversation): HTMLElement | null {
  if (conversation.unreadCount <= 0) return null;
  if (conversation.muted) {
    const dot = createElementNode(document, "span", "dingtalk-avatar-unread");
    dot.setAttribute("aria-label", `${conversation.unreadCount} 条未读`);
    return dot;
  }
  const badge = createElementNode(
    document,
    "span",
    "dingtalk-unread-badge",
    conversation.unreadCount > 99 ? "99+" : String(conversation.unreadCount),
  );
  badge.setAttribute("aria-label", `${conversation.unreadCount} 条未读`);
  return badge;
}

function internalTag(document: Document): HTMLElement {
  return createElementNode(document, "span", "dingtalk-conversation-tag", "内部群");
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
  row.addEventListener("click", onSelect);
  updateConversationRow(document, row, conversation, text, active);
  return row;
}

/** Rewrites one row in place so list updates never rebuild the whole column. */
export function updateConversationRow(
  document: Document,
  row: HTMLButtonElement,
  conversation: DingTalkConversation,
  text: DingTalkPageText,
  active: boolean,
): void {
  row.dataset.conversationId = conversation.conversationId;
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
  line.append(title);
  if (conversation.groupType === "INTERNAL_GROUP") line.append(internalTag(document));
  const time = createElementNode(
    document,
    "span",
    "dingtalk-conversation-time",
    formatDingTalkTime(conversation.lastMessageAt),
  );
  line.append(time);
  const meta = createElementNode(document, "span", "dingtalk-conversation-meta");
  if (conversation.muted && conversation.unreadCount > 0) {
    meta.append(
      createElementNode(
        document,
        "span",
        "dingtalk-conversation-count",
        `[${conversation.unreadCount} 条]`,
      ),
    );
  }
  if (conversation.atMe) {
    meta.append(createElementNode(document, "span", "dingtalk-conversation-at-me", "[有人@我]"));
  }
  const preview = createElementNode(
    document,
    "span",
    "dingtalk-conversation-preview",
    conversation.preview ?? "",
  );
  meta.append(preview);
  if (conversation.muted) {
    const muted = createIcon(
      document,
      BellOffIcon,
      13,
      "dingtalk-icon dingtalk-conversation-muted",
    );
    muted.setAttribute("aria-label", "消息免打扰");
    meta.append(muted);
  }
  copy.append(line, meta);
  const avatar = createElementNode(document, "span", "dingtalk-avatar-wrap");
  avatar.append(createAvatar(document, conversation));
  const badge = unreadBadge(document, conversation);
  if (badge) avatar.append(badge);
  row.replaceChildren(avatar, copy);
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
  // The title owns the full first line (up to two lines); tags, member count
  // and time move to the gray meta line so similar group names stay distinct.
  const title = createElementNode(document, "span", "dingtalk-search-title");
  appendHighlighted(document, title, conversation.title || text.unnamed, query);
  const meta = createElementNode(document, "span", "dingtalk-search-meta");
  if (conversation.groupType === "INTERNAL_GROUP") meta.append(internalTag(document));
  if (!conversation.singleChat && typeof conversation.memberCount === "number") {
    meta.append(
      createElementNode(
        document,
        "span",
        "dingtalk-search-meta-text",
        `${conversation.memberCount} 人`,
      ),
    );
  }
  const timeText = formatDingTalkTime(conversation.lastMessageAt);
  if (timeText) {
    meta.append(createElementNode(document, "span", "dingtalk-search-meta-text", timeText));
  }
  const preview = createElementNode(document, "span", "dingtalk-search-preview");
  if (conversation.preview) appendHighlighted(document, preview, conversation.preview, query);
  copy.append(title, meta);
  if (conversation.preview) copy.append(preview);
  row.append(createAvatar(document, conversation, 28), copy);
  row.addEventListener("click", onSelect);
  return row;
}

function messageSearchSummary(message: DingTalkMessage): string {
  const image = message.resources?.find(({ kind }) => kind === "image");
  if (image) return "[图片]";
  const file = message.resources?.find(({ kind }) => kind === "file");
  if (file) return file.name ? `[文件] ${file.name}` : "[文件]";
  if (message.cardTitle) return message.cardTitle;
  return message.text.replace(/\s+/gu, " ").trim();
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
  const summary = messageSearchSummary(message);
  if (message.unsupported && !summary) body.textContent = unsupportedSummary(message);
  else appendHighlighted(document, body, summary, query);
  copy.append(head, body);
  row.append(copy);
  row.addEventListener("click", onSelect);
  return row;
}

export interface MessageDispatchedAgent {
  fileName: string;
  name: string;
  threadId: string;
}

export interface MessageRowOptions {
  continuation: boolean;
  /** The centered time separator already carries this group's time. */
  suppressTime?: boolean;
  onRetry?(): void;
  /** Hover toolbar and context menu actions; every action covers this message only. */
  onDispatch?(message: DingTalkMessage): void;
  onReply?(message: DingTalkMessage): void;
  onMenu?(message: DingTalkMessage, anchor: HTMLButtonElement): void;
  /** Right-clicking the row opens the same menu at its toolbar button. */
  onContextMenu?(message: DingTalkMessage, anchor: HTMLButtonElement): void;
  /** Agents this message was manually dispatched to in this page session. */
  dispatchedAgents?(message: DingTalkMessage): readonly MessageDispatchedAgent[];
  onOpenThread?(threadId: string): void;
  /** Hands the empty image frame to the list controller for viewport loading. */
  attachImage?(
    frame: HTMLElement,
    message: DingTalkMessage,
    resource: DingTalkMessageResource,
  ): void;
  onImageClick?(message: DingTalkMessage, resource: DingTalkMessageResource): void;
}

function appendFileChip(
  document: Document,
  parent: HTMLElement,
  resource: DingTalkMessageResource,
): void {
  const chip = createElementNode(document, "span", "dingtalk-message-file");
  const name = createElementNode(
    document,
    "span",
    "dingtalk-message-file-name",
    resource.name || "文件",
  );
  chip.append(name);
  const size = formatDingTalkFileSize(resource.sizeBytes);
  if (size) chip.append(createElementNode(document, "span", "dingtalk-message-file-size", size));
  parent.append(chip);
}

export function dingtalkImageBox(width: number, height: number): { width: number; height: number } {
  const maxWidth = 240;
  const maxHeight = 240;
  const minWidth = 120;
  const minHeight = 80;
  const scale = Math.min(maxWidth / width, maxHeight / height);
  let fittedWidth = width * scale;
  let fittedHeight = height * scale;
  if (fittedWidth < minWidth) {
    fittedHeight *= minWidth / fittedWidth;
    fittedWidth = minWidth;
  }
  if (fittedHeight < minHeight) {
    fittedWidth *= minHeight / fittedHeight;
    fittedHeight = minHeight;
  }
  if (fittedWidth > maxWidth) {
    fittedHeight *= maxWidth / fittedWidth;
    fittedWidth = maxWidth;
  }
  if (fittedHeight > maxHeight) {
    fittedWidth *= maxHeight / fittedHeight;
    fittedHeight = maxHeight;
  }
  return { width: Math.round(fittedWidth), height: Math.round(fittedHeight) };
}

export function showImageUnavailable(document: Document, frame: HTMLElement): void {
  frame.classList.remove("dingtalk-message-image--loading", "dingtalk-message-image--loaded");
  frame.classList.add("dingtalk-message-image--unavailable");
  frame.parentElement?.classList.remove("dingtalk-message-bubble--image");
  frame.style.removeProperty("width");
  frame.style.removeProperty("height");
  frame.replaceChildren(
    createElementNode(document, "span", "dingtalk-message-image-fallback", "[图片] 在手机上查看"),
  );
}

function appendImage(
  document: Document,
  parent: HTMLElement,
  message: DingTalkMessage,
  resource: DingTalkMessageResource,
  options: MessageRowOptions,
): void {
  const frame = createElementNode(
    document,
    "span",
    "dingtalk-message-image dingtalk-message-image--loading",
  );
  if (options.onImageClick) {
    frame.classList.add("dingtalk-message-image--clickable");
    frame.setAttribute("role", "button");
    frame.tabIndex = 0;
    const open = (): void => options.onImageClick?.(message, resource);
    frame.addEventListener("click", open);
    frame.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  }
  frame.append(
    createElementNode(document, "span", "dingtalk-skeleton dingtalk-message-image-skeleton"),
  );
  parent.append(frame);
  if (!options.attachImage) {
    showImageUnavailable(document, frame);
    return;
  }
  try {
    options.attachImage(frame, message, resource);
  } catch {
    showImageUnavailable(document, frame);
  }
}

function bubbleContent(
  document: Document,
  bubble: HTMLElement,
  message: DingTalkMessage & { pending?: boolean; failed?: boolean },
  options: MessageRowOptions,
): void {
  if (message.quotedMessage) {
    const quote = createElementNode(document, "div", "dingtalk-message-quote");
    quote.append(
      createElementNode(
        document,
        "span",
        "dingtalk-message-quote-sender",
        message.quotedMessage.senderName || "未知成员",
      ),
      createElementNode(
        document,
        "span",
        "dingtalk-message-quote-text",
        message.quotedMessage.text || "[消息]",
      ),
    );
    bubble.append(quote);
  }
  for (const resource of message.resources ?? []) {
    if (resource.kind === "image") appendImage(document, bubble, message, resource, options);
    else appendFileChip(document, bubble, resource);
  }
  if (message.cardTitle) {
    bubble.classList.add("dingtalk-message-bubble--card");
    bubble.append(
      createElementNode(document, "div", "dingtalk-message-card-title", message.cardTitle),
    );
  }
  if (message.text.length > LONG_TEXT_LIMIT) {
    // Very long bodies are kept as one plain text node; building markdown for
    // tens of thousands of characters is what froze the Desktop.
    const preview = createElementNode(
      document,
      "div",
      "dingtalk-message-text dingtalk-message-text--long",
      `${message.text.slice(0, LONG_TEXT_PREVIEW)}…`,
    );
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "dingtalk-message-expand";
    expand.textContent = "展开";
    expand.addEventListener("click", () => {
      preview.textContent = message.text;
      expand.remove();
    });
    bubble.append(preview, expand);
  } else if (message.format === "markdown") {
    const markdown = createElementNode(document, "div", "dingtalk-message-markdown");
    appendDingTalkMarkdown(document, markdown, message.text);
    bubble.append(markdown);
  } else if (message.text) {
    bubble.append(createElementNode(document, "span", "dingtalk-message-text", message.text));
  }
  if (!message.text && !message.cardTitle && !(message.resources?.length ?? 0)) {
    bubble.append(
      createElementNode(
        document,
        "span",
        "dingtalk-message-unsupported",
        unsupportedSummary(message),
      ),
    );
  }
  if (message.pending) {
    bubble.append(createElementNode(document, "span", "dingtalk-send-spinner"));
  }
}

export function createMessageRow(
  document: Document,
  message: DingTalkMessage & { pending?: boolean; failed?: boolean },
  text: DingTalkPageText,
  options: MessageRowOptions,
): HTMLElement {
  try {
    return buildMessageRow(document, message, text, options);
  } catch {
    return createPlainMessageRow(document, message, text, options);
  }
}

function createPlainMessageRow(
  document: Document,
  message: DingTalkMessage & { pending?: boolean; failed?: boolean },
  _text: DingTalkPageText,
  options: MessageRowOptions,
): HTMLElement {
  const row = createElementNode(document, "div", "dingtalk-message dingtalk-message--plain");
  row.dataset.messageId = message.messageId;
  row.classList.toggle("dingtalk-message--mine", message.mine);
  row.classList.toggle("dingtalk-message--failed", Boolean(message.failed));
  const body = createElementNode(document, "div", "dingtalk-message-body");
  const bubble = createElementNode(document, "div", "dingtalk-message-bubble");
  bubble.append(
    createElementNode(
      document,
      "span",
      "dingtalk-message-text",
      message.text.slice(0, LONG_TEXT_PREVIEW) || unsupportedSummary(message),
    ),
  );
  if (message.failed) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "dingtalk-send-retry";
    retry.textContent = "!";
    retry.addEventListener("click", () => options.onRetry?.());
    body.append(bubble, retry);
  } else {
    body.append(bubble);
  }
  row.append(body);
  return row;
}

function buildMessageRow(
  document: Document,
  message: DingTalkMessage & { pending?: boolean; failed?: boolean },
  text: DingTalkPageText,
  options: MessageRowOptions,
): HTMLElement {
  const row = createElementNode(document, "div", "dingtalk-message");
  row.dataset.messageId = message.messageId;
  row.classList.toggle("dingtalk-message--mine", message.mine);
  row.classList.toggle("dingtalk-message--continuation", options.continuation);
  row.classList.toggle("dingtalk-message--pending", Boolean(message.pending));
  row.classList.toggle("dingtalk-message--failed", Boolean(message.failed));
  row.classList.toggle("dingtalk-message--bot", Boolean(message.bot));
  row.classList.toggle("dingtalk-message--card", Boolean(message.cardTitle));

  if (!message.mine && !options.continuation) {
    const sender = createElementNode(document, "span", "dingtalk-message-avatar");
    sender.style.setProperty("--avatar-tone", avatarTone(message.senderId ?? message.senderName));
    if (message.bot) sender.append(createIcon(document, BotIcon, 18, "dingtalk-bot-avatar-icon"));
    else sender.textContent = dingtalkAvatarLabel(message.senderName || "?");
    row.append(sender);
  } else if (!message.mine) {
    row.append(createElementNode(document, "span", "dingtalk-message-avatar-spacer"));
  }

  const body = createElementNode(document, "div", "dingtalk-message-body");
  if (!options.continuation && !message.mine) {
    const meta = createElementNode(document, "div", "dingtalk-message-meta");
    meta.append(createElementNode(document, "span", "dingtalk-message-sender", message.senderName));
    if (message.bot) {
      meta.append(createElementNode(document, "span", "dingtalk-bot-tag", "机器人"));
    }
    if (!options.suppressTime) {
      meta.append(
        createElementNode(
          document,
          "span",
          "dingtalk-message-time",
          formatDingTalkClock(message.createdAt),
        ),
      );
    }
    body.append(meta);
  } else if (!options.continuation && message.mine && !options.suppressTime) {
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
  const imageOnly =
    (message.resources?.length ?? 0) > 0 &&
    (message.resources ?? []).every((resource) => resource.kind === "image") &&
    !message.text.trim() &&
    !message.cardTitle &&
    !message.quotedMessage &&
    !(message.reactions?.length ?? 0);
  if (imageOnly) bubble.classList.add("dingtalk-message-bubble--image");
  bubbleContent(document, bubble, message, options);
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
  if (options.onDispatch || options.onReply || options.onMenu) {
    const actions = createElementNode(document, "div", "dingtalk-message-actions");
    if (options.onDispatch) {
      const dispatch = createIconButton(document, text.dispatchAgent, BotIcon, {
        className: "dingtalk-message-action",
        size: 15,
      });
      dispatch.addEventListener("click", () => options.onDispatch?.(message));
      actions.append(dispatch);
    }
    if (options.onReply) {
      const reply = createIconButton(document, text.replyMessage, ReplyIcon, {
        className: "dingtalk-message-action",
        size: 15,
      });
      reply.addEventListener("click", () => options.onReply?.(message));
      actions.append(reply);
    }
    if (options.onMenu) {
      const more = createIconButton(document, text.messageMenu, EllipsisIcon, {
        className: "dingtalk-message-action dingtalk-message-action--menu",
        size: 15,
      });
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        options.onMenu?.(message, more);
      });
      actions.append(more);
    }
    line.append(actions);
    if (options.onContextMenu) {
      row.addEventListener("contextmenu", (event) => {
        if (message.pending || message.failed) return;
        const anchor = actions.querySelector<HTMLButtonElement>(".dingtalk-message-action--menu");
        if (!anchor) return;
        event.preventDefault();
        options.onContextMenu?.(message, anchor);
      });
    }
  }
  body.append(line);
  const dispatchedAgents = options.dispatchedAgents?.(message) ?? [];
  if (dispatchedAgents.length > 0) {
    const mark = createElementNode(document, "div", "dingtalk-message-dispatched");
    mark.append(
      createElementNode(document, "span", "dingtalk-message-dispatched-label", text.dispatchedTo),
    );
    for (const agent of dispatchedAgents) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "dingtalk-message-dispatched-agent";
      chip.textContent = agent.name;
      chip.title = text.openAgentThread.replace("{name}", agent.name);
      chip.addEventListener("click", () => options.onOpenThread?.(agent.threadId));
      mark.append(chip);
    }
    body.append(mark);
  }
  if (message.reactions && message.reactions.length > 0) {
    const reactions = createElementNode(document, "div", "dingtalk-message-reactions");
    for (const reaction of message.reactions) {
      const chip = createElementNode(document, "span", "dingtalk-reaction");
      chip.append(
        createElementNode(document, "span", "dingtalk-reaction-emoji", reaction.emoji),
        createElementNode(document, "span", "dingtalk-reaction-count", String(reaction.count)),
      );
      reactions.append(chip);
    }
    body.append(reactions);
  }
  row.append(body);
  return row;
}

export function createDateSeparator(
  document: Document,
  value: number,
  now = Date.now(),
): HTMLElement {
  const separator = createElementNode(document, "div", "dingtalk-date-separator");
  separator.dataset.separator = "date";
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

export function createTimeSeparator(document: Document, value: number): HTMLElement {
  const separator = createElementNode(document, "div", "dingtalk-time-separator");
  separator.dataset.separator = "time";
  separator.append(
    createElementNode(
      document,
      "span",
      "dingtalk-time-separator-label",
      formatDingTalkTimeMark(value),
    ),
  );
  return separator;
}

/** Rows shown at the top of the transcript while the previous page is loading. */
export function createOlderMessagesSkeleton(document: Document): HTMLElement {
  const skeleton = createElementNode(document, "div", "dingtalk-older-skeleton");
  for (const width of ["72%", "54%", "64%"]) {
    const row = createElementNode(document, "div", "dingtalk-older-skeleton-row");
    const line = createElementNode(document, "span", "dingtalk-skeleton dingtalk-skeleton-line");
    line.style.width = width;
    row.append(
      createElementNode(document, "span", "dingtalk-skeleton dingtalk-skeleton-avatar"),
      line,
    );
    skeleton.append(row);
  }
  return skeleton;
}

export function createConversationEmpty(document: Document, message: string): HTMLElement {
  const empty = createListEmpty(document, message);
  empty.classList.add("dingtalk-conversation-empty");
  empty.prepend(createIcon(document, MessagesSquareIcon, 48, "dingtalk-conversation-empty-icon"));
  return empty;
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
