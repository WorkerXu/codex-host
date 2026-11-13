import {
  dingtalkConversationPath,
  dingtalkMessagePath,
  formatDingTalkMentionLink,
  type DingTalkMention,
} from "@codexhost/shared-contracts";

import {
  insertNativeAgentMention,
  type NativeTextRange,
} from "./renderer-native-composer-controller.js";

let remembered: { editor: HTMLElement; hostId: string | null } | null = null;

export function rememberDingTalkComposer(editor: HTMLElement, hostId: string | null): void {
  remembered = { editor, hostId };
}

export function forgetDingTalkComposer(editor?: HTMLElement): void {
  if (editor && remembered?.editor !== editor) return;
  remembered = null;
}

/** Opens the workbench from the `@` row, remembering the Composer to embed into. */
export function openDingTalkWorkbench(editor: HTMLElement, hostId: string | null): boolean {
  const shell = (
    window as Window & {
      __codexhostSettingsShellV1?: { openSettings(opener?: HTMLElement, pageId?: string): boolean };
    }
  ).__codexhostSettingsShellV1;
  if (!shell?.openSettings(editor, "dingtalk")) return false;
  rememberDingTalkComposer(editor, hostId);
  return true;
}

function caretRange(editor: HTMLElement): NativeTextRange | null {
  const doc = editor.ownerDocument;
  const walker = doc.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data.length > 0) last = text;
  }
  if (!last) return null;
  return { node: last, start: last.data.length, end: last.data.length, expected: "" };
}

function dispatchPlainTextPaste(editor: HTMLElement, text: string): boolean {
  const view = editor.ownerDocument.defaultView;
  if (!view?.DataTransfer || !view.ClipboardEvent) return false;
  const data = new view.DataTransfer();
  data.setData("text/plain", text);
  const event = new view.ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: data,
  });
  editor.dispatchEvent(event);
  return event.defaultPrevented;
}

function focusEditor(editor: HTMLElement): void {
  editor.focus({ preventScroll: false });
  const selection = editor.ownerDocument.getSelection();
  const range = caretRange(editor);
  if (!selection || !range) return;
  const target = editor.ownerDocument.createRange();
  target.setStart(range.node, range.start);
  target.collapse(true);
  selection.removeAllRanges();
  selection.addRange(target);
}

/**
 * Inserts a native mention chip into the remembered Composer. The chip's path
 * is expanded by the Host on submission; the Markdown carrier is the fallback
 * when the native controller is unavailable.
 */
export function embedDingTalkMention(mention: DingTalkMention): boolean {
  const target = remembered;
  if (!target) return false;
  const editor = target.editor;
  if (!editor.isConnected) return false;
  const shell = (window as Window & { __codexhostSettingsShellV1?: { close(): void } })
    .__codexhostSettingsShellV1;
  shell?.close();
  const path =
    mention.kind === "conversation"
      ? dingtalkConversationPath(mention.conversationId)
      : dingtalkMessagePath(mention.conversationId, mention.messageIds);
  const displayName = mention.label;
  focusEditor(editor);
  const range = caretRange(editor);
  if (
    range &&
    insertNativeAgentMention(editor, range, {
      name: `dingtalk-${mention.kind === "conversation" ? "conversation" : "messages"}`,
      displayName,
      path,
    })
  ) {
    return true;
  }
  focusEditor(editor);
  const carrier = `${formatDingTalkMentionLink(mention)} `;
  if (!dispatchPlainTextPaste(editor, carrier)) {
    editor.ownerDocument.execCommand("insertText", false, carrier);
  }
  return true;
}
