import type { DingTalkMessage, DingTalkResourceResult } from "@codexhost/shared-contracts";

import {
  continuesDingTalkGroup,
  dayKey,
  mergeDingTalkMessages,
  type ViewMessage,
} from "./dingtalk-page-model.js";
import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import {
  createDateSeparator,
  createMessageRow,
  createTimeSeparator,
  dingtalkImageBox,
  showImageUnavailable,
} from "./dingtalk-page-view.js";

const GROUP_GAP_MS = 5 * 60_000;

export interface DingTalkMessageListOptions {
  document: Document;
  /** The scrolling transcript element. */
  container: HTMLElement;
  text: DingTalkPageText;
  loadResource(
    message: DingTalkMessage,
    resource: NonNullable<DingTalkMessage["resources"]>[number],
  ): Promise<DingTalkResourceResult>;
  onImageLoaded?(wasNearBottom: boolean): void;
  onImageClick?(
    message: DingTalkMessage,
    resource: NonNullable<DingTalkMessage["resources"]>[number],
  ): void;
  onRetry?(message: ViewMessage): void;
  /** Injectable object-URL hooks keep this testable outside the Desktop. */
  createObjectUrl?(blob: Blob): string;
  revokeObjectUrl?(url: string): void;
  decodeImage?(dataUrl: string): Promise<Blob | null>;
}

export interface DingTalkMessageList {
  readonly count: number;
  reset(
    messages: readonly ViewMessage[],
    behavior?: { scroll?: "bottom"; distance?: number },
  ): void;
  append(messages: readonly ViewMessage[]): void;
  prepend(messages: readonly ViewMessage[]): void;
  update(message: ViewMessage, previousId?: string): void;
  removeOldest(count: number): void;
  removeNewest(count: number): void;
  clear(): void;
  nodeFor(messageId: string): HTMLElement | null;
  lastMessage(): ViewMessage | undefined;
  dispose(): void;
}

/** Revokes image URLs even if a row disappears while a download is in flight. */
export class DingTalkObjectUrls {
  readonly #urls = new Set<string>();
  readonly #create: (blob: Blob) => string;
  readonly #revoke: (url: string) => void;

  constructor(create: (blob: Blob) => string, revoke: (url: string) => void) {
    this.#create = create;
    this.#revoke = revoke;
  }

  add(blob: Blob): string {
    const url = this.#create(blob);
    this.#urls.add(url);
    return url;
  }

  release(url: string): void {
    if (!this.#urls.delete(url)) return;
    try {
      this.#revoke(url);
    } catch {
      /* Revocation is best effort. */
    }
  }

  releaseAll(): void {
    for (const url of [...this.#urls]) this.release(url);
  }

  get size(): number {
    return this.#urls.size;
  }
}

interface Entry {
  message: ViewMessage;
  nodes: HTMLElement[];
  row: HTMLElement;
  objectUrls: string[];
  removed: boolean;
}

interface LoadedImage {
  entry: Entry;
  message: DingTalkMessage;
  resource: NonNullable<DingTalkMessage["resources"]>[number];
}

export async function decodeDingTalkDataUrl(dataUrl: string): Promise<Blob | null> {
  try {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/u.exec(dataUrl);
    if (!match) return null;
    const mimeType = match[1] || "application/octet-stream";
    if (!match[2]) {
      return new Blob([decodeURIComponent(match[3] ?? "")], { type: mimeType });
    }
    const binary = atob(match[3] ?? "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
}

/**
 * Incremental transcript owner. Appending a message touches one row; loading
 * an older page prepends rows and re-renders only the old first row, whose
 * separator/continuation header changed.
 */
export function createDingTalkMessageList(
  options: DingTalkMessageListOptions,
): DingTalkMessageList {
  const { document, container, text } = options;
  const objectUrls = new DingTalkObjectUrls(
    options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob)),
    options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url)),
  );
  const entries = new Map<string, Entry>();
  const order: string[] = [];
  const pendingImages = new WeakMap<HTMLElement, LoadedImage>();
  const imageObserver =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (records) => {
            for (const record of records) {
              if (!record.isIntersecting) continue;
              const frame = record.target as HTMLElement;
              imageObserver?.unobserve(frame);
              const pending = pendingImages.get(frame);
              pendingImages.delete(frame);
              if (pending) void loadImage(frame, pending);
            }
          },
          { root: container, rootMargin: "120px" },
        );

