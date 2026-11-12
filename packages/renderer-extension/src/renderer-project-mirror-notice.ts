const NOTICE_ATTRIBUTE = "data-codexhost-project-mirror-notice";

export type ProjectMirrorNoticeTone = "info" | "error";

export function showProjectMirrorNotice(
  document: Document,
  message: string,
  tone: ProjectMirrorNoticeTone = "info",
): void {
  const element = document.createElement("div");
  element.setAttribute(NOTICE_ATTRIBUTE, tone);
  element.setAttribute("role", "status");
  element.textContent = message;
  element.style.position = "fixed";
  element.style.right = "16px";
  element.style.bottom = "16px";
  element.style.zIndex = "2147483647";
  element.style.maxWidth = "360px";
  element.style.padding = "8px 12px";
  element.style.borderRadius = "8px";
  element.style.background = "var(--color-surface, #fff)";
  element.style.color =
    tone === "error" ? "var(--color-chart-red, #f85149)" : "var(--color-text, #111)";
  element.style.border = "1px solid var(--color-border, rgba(127,127,127,0.3))";
  element.style.boxShadow = "0 8px 24px rgba(0,0,0,0.2)";
  element.style.font = "400 13px/18px system-ui, sans-serif";
  document.body.append(element);
  document.defaultView?.setTimeout(() => element.remove(), tone === "error" ? 8_000 : 4_000);
}

/** First-use confirmation for the name-only heuristic; never persists on cancel. */
export function confirmProjectMirror(document: Document, projectName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("data-codexhost-project-mirror-confirm", "");
    dialog.style.padding = "0";
    dialog.style.border = "0";
    dialog.style.background = "transparent";

    const panel = document.createElement("div");
    panel.setAttribute("role", "document");
    panel.style.width = "min(420px, calc(100vw - 48px))";
    panel.style.padding = "16px";
    panel.style.borderRadius = "12px";
    panel.style.background = "var(--color-surface, #fff)";
    panel.style.color = "var(--color-text, #111)";
    panel.style.boxShadow = "0 20px 48px rgba(0,0,0,0.3)";
    panel.style.font = "400 13px/20px system-ui, sans-serif";

    const title = document.createElement("div");
    title.textContent = "启用跨机对话";
    title.style.font = "600 15px/22px system-ui, sans-serif";
    title.style.marginBottom = "8px";

    const body = document.createElement("div");
    body.textContent = `「${projectName}」看起来是在本机按名字自动创建的项目。启用后，在 Agent 菜单的「其他机器」里选择一台机器和 Harness，会在该机器创建同名项目并在那里打开新对话。`;
    body.style.color = "var(--color-text-secondary, #555)";
    body.style.marginBottom = "16px";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.style.padding = "6px 12px";
    cancel.style.border = "1px solid var(--color-border, rgba(127,127,127,0.4))";
    cancel.style.borderRadius = "6px";
    cancel.style.background = "transparent";
    cancel.style.color = "inherit";
    cancel.style.cursor = "pointer";

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "启用";
    confirm.style.padding = "6px 12px";
    confirm.style.border = "0";
    confirm.style.borderRadius = "6px";
    confirm.style.background = "#2f6fed";
    confirm.style.color = "#fff";
    confirm.style.cursor = "pointer";

    const finish = (value: boolean): void => {
      dialog.removeEventListener("cancel", onCancel);
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const onCancel = (event: Event): void => {
      event.preventDefault();
      finish(false);
    };
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", onCancel);

    actions.append(cancel, confirm);
    panel.append(title, body, actions);
    dialog.append(panel);
    document.body.append(dialog);
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute("open", "");
    }
    confirm.focus();
  });
}
