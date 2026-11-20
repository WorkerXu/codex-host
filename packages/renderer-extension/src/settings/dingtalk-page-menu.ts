import RefreshIcon from "lucide/dist/esm/icons/refresh-cw.mjs";

import type { DingTalkStatus } from "@codexhost/shared-contracts";

import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import { createElementNode, createIcon, createIconButton } from "./dingtalk-page-view.js";
import EllipsisIcon from "lucide/dist/esm/icons/ellipsis.mjs";
import { createDingTalkAnchoredMenu } from "./dingtalk-anchored-menu.js";

export interface DingTalkPageMenuOptions {
  document: Document;
  text: DingTalkPageText;
  onRefresh(): void;
  onRetry(): void;
}

export interface DingTalkPageMenu {
  readonly moreButton: HTMLButtonElement;
  readonly element: HTMLElement;
  readonly open: boolean;
  contains(node: Node): boolean;
  toggle(): void;
  close(): void;
  setStatus(status: DingTalkStatus | null): void;
}

/** The sidebar ⋯ menu: connection state and refresh. */
export function createDingTalkPageMenu(options: DingTalkPageMenuOptions): DingTalkPageMenu {
  const { document, text } = options;
  const moreButton = createIconButton(document, text.moreActions, EllipsisIcon, {
    className: "dingtalk-more-button",
  });
  const menu = createElementNode(document, "div", "dingtalk-page-menu");
  menu.setAttribute("role", "menu");
  const placement = createDingTalkAnchoredMenu(menu, moreButton);
  const statusRow = createElementNode(document, "div", "dingtalk-menu-status");
  const dot = createElementNode(document, "span", "dingtalk-menu-dot");
  const statusText = createElementNode(document, "span", "dingtalk-menu-status-text");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "dingtalk-menu-retry";
  retry.textContent = text.retry;
  retry.hidden = true;
  retry.addEventListener("click", () => options.onRetry());
  statusRow.append(dot, statusText, retry);
  const divider = createElementNode(document, "div", "dingtalk-menu-divider");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "dingtalk-menu-action";
  refresh.append(
    createIcon(document, RefreshIcon, 15),
    createElementNode(document, "span", "", text.refreshConversations),
  );
  refresh.addEventListener("click", () => options.onRefresh());
  menu.append(statusRow, divider, refresh);

  const api: DingTalkPageMenu = {
    moreButton,
    element: menu,
    get open() {
      return !menu.hidden;
    },
    contains(node) {
      return menu.contains(node) || moreButton.contains(node);
    },
    toggle: placement.toggle,
    close: placement.close,
    setStatus(status) {
      const connected = status?.authenticated === true;
      dot.classList.toggle("dingtalk-menu-dot--error", !connected);
      if (connected) {
        const name = status.userName?.trim() || "";
        const corp = status.corpName?.trim() ? `（${status.corpName.trim()}）` : "";
        statusText.textContent = name
          ? `${text.menuConnected} · ${name}${corp}`
          : text.menuConnected;
      } else if (status?.errorCode === "not_logged_in") {
        statusText.textContent = text.menuNotLoggedIn;
      } else {
        statusText.textContent = text.menuServiceUnavailable;
      }
      statusText.title = statusText.textContent;
      retry.hidden = connected;
      placement.reposition();
    },
  };
  moreButton.addEventListener("click", (event) => {
    event.stopPropagation();
    api.toggle();
  });
  return api;
}