  const distanceFromBottom = (): number =>
    container.scrollHeight - container.scrollTop - container.clientHeight;

  const createEntry = (previous: ViewMessage | undefined, message: ViewMessage): Entry => {
    const nodes: HTMLElement[] = [];
    let suppressTime = false;
    let continuation = false;
    if (!previous) {
      nodes.push(createDateSeparator(document, message.createdAt));
    } else if (dayKey(previous.createdAt) !== dayKey(message.createdAt)) {
      nodes.push(createDateSeparator(document, message.createdAt));
    } else if (message.createdAt - previous.createdAt > GROUP_GAP_MS) {
      nodes.push(createTimeSeparator(document, message.createdAt));
      suppressTime = true;
    } else {
      continuation = continuesDingTalkGroup(previous, message);
    }
    const entry: Entry = {
      message,
      nodes,
      row: document.createElement("div"),
      objectUrls: [],
      removed: false,
    };
    const row = createMessageRow(document, message, text, {
      continuation,
      suppressTime,
      onRetry: () => options.onRetry?.(message),
      ...(options.onImageClick ? { onImageClick: options.onImageClick } : {}),
      attachImage: (frame, imageMessage, resource) => {
        if (!imageObserver) {
          void loadImage(frame, { entry, message: imageMessage, resource });
          return;
        }
        pendingImages.set(frame, { entry, message: imageMessage, resource });
        imageObserver.observe(frame);
      },
    });
    entry.row = row;
    nodes.push(row);
    return entry;
  };

  const releaseEntry = (entry: Entry): void => {
    entry.removed = true;
    for (const url of entry.objectUrls) objectUrls.release(url);
    entry.objectUrls = [];
    pendingImages.delete(entry.row);
    for (const node of entry.nodes) node.remove();
  };

  const rebuild = (messageId: string, previous: ViewMessage | undefined): void => {
    const entry = entries.get(messageId);
    if (!entry) return;
    const nextNode = entry.nodes[entry.nodes.length - 1]?.nextSibling ?? null;
    releaseEntry(entry);
    const replacement = createEntry(previous, entry.message);
    entries.set(messageId, replacement);
    const fragment = document.createDocumentFragment();
    for (const node of replacement.nodes) fragment.append(node);
    container.insertBefore(fragment, nextNode);
  };

  const showImage = (frame: HTMLElement, image: HTMLImageElement, nearBottom: boolean): void => {
    if (!frame.isConnected) return;
    const box = dingtalkImageBox(image.naturalWidth || 1, image.naturalHeight || 1);
    frame.style.width = `${box.width}px`;
    frame.style.height = `${box.height}px`;
    frame.classList.remove("dingtalk-message-image--loading");
    frame.classList.add("dingtalk-message-image--loaded");
    frame.replaceChildren(image);
    options.onImageLoaded?.(nearBottom);
  };

  const loadImage = async (frame: HTMLElement, pending: LoadedImage): Promise<void> => {
    const nearBottom = distanceFromBottom() <= 80;
    const result = await options.loadResource(pending.message, pending.resource).catch(() => null);
    if (pending.entry.removed || !frame.isConnected) return;
    if (!result?.available || !result.dataUrl) {
      showImageUnavailable(document, frame);
      return;
    }
    const blob = await (options.decodeImage ?? decodeDingTalkDataUrl)(result.dataUrl).catch(
      () => null,
    );
    if (!blob || pending.entry.removed || !frame.isConnected) {
      if (!blob) showImageUnavailable(document, frame);
      return;
    }
    const url = objectUrls.add(blob);
    if (pending.entry.removed || !frame.isConnected) {
      objectUrls.release(url);
      return;
    }
    pending.entry.objectUrls.push(url);
    const image = document.createElement("img");
    image.className = "dingtalk-message-image-content";
    image.alt = pending.message.text || "图片";
    image.onload = () => showImage(frame, image, nearBottom);
    image.onerror = () => {
      objectUrls.release(url);
      pending.entry.objectUrls = pending.entry.objectUrls.filter((value) => value !== url);
      if (frame.isConnected) showImageUnavailable(document, frame);
    };
    image.src = url;
  };

