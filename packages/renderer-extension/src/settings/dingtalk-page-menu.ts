import RefreshIcon from "lucide/dist/esm/icons/refresh-cw.mjs";

import type { DingTalkSettings } from "@codexhost/shared-contracts";

import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import { createElementNode, createIcon, createIconButton } from "./dingtalk-page-view.js";
import EllipsisIcon from "lucide/dist/esm/icons/ellipsis.mjs";

export interface DingTalkPageMenuOptions {
  document: Document;
  text: DingTalkPageText;
  onRefresh(): void;
  onHostChange(host: string | null): void;
}

export interface DingTalkPageMenu {
  readonly moreButton: HTMLButtonElement;
  readonly element: HTMLElement;
  readonly open: boolean;
  contains(node: Node): boolean;
  toggle(): void;
  close(): void;
  setStatus(available: boolean, host: string): void;
  setError(message: string): void;
  setSettings(settings: DingTalkSettings): void;
  setHostDisabled(disabled: boolean): void;
}

/** The top-right ⋯ menu: connection state, login host and refresh. */
export function createDingTalkPageMenu(options: DingTalkPageMenuOptions): DingTalkPageMenu {
  const { document, text } = options;
  const moreButton = createIconButton(document, text.moreActions, EllipsisIcon, {
    className: "dingtalk-more-button",
  });
  moreButton.setAttribute("aria-haspopup", "menu");
  moreButton.setAttribute("aria-expanded", "false");

  const menu = createElementNode(document, "div", "dingtalk-page-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const statusRow = createElementNode(document, "div", "dingtalk-menu-status");
  const dot = createElementNode(document, "span", "dingtalk-menu-dot");
  const statusText = createElementNode(document, "span", "dingtalk-menu-status-text");
  statusRow.append(dot, statusText);
  const divider = createElementNode(document, "div", "dingtalk-menu-divider");
  const loginLabel = createElementNode(document, "div", "dingtalk-menu-label", text.menuLoginLabel);
  const hostSelect = createElementNode(document, "select", "dingtalk-host-select");
  hostSelect.setAttribute("aria-label", text.menuLoginLabel);
  hostSelect.addEventListener("change", () => options.onHostChange(hostSelect.value || null));
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "dingtalk-menu-action";
  refresh.append(
    createIcon(document, RefreshIcon, 15),
    createElementNode(document, "span", "", text.refreshConversations),
  );
  refresh.addEventListener("click", () => options.onRefresh());
  menu.append(statusRow, divider, loginLabel, hostSelect, refresh);

  const api: DingTalkPageMenu = {
    moreButton,
    element: menu,
    get open() {
      return !menu.hidden;
    },
    contains(node) {
      return menu.contains(node) || moreButton.contains(node);
    },
    toggle() {
      menu.hidden = !menu.hidden;
      moreButton.setAttribute("aria-expanded", String(!menu.hidden));
    },
    close() {
      menu.hidden = true;
      moreButton.setAttribute("aria-expanded", "false");
    },
    setStatus(available, host) {
      dot.classList.toggle("dingtalk-menu-dot--error", !available);
      statusText.textContent = available
        ? text.menuConnected.replace("{host}", host)
        : text.menuUnavailable;
    },
    setError(message) {
      dot.classList.add("dingtalk-menu-dot--error");
      statusText.textContent = message;
    },
    setHostDisabled(disabled) {
      hostSelect.disabled = disabled;
    },
    setSettings(settings) {
      hostSelect.replaceChildren();
      hostSelect.append(new Option(text.hostAuto, ""));
      for (const host of settings.hosts) {
        hostSelect.append(new Option(host.local ? text.hostLocal : host.name, host.name));
      }
      if (
        settings.defaultHost &&
        !settings.hosts.some((host) => host.name === settings.defaultHost)
      ) {
        hostSelect.append(new Option(settings.defaultHost, settings.defaultHost));
      }
      hostSelect.value = settings.defaultHost ?? "";
      hostSelect.title = text.hostEffective.replace("{name}", settings.effectiveHost);
    },
  };
  moreButton.addEventListener("click", (event) => {
    event.stopPropagation();
    api.toggle();
  });
  return api;
}
