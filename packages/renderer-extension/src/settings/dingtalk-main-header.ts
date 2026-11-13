import EllipsisIcon from "lucide/dist/esm/icons/ellipsis.mjs";
import LogInIcon from "lucide/dist/esm/icons/log-in.mjs";
import RefreshIcon from "lucide/dist/esm/icons/refresh-cw.mjs";

import type { DingTalkConversation } from "@codexhost/shared-contracts";

import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import { createElementNode, createIcon, createIconButton } from "./dingtalk-page-view.js";

export interface DingTalkMainHeaderOptions {
  document: Document;
  text: DingTalkPageText;
  onEmbed(): void;
  onRefresh(): void;
}

export interface DingTalkMainHeader {
  readonly element: HTMLElement;
  readonly menuOpen: boolean;
  contains(node: Node): boolean;
  closeMenu(): void;
  setConversation(conversation: DingTalkConversation | null): void;
}

type ConversationMeta = DingTalkConversation & {
  memberCount?: number;
  department?: string;
};

/** Header keeps only icon actions: embed and a small overflow menu. */
export function createDingTalkMainHeader(options: DingTalkMainHeaderOptions): DingTalkMainHeader {
  const { document, text } = options;
  const element = createElementNode(document, "div", "dingtalk-main-head");
  const copy = createElementNode(document, "div", "dingtalk-main-copy");
  const title = createElementNode(document, "div", "dingtalk-main-title", text.selectConversation);
  const subtitle = createElementNode(document, "div", "dingtalk-main-subtitle");
  subtitle.hidden = true;
  copy.append(title, subtitle);
  const actions = createElementNode(document, "div", "dingtalk-main-actions");
  const embed = createIconButton(document, text.embedConversation, LogInIcon, {
    className: "dingtalk-embed-button",
    size: 17,
  });
  embed.disabled = true;
  embed.addEventListener("click", () => options.onEmbed());
  const more = createIconButton(document, text.moreActions, EllipsisIcon, {
    className: "dingtalk-more-button",
  });
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  const menu = createElementNode(document, "div", "dingtalk-header-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "dingtalk-menu-action";
  refresh.append(
    createIcon(document, RefreshIcon, 15),
    createElementNode(document, "span", "", text.refreshMessages),
  );
  refresh.disabled = true;
  refresh.addEventListener("click", () => {
    api.closeMenu();
    options.onRefresh();
  });
  menu.append(refresh);
  actions.append(embed, more);
  element.append(copy, actions, menu);

  const api: DingTalkMainHeader = {
    element,
    get menuOpen() {
      return !menu.hidden;
    },
    contains(node) {
      return menu.contains(node) || more.contains(node);
    },
    closeMenu() {
      menu.hidden = true;
      more.setAttribute("aria-expanded", "false");
    },
    setConversation(conversation) {
      const meta = conversation as ConversationMeta | null;
      title.textContent = conversation?.title || text.selectConversation;
      title.title = conversation?.title ?? "";
      const secondary =
        meta === null
          ? ""
          : meta.singleChat
            ? (meta.department ?? "")
            : typeof meta.memberCount === "number"
              ? `${meta.memberCount} 人`
              : "";
      subtitle.textContent = secondary;
      subtitle.hidden = secondary.length === 0;
      embed.disabled = conversation === null;
      refresh.disabled = conversation === null;
    },
  };
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    more.setAttribute("aria-expanded", String(!menu.hidden));
  });
  return api;
}