  const entryList = (messages: readonly ViewMessage[], firstPrevious?: ViewMessage): Entry[] => {
    const created: Entry[] = [];
    let previous = firstPrevious;
    for (const message of messages) {
      const entry = createEntry(previous, message);
      created.push(entry);
      previous = message;
    }
    return created;
  };

  const newMessages = (messages: readonly ViewMessage[]): ViewMessage[] => {
    const unique = mergeDingTalkMessages([], messages);
    for (const message of unique) {
      const entry = entries.get(message.messageId);
      if (entry && JSON.stringify(entry.message) !== JSON.stringify(message)) api.update(message);
    }
    return unique.filter((message) => !entries.has(message.messageId));
  };

  const api: DingTalkMessageList = {
    get count() {
      return order.length;
    },
    reset(messages, behavior) {
      api.clear();
      const created = entryList(mergeDingTalkMessages([], messages));
      const fragment = document.createDocumentFragment();
      for (const entry of created) {
        entries.set(entry.message.messageId, entry);
        order.push(entry.message.messageId);
        for (const node of entry.nodes) fragment.append(node);
      }
      container.append(fragment);
      if (behavior?.scroll === "bottom") {
        container.scrollTop = container.scrollHeight;
      } else if (behavior?.distance !== undefined) {
        container.scrollTop = container.scrollHeight - behavior.distance;
      }
    },
    append(messages) {
      const fresh = newMessages(messages);
      const lastId = order.at(-1);
      const previous = lastId ? entries.get(lastId)?.message : undefined;
      const created = entryList(fresh, previous);
      const fragment = document.createDocumentFragment();
      for (const entry of created) {
        entries.set(entry.message.messageId, entry);
        order.push(entry.message.messageId);
        for (const node of entry.nodes) fragment.append(node);
      }
      container.append(fragment);
    },
    prepend(messages) {
      const fresh = newMessages(messages);
      if (fresh.length === 0) return;
      const firstId = order[0];
      const firstEntry = firstId ? entries.get(firstId) : undefined;
      const nextNode = firstEntry?.nodes[0] ?? null;
      const created = entryList(fresh);
      const fragment = document.createDocumentFragment();
      for (const entry of created) {
        entries.set(entry.message.messageId, entry);
        for (const node of entry.nodes) fragment.append(node);
      }
      order.unshift(...created.map((entry) => entry.message.messageId));
      container.insertBefore(fragment, nextNode);
      if (firstId) {
        rebuild(firstId, created[created.length - 1]?.message);
      }
    },
    update(message, previousId) {
      const oldId = previousId ?? message.messageId;
      const index = order.indexOf(oldId);
      if (index < 0) return;
      const entry = entries.get(oldId);
      if (oldId !== message.messageId && entries.has(message.messageId)) {
        if (entry) releaseEntry(entry);
        entries.delete(oldId);
        order.splice(index, 1);
        api.update(message);
        return;
      }
      if (entry) entry.message = message;
      if (oldId !== message.messageId) {
        entries.delete(oldId);
        order[index] = message.messageId;
        if (entry) entries.set(message.messageId, entry);
      }
      const beforeId = index > 0 ? order[index - 1] : undefined;
      rebuild(message.messageId, beforeId ? entries.get(beforeId)?.message : undefined);
    },
    removeOldest(count) {
      const removed = order.splice(0, count);
      for (const id of removed) {
        const entry = entries.get(id);
        if (!entry) continue;
        entries.delete(id);
        releaseEntry(entry);
      }
      const firstId = order[0];
      if (firstId) rebuild(firstId, undefined);
    },
    removeNewest(count) {
      const removed = order.splice(Math.max(0, order.length - count));
      for (const id of removed) {
        const entry = entries.get(id);
        if (!entry) continue;
        entries.delete(id);
        releaseEntry(entry);
      }
    },
    clear() {
      for (const entry of entries.values()) releaseEntry(entry);
      entries.clear();
      order.length = 0;
      container.replaceChildren();
    },
    nodeFor(messageId) {
      return entries.get(messageId)?.row ?? null;
    },
    lastMessage() {
      const id = order.at(-1);
      return id ? entries.get(id)?.message : undefined;
    },
    dispose() {
      imageObserver?.disconnect();
      api.clear();
      objectUrls.releaseAll();
    },
  };
  return api;
}
