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
  const button = hubElement(
    document,
    "button",
    primary ? "agent-primary" : "agent-secondary",
    text,
  );
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
export function hubSelect(
  document: Document,
  label: string,
  values: readonly (readonly [string, string])[],
): HTMLSelectElement {
  const select = hubElement(document, "select");
  select.setAttribute("aria-label", label);
  for (const [value, text] of values) {
    const option = hubElement(document, "option", "", text);
    option.value = value;
    select.append(option);
  }
  return select;
}
export function hubDate(time: number | null): string {
  if (time === null) return "—";
  return new Date(time < 100000000000 ? time * 1000 : time).toLocaleString("zh-CN", {
    hour12: false,
  });
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
  header.append(hosts);
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
  const dialog = (title: string) => {
    closeDialog();
    const opener = document.activeElement?.shadowRoot?.activeElement as HTMLElement | null;
    const root = hubElement(document, "dialog", "hub-dialog");
    root.setAttribute("aria-label", title);
    root.append(hubElement(document, "h3", "", title));
    const content = hubElement(document, "div", "hub-dialog-content");
    const error = hubElement(document, "p", "hub-status");
    error.setAttribute("role", "alert");
    const footer = hubElement(document, "footer", "hub-actions");
    const close = () => {
      if (activeDialog === root) closeDialog();
      opener?.focus();
    };
    footer.append(hubButton(document, "取消", close));
    root.append(content, error, footer);
    page.append(root);
    activeDialog = root;
    root.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!root.dataset.busy) close();
    });
    root.showModal();
    return { root, content, footer, error, close };
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
      for (const host of values) {
        const option = hubElement(document, "option", "", host.displayName);
        option.value = host.hostId;
        hosts.append(option);
      }
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
  context.signal.addEventListener("abort", closeDialog, { once: true });
  return {
    document,
    page,
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
