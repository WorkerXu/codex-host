import EllipsisIcon from "lucide/dist/esm/icons/ellipsis.mjs";
import LogInIcon from "lucide/dist/esm/icons/log-in.mjs";
import RefreshIcon from "lucide/dist/esm/icons/refresh-cw.mjs";

import type { DingTalkConversation } from "@codexhost/shared-contracts";

import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import { createElementNode, createIcon, createIconButton } from "./dingtalk-page-view.js";
import { createDingTalkAnchoredMenu } from "./dingtalk-anchored-menu.js";

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

/** Header keeps only icon actions: embed and a small overflow menu. */
export function createDingTalkMainHeader(options: DingTalkMainHeaderOptions): DingTalkMainHeader {
  const { document, text } = options;
  const element = createElementNode(document, "div", "dingtalk-main-head");
  const copy = createElementNode(document, "div", "dingtalk-main-copy");
  const titleLine = createElementNode(document, "div", "dingtalk-main-title-line");
  const title = createElementNode(document, "div", "dingtalk-main-title", text.selectConversation);
  const tag = createElementNode(document, "span", "dingtalk-main-tag", "内部群");
  tag.hidden = true;
  titleLine.append(title, tag);
  const subtitle = createElementNode(document, "div", "dingtalk-main-subtitle");
  subtitle.hidden = true;
  copy.append(titleLine, subtitle);
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
  const menu = createElementNode(document, "div", "dingtalk-header-menu");
  menu.setAttribute("role", "menu");
  const placement = createDingTalkAnchoredMenu(menu, more, "right");
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
    closeMenu: placement.close,
    setConversation(conversation) {
      title.textContent = conversation?.title || text.selectConversation;
      title.title = conversation?.title ?? "";
      tag.hidden = conversation?.groupType !== "INTERNAL_GROUP";
      const secondary =
        conversation === null
          ? ""
          : conversation.singleChat
            ? ""
            : typeof conversation.memberCount === "number" && conversation.memberCount > 0
              ? `${conversation.memberCount} 人`
              : "";
      subtitle.textContent = secondary;
      subtitle.hidden = secondary.length === 0;
      embed.disabled = conversation === null;
      refresh.disabled = conversation === null;
    },
  };
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    placement.toggle();
  });
  return api;
}
