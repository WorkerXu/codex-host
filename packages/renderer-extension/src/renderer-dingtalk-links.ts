/**
 * Agent replies may contain `dingtalk://conversation/…` or
 * `dingtalk://message/…` links. Clicking one opens the workbench page and asks
 * the mounted page to scroll to and highlight the referenced message.
 */
import { requestDingTalkReveal } from "./settings/dingtalk-page.js";

const ANCHOR_SELECTOR = 'a[href^="dingtalk://"]';

export interface ParsedDingTalkLink {
  conversationId: string;
  messageIds: string[];
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseDingTalkHref(href: string): ParsedDingTalkLink | null {
  if (!href.startsWith("dingtalk://")) return null;
  const rest = href.slice("dingtalk://".length);
  const separator = rest.indexOf("/");
  if (separator <= 0) return null;
  const kind = rest.slice(0, separator);
  const tail = rest.slice(separator + 1).replace(/[?#].*$/u, "");
  if (kind === "conversation") return { conversationId: decode(tail), messageIds: [] };
  if (kind !== "message") return null;
  const last = tail.lastIndexOf("/");
  if (last <= 0) return { conversationId: decode(tail), messageIds: [] };
  const conversationId = decode(tail.slice(0, last));
  const messageIds = tail
    .slice(last + 1)
    .split(",")
    .map(decode)
    .filter(Boolean);
  return { conversationId, messageIds };
}

export function installRendererDingTalkLinks(ownerDocument: Document): () => void {
  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    const anchor =
      target instanceof Element ? target.closest<HTMLAnchorElement>(ANCHOR_SELECTOR) : null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    const parsed = parseDingTalkHref(href);
    if (!parsed) return;
    event.preventDefault();
    event.stopPropagation();
    requestDingTalkReveal({
      conversationId: parsed.conversationId,
      ...(parsed.messageIds.length > 0 ? { messageIds: parsed.messageIds } : {}),
    });
    const shell = (
      window as Window & {
        __codexhostSettingsShellV1?: {
          openSettings(opener?: HTMLElement, pageId?: string): boolean;
        };
      }
    ).__codexhostSettingsShellV1;
    shell?.openSettings(anchor, "dingtalk");
  };
  ownerDocument.addEventListener("click", onClick, true);
  return () => ownerDocument.removeEventListener("click", onClick, true);
}
