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
