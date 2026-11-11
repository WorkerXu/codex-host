export interface NativeThreadMenuAction {
  id: string;
  label: string;
  icon: Element | null;
  button: HTMLElement;
}

/** Enumerate the action buttons the native Thread row actually exposes. */
export function collectNativeThreadMenuActions(row: HTMLElement): NativeThreadMenuAction[] {
  const seen = new Set<string>();
  const actions: NativeThreadMenuAction[] = [];
  for (const button of row.querySelectorAll<HTMLElement>("button[aria-label]")) {
    const label = button.getAttribute("aria-label")?.trim();
    if (!label || seen.has(label)) continue;
    if (button.getAttribute("aria-haspopup") === "menu") continue;
    seen.add(label);
    actions.push({ id: label, label, icon: button.querySelector("svg"), button });
  }
  return actions;
}

function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
}

/** A local menu for actions that already exist on the native Thread row. */
export class ProjectGroupThreadMenu {
  readonly #document: Document;
  readonly #window: Window;
  #popover: HTMLElement | null = null;
  #cleanup: (() => void) | null = null;
  #listenerTimer: number | null = null;

  constructor(document: Document, window: Window) {
    this.#document = document;
    this.#window = window;
  }

  isOpen(): boolean {
    return this.#popover !== null;
  }

  open(
    anchor: HTMLElement,
    actions: readonly NativeThreadMenuAction[],
    onSelect: (action: NativeThreadMenuAction) => void,
  ): void {
    this.close();
    if (actions.length === 0) return;
    const rect = anchor.getBoundingClientRect();
    const popover = this.#document.createElement("div");
    popover.setAttribute("data-codexhost-project-groups-thread-menu", "");
    popover.setAttribute("role", "menu");
    popover.setAttribute("aria-label", "对话操作");
    style(popover, {
      position: "fixed",
      top: `${Math.max(8, Math.min(rect.bottom + 4, this.#window.innerHeight - 320))}px`,
      left: `${Math.max(8, Math.min(rect.right - 200, this.#window.innerWidth - 220))}px`,
      width: "200px",
      "max-height": "300px",
      overflow: "auto",
      "z-index": "2147483000",
      background: "var(--color-surface, #fff)",
      color: "var(--color-text, #111)",
      border: "1px solid var(--color-border, #d0d0d0)",
      "border-radius": "8px",
      "box-shadow": "0 10px 30px rgba(0,0,0,0.22)",
      padding: "4px",
      "font-size": "13px",
    });

    for (const action of actions) {
      const item = this.#document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.setAttribute("aria-label", action.label);
      style(item, {
        display: "flex",
        "align-items": "center",
        gap: "8px",
        width: "100%",
        border: "0",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        padding: "7px 8px",
        "border-radius": "5px",
        "text-align": "left",
        "font-size": "13px",
      });
      const icon = action.icon?.cloneNode(true);
      if (icon instanceof Element) {
        style(icon as HTMLElement, { width: "14px", height: "14px", flex: "0 0 auto" });
        item.append(icon);
      }
      const label = this.#document.createElement("span");
      label.textContent = action.label;
      style(label, { overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
      item.append(label);
      item.addEventListener("click", () => {
        this.close();
        onSelect(action);
      });
      popover.append(item);
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

  close(): void {
    if (this.#listenerTimer !== null) this.#window.clearTimeout(this.#listenerTimer);
    this.#listenerTimer = null;
    this.#cleanup?.();
    this.#cleanup = null;
    this.#popover?.remove();
    this.#popover = null;
  }

  dispose(): void {
    this.close();
  }
}
