import type { DingTalkMember } from "@codexhost/shared-contracts";
import AtSignIcon from "lucide/dist/esm/icons/at-sign.mjs";

import { createAvatar, createElementNode, createIcon } from "./dingtalk-page-view.js";
import type { DingTalkPageText } from "./dingtalk-page-strings.js";

export interface DingTalkMentionChoice {
  openDingTalkId: string | null;
  name: string;
  all: boolean;
}

export interface DingTalkMentionPickerOptions {
  document: Document;
  text: DingTalkPageText;
  onPick(choice: DingTalkMentionChoice): void;
}

export interface DingTalkMentionPicker {
  readonly element: HTMLElement;
  render(
    query: string,
    state: "loading" | "ready" | "error",
    members: readonly DingTalkMember[],
  ): void;
  move(step: number): void;
  active(): DingTalkMentionChoice | null;
  isOpen(): boolean;
  close(): void;
  dispose(): void;
}

const MAX_ROWS = 8;
const ALL: DingTalkMentionChoice = { openDingTalkId: null, name: "所有人", all: true };

/** Small member picker opened by typing `@` in the workbench composer. */
export function createDingTalkMentionPicker(
  options: DingTalkMentionPickerOptions,
): DingTalkMentionPicker {
  const { document, text } = options;
  const element = createElementNode(document, "div", "dingtalk-mention-picker");
  element.hidden = true;
  element.setAttribute("role", "listbox");
  element.setAttribute("aria-label", text.mentionMembers);
  const head = createElementNode(document, "div", "dingtalk-mention-picker-head");
  head.textContent = text.mentionMembers;
  const body = createElementNode(document, "div", "dingtalk-mention-picker-body");
  element.append(head, body);

  let choices: DingTalkMentionChoice[] = [];
  let cursor = 0;
  let open = false;

  const applyCursor = (): void => {
    const rows = [...body.querySelectorAll<HTMLElement>(".dingtalk-mention-option")];
    rows.forEach((row, index) => {
      row.classList.toggle("dingtalk-mention-option--active", index === cursor);
      row.setAttribute("aria-selected", String(index === cursor));
    });
    rows[cursor]?.scrollIntoView({ block: "nearest" });
  };

  const renderRows = (): void => {
    body.replaceChildren();
    if (choices.length === 0) {
      body.append(createElementNode(document, "div", "dingtalk-mention-empty", ""));
      return;
    }
    for (const [index, choice] of choices.entries()) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dingtalk-mention-option";
      row.setAttribute("role", "option");
      if (choice.all) {
        const avatar = createElementNode(document, "span", "dingtalk-mention-avatar");
        avatar.append(createIcon(document, AtSignIcon, 18));
        row.append(
          avatar,
          createElementNode(document, "span", "dingtalk-mention-name", text.mentionAll),
        );
      } else {
        row.append(
          createAvatar(
            document,
            {
              conversationId: choice.openDingTalkId ?? choice.name,
              title: choice.name,
              singleChat: true,
            },
            28,
          ),
          createElementNode(document, "span", "dingtalk-mention-name", choice.name),
        );
      }
      row.addEventListener("pointermove", () => {
        cursor = index;
        applyCursor();
      });
      row.addEventListener("click", () => {
        options.onPick(choice);
      });
      body.append(row);
    }
    if (cursor >= choices.length) cursor = Math.max(0, choices.length - 1);
    applyCursor();
  };

  return {
    element,
    render(query, state, members) {
      element.hidden = false;
      open = true;
      const needle = query.trim().toLowerCase();
      if (state === "loading") {
        choices = [];
        body.replaceChildren(
          createElementNode(document, "div", "dingtalk-mention-empty", text.membersLoading),
        );
        return;
      }
      if (state === "error") {
        choices = [];
        body.replaceChildren(
          createElementNode(document, "div", "dingtalk-mention-empty", text.membersFailed),
        );
        return;
      }
      const allMatches =
        needle.length === 0 || "所有人".includes(needle) || "all".startsWith(needle);
      const people = members
        .filter((member) => {
          if (!needle) return true;
          return (
            member.name.toLowerCase().includes(needle) ||
            (member.title ?? "").toLowerCase().includes(needle)
          );
        })
        .slice(0, allMatches ? MAX_ROWS - 1 : MAX_ROWS)
        .map((member) => ({
          openDingTalkId: member.openDingTalkId,
          name: member.name,
          all: false,
        }));
      choices = allMatches ? [ALL, ...people] : people;
      if (choices.length === 0) {
        body.replaceChildren(
          createElementNode(document, "div", "dingtalk-mention-empty", text.noMatchingMembers),
        );
        return;
      }
      renderRows();
    },
    move(step) {
      if (!open || choices.length === 0) return;
      cursor = (cursor + step + choices.length) % choices.length;
      applyCursor();
    },
    active() {
      return open ? (choices[cursor] ?? null) : null;
    },
    isOpen: () => open,
    close() {
      open = false;
      cursor = 0;
      choices = [];
      element.hidden = true;
      body.replaceChildren();
    },
    dispose() {
      this.close();
      element.remove();
    },
  };
}
