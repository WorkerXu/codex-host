import { skillsClass } from "./skills-style.js";
export interface SkillsDialog {
  body: HTMLElement;
  footer: HTMLElement;
  close(): void;
  element: HTMLDialogElement;
}
export function skillsDialog(root: HTMLElement, title: string): SkillsDialog {
  const document = root.ownerDocument;
  const previous =
    root.getRootNode() instanceof ShadowRoot
      ? (root.getRootNode() as ShadowRoot).activeElement
      : document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = skillsClass("skills-dialog");
  const heading = document.createElement("h2");
  heading.textContent = title;
  heading.id = `skills-dialog-${Math.random().toString(36).slice(2)}`;
  dialog.setAttribute("aria-labelledby", heading.id);
  const body = document.createElement("div");
  body.className = skillsClass("skills-dialog-body");
  const footer = document.createElement("div");
  footer.className = skillsClass("skills-actions");
  const close = () => {
    dialog.close();
    dialog.remove();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.append(heading, body, footer);
  root.append(dialog);
  dialog.showModal();
  return { body, footer, close, element: dialog };
}
export function skillButton(
  document: Document,
  label: string,
  action: () => void,
  primary = false,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = primary
    ? "skills-button settings-command-button"
    : "skills-button settings-command-button settings-command-button--secondary";
  button.addEventListener("click", action);
  return button;
}
export function skillNode<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = skillsClass(className);
  return node;
}

export function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("skills_failed");
  return value;
}
