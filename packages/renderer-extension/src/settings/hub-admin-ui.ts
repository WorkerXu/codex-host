import { hubSelect } from "./hub-admin-menu.js";
import { createRendererSettingsIcon, type RendererSettingsIconName } from "./icons.js";
export { hubSelect } from "./hub-admin-menu.js";
import { hubErrorText, type RendererHubAdminClient } from "../renderer-hub-admin-client.js";
import type { RendererSettingsPageMountContext } from "./core.js";

export function hubElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}
export function hubButton(
  document: Document,
  text: string,
  action: () => void,
  primary = false,
): HTMLButtonElement {
  const button = hubElement(document, "button", primary ? "hub-primary" : "hub-secondary", text);
  button.type = "button";
  button.addEventListener("click", action);
  return button;
}
export function hubField(
  document: Document,
  parent: HTMLElement,
  title: string,
  value = "",
  multiline = false,
): HTMLInputElement | HTMLTextAreaElement {
  const label = hubElement(document, "label", "hub-field");
  label.append(hubElement(document, "span", "", title));
  const input = multiline ? hubElement(document, "textarea") : hubElement(document, "input");
  input.value = value;
  label.append(input);
  parent.append(label);
  return input;
}
export function hubFieldError(input: HTMLElement, message: string): void {
  const parent = input.parentElement;
  if (!parent) return;
  let error = parent.querySelector<HTMLElement>(".hub-field-error");
  if (!error) {
    error = hubElement(input.ownerDocument, "p", "hub-field-error");
    error.setAttribute("role", "alert");
    parent.append(error);
  }
  error.textContent = message;
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}
export function hubIconButton(
  document: Document,
  label: string,
  icon: RendererSettingsIconName,
  action: () => void,
): HTMLButtonElement {
  const button = hubButton(document, "", action);
  button.className = "hub-icon-button";
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
  button.append(createRendererSettingsIcon(icon, 16));
  return button;
}
export function hubSwitch(
  document: Document,
  label: string,
  checked: boolean,
  action: () => void,
): HTMLButtonElement {
  const button = hubButton(document, "", action);
  button.className = "hub-switch";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-checked", String(checked));
  return button;
}
export function hubDate(time: number | null, now = new Date()): string {
  if (time === null) return "—";
  const date = new Date(time < 100000000000 ? time * 1000 : time);
  const pad = (value: number) => String(value).padStart(2, "0");
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(midnight);
  yesterday.setDate(yesterday.getDate() - 1);
  const prefix =
    date >= midnight && date < new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      ? "今天"
      : date >= yesterday && date < midnight
        ? "昨天"
        : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${prefix} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function createHubPage(
  context: RendererSettingsPageMountContext,
  title: string,
  target: string,
  client: RendererHubAdminClient | null,
) {
  const document = context.content.ownerDocument;
  const page = hubElement(document, "div", "hub-page");
  const header = hubElement(document, "header", "agents-page-head");
  header.append(hubElement(document, "h2", "agents-page-title", title));
  const hosts = hubSelect(document, "主机", [["", "选择主机"]]);
  const headerControls = hubElement(document, "div", "hub-header-controls");
  headerControls.append(hosts);
  header.append(headerControls);
  const status = hubElement(document, "p", "hub-status", "正在连接…");
  status.setAttribute("role", "status");
  const body = hubElement(document, "div", "hub-body");
  page.append(header, status, body);
  context.content.append(page);
  let generation = 0;
  let selectionRevision = 0;
  let activeDialog: HTMLDialogElement | null = null;
  const closeDialog = () => {
    if (activeDialog) {
      activeDialog.close();
      activeDialog.remove();
      activeDialog = null;
    }
  };
  const dialog = (title: string, readOnly = false) => {
    closeDialog();
    const opener = document.activeElement?.shadowRoot?.activeElement as HTMLElement | null;
    const root = hubElement(document, "dialog", "hub-dialog");
    root.setAttribute("aria-label", title);
    const heading = hubElement(document, "h3", "", title);
    root.append(heading);
    const content = hubElement(document, "div", "hub-dialog-content");
    const error = hubElement(document, "p", "hub-status");
    error.setAttribute("role", "alert");
    const footer = hubElement(document, "footer", "hub-actions");
    const close = () => {
      if (activeDialog === root) closeDialog();
      opener?.focus();
    };
    footer.append(hubButton(document, readOnly ? "关闭" : "取消", close));
    root.append(content, error, footer);
    page.append(root);
    activeDialog = root;
    root.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!root.dataset.busy) close();
    });
    root.showModal();
    return { root, heading, content, footer, error, close };
  };
  const confirm = (title: string, detail: string, action: () => Promise<void>) => {
    const modal = dialog(title);
    modal.content.append(hubElement(document, "p", "", detail));
    const submit = hubButton(
      document,
      "确认",
      () => {
        submit.disabled = true;
        modal.root.dataset.busy = "true";
        modal.footer.querySelectorAll("button").forEach((button) => {
          button.disabled = true;
        });
        void action()
          .then(modal.close)
          .catch((error: unknown) => {
            delete modal.root.dataset.busy;
            modal.error.textContent = hubErrorText(error);
            modal.footer.querySelectorAll("button").forEach((button) => {
              button.disabled = false;
            });
          });
      },
      true,
    );
    modal.footer.append(submit);
  };
  const load = async (operation: () => Promise<void>) => {
    const current = ++generation;
    status.textContent = "正在加载…";
    body.inert = true;
    try {
      await operation();
      if (current === generation && !context.signal.aborted) status.textContent = "";
    } catch (error) {
      if (current === generation && !context.signal.aborted)
        status.textContent = hubErrorText(error);
    } finally {
      if (current === generation) body.inert = false;
    }
  };
  const initialize = async (refresh: () => void) => {
    hosts.addEventListener("change", () => {
      ++generation;
      ++selectionRevision;
      closeDialog();
      body.replaceChildren();
      refresh();
    });
    if (!client) {
      status.textContent = "连接失败";
      return;
    }
    try {
      const values = await client.hosts();
      if (context.signal.aborted) return;
      hosts.setOptions([
        ["", "选择主机"],
        ...values.map((host) => [host.hostId, host.displayName] as const),
      ]);
      const preferred = values.find(
        (host) => host.displayName.toLowerCase() === target || host.hostId === target,
      );
      hosts.value = preferred?.hostId ?? "";
      if (preferred) refresh();
      else status.textContent = `请选择 ${target} 所在主机`;
    } catch {
      status.textContent = "连接失败";
    }
  };
  context.signal.addEventListener(
    "abort",
    () => {
      for (const menu of page.querySelectorAll<HTMLElement>(".hub-select-menu")) {
        if (menu.matches(":popover-open")) menu.hidePopover();
      }
      closeDialog();
    },
    { once: true },
  );
  return {
    document,
    page,
    headerControls,
    body,
    status,
    hosts,
    dialog,
    confirm,
    load,
    initialize,
    current: () => !context.signal.aborted,
    revision: () => selectionRevision,
    valid: (host: string, revision: number) =>
      !context.signal.aborted && hosts.value === host && revision === selectionRevision,
  };
}
export type HubPage = ReturnType<typeof createHubPage>;
