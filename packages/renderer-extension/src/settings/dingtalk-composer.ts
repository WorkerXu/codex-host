import SendIcon from "lucide/dist/esm/icons/send.mjs";

import type { DingTalkMember, DingTalkMembersResult } from "@codexhost/shared-contracts";

import {
  createDingTalkMentionPicker,
  type DingTalkMentionChoice,
} from "./dingtalk-mention-picker.js";
import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import { createAvatar, createElementNode, createIcon } from "./dingtalk-page-view.js";

export interface DingTalkComposerSend {
  /** Wire content, including `<@id>` / `<@all>` placeholders. */
  text: string;
  /** Readable optimistic bubble text. */
  displayText: string;
  atOpenDingTalkIds: string[];
  atAll: boolean;
}

export interface DingTalkComposerOptions {
  document: Document;
  text: DingTalkPageText;
  onSend(payload: DingTalkComposerSend): void;
  isGroup(): boolean;
  loadMembers(): Promise<DingTalkMembersResult>;
}

export interface DingTalkComposer {
  readonly element: HTMLElement;
  reset(): void;
  setPlaceholder(name: string): void;
  dispose(): void;
}

interface SelectedMember {
  id: string;
  name: string;
}

const MAX_MENTION_QUERY = 30;

/** Composer-like input above the conversation with native group `@` mentions. */
export function createDingTalkComposer(options: DingTalkComposerOptions): DingTalkComposer {
  const { document, text } = options;
  const area = createElementNode(document, "div", "dingtalk-composer-area");
  const chips = createElementNode(document, "div", "dingtalk-composer-chips");
  chips.hidden = true;
  const composer = createElementNode(document, "div", "dingtalk-composer");
  const input = createElementNode(document, "textarea", "dingtalk-composer-input");
  input.rows = 1;
  input.spellcheck = false;
  const send = document.createElement("button");
  send.type = "button";
  send.className = "dingtalk-send-button";
  send.append(createIcon(document, SendIcon, 17));
  send.setAttribute("aria-label", text.send);
  send.title = text.send;
  send.disabled = true;

  const picker = createDingTalkMentionPicker({
    document,
    text,
    onPick: (choice) => {
      pickFromPicker(choice);
    },
  });

  let selected: SelectedMember[] = [];
  let atAll = false;
  let members: DingTalkMember[] | null = null;
  let membersError = false;
  let loading = false;
  let pickerGeneration = 0;
  let lastRange: { start: number; end: number; query: string } | null = null;

  const updateSend = (): void => {
    send.disabled = input.value.trim().length === 0 && selected.length === 0 && !atAll;
  };

  const renderChips = (): void => {
    chips.replaceChildren();
    chips.hidden = selected.length === 0 && !atAll;
    if (chips.hidden) return;
    if (atAll) {
      const chip = createElementNode(document, "span", "dingtalk-composer-chip");
      const avatar = createElementNode(document, "span", "dingtalk-composer-chip-avatar", "所");
      chip.append(
        avatar,
        createElementNode(document, "span", "dingtalk-chip-name", text.mentionAll),
      );
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "dingtalk-composer-chip-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", text.removeMention);
      remove.addEventListener("click", () => {
        atAll = false;
        renderChips();
        updateSend();
        input.focus();
      });
      chip.append(remove);
      chips.append(chip);
    }
    for (const member of selected) {
      const chip = createElementNode(document, "span", "dingtalk-composer-chip");
      chip.append(
        createAvatar(
          document,
          { conversationId: member.id, title: member.name, singleChat: true },
          28,
        ),
        createElementNode(document, "span", "dingtalk-chip-name", member.name),
      );
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "dingtalk-composer-chip-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", text.removeMention);
      remove.addEventListener("click", () => {
        selected = selected.filter(({ id }) => id !== member.id);
        renderChips();
        updateSend();
        input.focus();
      });
      chip.append(remove);
      chips.append(chip);
    }
  };

  const pick = (choice: DingTalkMentionChoice): void => {
    if (choice.all) {
      atAll = true;
    } else if (choice.openDingTalkId) {
      if (!selected.some(({ id }) => id === choice.openDingTalkId)) {
        selected = [...selected, { id: choice.openDingTalkId, name: choice.name }];
      }
    }
    picker.close();
    renderChips();
    updateSend();
    input.focus();
  };

  const triggerRange = (): { start: number; end: number; query: string } | null => {
    if (!options.isGroup()) return null;
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const start = before.lastIndexOf("@");
    if (start < 0) return null;
    const previous = before[start - 1];
    if (previous !== undefined && !/\s/u.test(previous)) return null;
    const query = before.slice(start + 1);
    if (query.length > MAX_MENTION_QUERY || /[\n\r]/u.test(query) || query.includes("@"))
      return null;
    return { start, end: caret, query };
  };

  const removeTrigger = (range: { start: number; end: number }): void => {
    const caret = range.end;
    input.value = input.value.slice(0, range.start) + input.value.slice(caret);
    const next = range.start;
    input.setSelectionRange(next, next);
  };

  const updatePicker = (): void => {
    const range = triggerRange();
    lastRange = range;
    if (!range) {
      picker.close();
      return;
    }
    if (members !== null) {
      picker.render(range.query, "ready", members);
      return;
    }
    if (membersError) {
      picker.render(range.query, "error", []);
      return;
    }
    if (!loading) {
      loading = true;
      const generation = ++pickerGeneration;
      void options
        .loadMembers()
        .then((result) => {
          if (generation !== pickerGeneration) return;
          loading = false;
          membersError = !result.available;
          members = result.members;
          const current = triggerRange();
          if (current) picker.render(current.query, membersError ? "error" : "ready", members);
        })
        .catch(() => {
          if (generation !== pickerGeneration) return;
          loading = false;
          membersError = true;
          const current = triggerRange();
          if (current) picker.render(current.query, "error", []);
        });
    }
    picker.render(range.query, "loading", []);
  };

  const grow = (): void => {
    input.style.height = "auto";
    const maximum = 6 * 20 + 18;
    input.style.height = `${Math.min(input.scrollHeight, maximum)}px`;
    input.style.overflowY = input.scrollHeight > maximum ? "auto" : "hidden";
  };

  const pickTriggered = (): void => {
    const choice = picker.active();
    if (!choice) return;
    pickFromPicker(choice);
  };

  function pickFromPicker(choice: DingTalkMentionChoice): void {
    const range = lastRange ?? triggerRange();
    if (range) removeTrigger(range);
    lastRange = null;
    pick(choice);
    grow();
  }

  input.addEventListener("input", () => {
    updateSend();
    grow();
    updatePicker();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && picker.isOpen() && !event.isComposing) {
      event.preventDefault();
      pickTriggered();
      return;
    }
    if (picker.isOpen()) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        picker.move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        picker.close();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        pickTriggered();
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    sendNow();
  });
  send.addEventListener("click", () => sendNow());

  function sendNow(): void {
    const payload = consume();
    if (!payload) return;
    clear();
    options.onSend(payload);
  }

  function consume(): DingTalkComposerSend | null {
    const typed = input.value.trim();
    if (!typed && selected.length === 0 && !atAll) return null;
    const placeholders = [...(atAll ? ["<@all>"] : []), ...selected.map(({ id }) => `<@${id}>`)];
    const content = [placeholders.join(" "), typed].filter(Boolean).join(" ");
    const names = [...(atAll ? ["@所有人"] : []), ...selected.map(({ name }) => `@${name}`)];
    const displayText = [names.join(" "), typed].filter(Boolean).join(" ");
    return {
      text: content,
      displayText,
      atOpenDingTalkIds: selected.map(({ id }) => id),
      atAll,
    };
  }

  function clear(): void {
    input.value = "";
    input.style.height = "";
    selected = [];
    atAll = false;
    renderChips();
    picker.close();
    updateSend();
  }

  area.append(chips, picker.element, composer);
  composer.append(input, send);

  return {
    element: area,
    reset() {
      clear();
      members = null;
      membersError = false;
      loading = false;
      pickerGeneration += 1;
    },
    setPlaceholder(name) {
      input.placeholder = text.sendPlaceholder.replace("{name}", name);
    },
    dispose() {
      picker.dispose();
    },
  };
}
