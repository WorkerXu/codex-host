import type {
  MachineConnectionState,
  ProjectGroupProjectView,
  ProjectGroupView,
} from "./renderer-project-groups-model.js";

function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
}

function statusColor(state: MachineConnectionState): string {
  switch (state) {
    case "connected":
      return "var(--color-chart-green, #3fb950)";
    case "connecting":
      return "var(--color-chart-yellow, #d29922)";
    case "disconnected":
      return "var(--color-text-tertiary, #8b8b8b)";
    case "error":
      return "var(--color-chart-red, #f85149)";
    default:
      return "var(--color-text-tertiary, #8b8b8b)";
  }
}

export function newChatProjectDisabled(
  project: ProjectGroupProjectView,
  state: MachineConnectionState,
): boolean {
  return (
    project.project.missing !== null ||
    !project.newChatAvailable ||
    state === "disconnected" ||
    state === "error"
  );
}

export interface ProjectGroupNewChatPickerOptions {
  document: Document;
  window: Window;
  onSelect(project: ProjectGroupProjectView): void;
  onClosed?(): void;
}

export class ProjectGroupNewChatPicker {
  readonly #document: Document;
  readonly #window: Window;
  readonly #options: ProjectGroupNewChatPickerOptions;
  #popover: HTMLElement | null = null;

  constructor(options: ProjectGroupNewChatPickerOptions) {
    this.#document = options.document;
    this.#window = options.window;
    this.#options = options;
  }

  open(view: ProjectGroupView, anchor: HTMLElement): void {
    this.close();
    const rect = anchor.getBoundingClientRect();
    const popover = this.#document.createElement("div");
    popover.setAttribute("data-codexhost-project-groups-new-chat", "");
    popover.setAttribute("role", "menu");
    popover.setAttribute("aria-label", "选择新建对话的机器");
    style(popover, {
      position: "fixed",
      top: `${Math.max(8, Math.min(rect.bottom + 4, this.#window.innerHeight - 340))}px`,
      left: `${Math.min(rect.left, this.#window.innerWidth - 300)}px`,
      width: "280px",
      "max-height": "320px",
      overflow: "auto",
      "z-index": "2147483000",
      background: "var(--color-surface, #fff)",
      color: "var(--color-text, #111)",
      border: "1px solid var(--color-border, #d0d0d0)",
      "border-radius": "9px",
      "box-shadow": "0 10px 30px rgba(0,0,0,0.22)",
      padding: "6px",
      "font-size": "13px",
    });

    for (const machine of view.machines) {
      const header = this.#document.createElement("div");
      header.textContent = machine.label;
      style(header, {
        display: "flex",
        "align-items": "center",
        gap: "6px",
        padding: "5px 8px",
        color: "var(--color-text-secondary, #777)",
        "font-size": "11px",
      });
      const dot = this.#document.createElement("span");
      style(dot, {
        width: "6px",
        height: "6px",
        "border-radius": "999px",
        background: statusColor(machine.state),
        flex: "0 0 auto",
      });
      header.prepend(dot);
      popover.append(header);

      for (const project of machine.projects) {
        const label = project.project.entry?.label ?? project.project.member.label;
        const disabled = newChatProjectDisabled(project, machine.state);
        const row = this.#document.createElement("button");
        row.type = "button";
        row.disabled = disabled;
        row.textContent = label;
        row.setAttribute("role", "menuitem");
        style(row, {
          display: "flex",
          "align-items": "center",
          width: "100%",
          border: "0",
          background: "transparent",
          color: disabled ? "var(--color-text-tertiary, #999)" : "inherit",
          cursor: disabled ? "not-allowed" : "pointer",
          padding: "7px 8px",
          "border-radius": "6px",
          "text-align": "left",
          "font-size": "13px",
          opacity: disabled ? "0.6" : "1",
        });
        row.addEventListener("click", () => {
          if (disabled) return;
          this.close();
          this.#options.onSelect(project);
        });
        popover.append(row);
      }
    }

    this.#document.body.append(popover);
    this.#popover = popover;
    const onPointerDown = (event: PointerEvent): void => {
      if (!popover.contains(event.target as Node)) this.close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") this.close();
    };
    this.#listenerTimer = this.#window.setTimeout(() => {
      this.#listenerTimer = null;
      this.#document.addEventListener("pointerdown", onPointerDown, true);
      this.#document.addEventListener("keydown", onKeyDown, true);
    }, 0);
    this.#cleanup = () => {
      this.#document.removeEventListener("pointerdown", onPointerDown, true);
      this.#document.removeEventListener("keydown", onKeyDown, true);
    };
  }

  #cleanup: (() => void) | null = null;
  #listenerTimer: number | null = null;

  close(): void {
    const wasOpen = this.#popover !== null;
    if (this.#listenerTimer !== null) this.#window.clearTimeout(this.#listenerTimer);
    this.#listenerTimer = null;
    this.#cleanup?.();
    this.#cleanup = null;
    this.#popover?.remove();
    this.#popover = null;
    if (wasOpen) this.#options.onClosed?.();
  }

  dispose(): void {
    this.close();
  }
}
