import SendIcon from "lucide/dist/esm/icons/send.mjs";

import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import { createElementNode, createIcon } from "./dingtalk-page-view.js";

export interface DingTalkComposerOptions {
  document: Document;
  text: DingTalkPageText;
  onSend(): void;
  onEmbedSelected(): void;
  onCancelSelection(): void;
}

export interface DingTalkComposer {
  readonly element: HTMLElement;
  readonly input: HTMLTextAreaElement;
  value(): string;
  clear(): void;
  focus(): void;
  setPlaceholder(name: string): void;
  setSendEnabled(enabled: boolean): void;
  setSelection(selectedCount: number, hasConversation: boolean): void;
}

/** Composer-like input plus the multi-select bar that replaces it. */
export function createDingTalkComposer(options: DingTalkComposerOptions): DingTalkComposer {
  const { document, text } = options;
  const area = createElementNode(document, "div", "dingtalk-composer-area");
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
  composer.append(input, send);

  const selectionBar = createElementNode(document, "div", "dingtalk-selection-bar");
  const count = createElementNode(document, "span", "dingtalk-selection-count");
  const embed = document.createElement("button");
  embed.type = "button";
  embed.className = "dingtalk-text-button dingtalk-selection-embed";
  embed.textContent = text.embedToConversation;
  embed.addEventListener("click", options.onEmbedSelected);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dingtalk-text-button";
  cancel.textContent = text.cancelSelection;
  cancel.addEventListener("click", options.onCancelSelection);
  selectionBar.append(
    count,
    createElementNode(document, "span", "dingtalk-selection-dot", "·"),
    embed,
    createElementNode(document, "span", "dingtalk-selection-dot", "·"),
    cancel,
  );
  selectionBar.hidden = true;
  area.append(composer, selectionBar);

  const grow = (): void => {
    input.style.height = "auto";
    const maximum = 6 * 20 + 18;
    input.style.height = `${Math.min(input.scrollHeight, maximum)}px`;
    input.style.overflowY = input.scrollHeight > maximum ? "auto" : "hidden";
  };
  input.addEventListener("input", () => {
    send.disabled = input.value.trim().length === 0;
    grow();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    options.onSend();
  });
  send.addEventListener("click", () => options.onSend());

  return {
    element: area,
    input,
    value: () => input.value.trim(),
    clear() {
      input.value = "";
      input.style.height = "";
      send.disabled = true;
    },
    focus: () => input.focus(),
    setPlaceholder(name) {
      input.placeholder = text.sendPlaceholder.replace("{name}", name);
    },
    setSendEnabled(enabled) {
      send.disabled = !enabled;
    },
    setSelection(selectedCount, hasConversation) {
      const selecting = selectedCount > 0;
      selectionBar.hidden = !selecting;
      composer.hidden = selecting || !hasConversation;
      count.textContent = text.selectedCount.replace("{count}", String(selectedCount));
      embed.disabled = selectedCount === 0;
    },
  };
}
