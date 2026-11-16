export interface AgentMenuAnchorRect {
  top: number;
  bottom: number;
  right: number;
}

export interface AgentMenuPlacement {
  top: number;
  left: number;
}

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * Places the popover under the trigger, right-aligned, flipping above it when
 * the remaining space is too small.
 */
export function agentMenuPlacement(options: {
  anchor: AgentMenuAnchorRect;
  viewport: { width: number; height: number };
  menu: { width: number; height: number };
}): AgentMenuPlacement {
  const { anchor, viewport, menu } = options;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - menu.width - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(VIEWPORT_MARGIN, anchor.right - menu.width), maxLeft);
  const below = anchor.bottom + MENU_GAP;
  const above = anchor.top - menu.height - MENU_GAP;
  const top =
    below + menu.height + VIEWPORT_MARGIN <= viewport.height
      ? below
      : Math.max(VIEWPORT_MARGIN, above);
  return { top, left };
}

/**
 * Next item index for the menu's arrow keys; null means the key is not a menu
 * key and should keep its default behavior.
 */
export function agentMenuFocusIndex(current: number, key: string, count: number): number | null {
  if (count === 0) return null;
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export interface AgentMenuItem {
  label: string;
  danger?: boolean;
  run(): void;
}

export interface AgentMenuHandle {
  close(): void;
}

const MENU_WIDTH = 168;
const ROW_HEIGHT = 32;
const MENU_PADDING = 4;

export function openAgentMenu(options: {
  document: Document;
  view: Window;
  container: HTMLElement;
  anchor: HTMLElement;
  label: string;
  items: readonly AgentMenuItem[];
  onClose?(): void;
}): AgentMenuHandle {
  const { document, view, container, anchor, label, items } = options;
  const menu = document.createElement("div");
  menu.className = "agent-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);

  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `agent-menu-item${item.danger ? " agent-menu-item--danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.textContent = item.label;
    button.addEventListener("click", () => {
      close();
      item.run();
    });
    buttons.push(button);
    menu.append(button);
  }

  const height = buttons.length * ROW_HEIGHT + MENU_PADDING * 2;
  const placement = agentMenuPlacement({
    anchor: anchor.getBoundingClientRect(),
    viewport: { width: view.innerWidth, height: view.innerHeight },
    menu: { width: MENU_WIDTH, height },
  });
  menu.style.top = `${placement.top}px`;
  menu.style.left = `${placement.left}px`;
  container.append(menu);

  let disposed = false;
  const close = (): void => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("scroll", onScroll, true);
    view.removeEventListener("resize", close);
    menu.remove();
    anchor.focus();
    options.onClose?.();
  };

  // The menu lives inside the settings shadow root while this listener runs
  // on the outer document, so `event.target` is retargeted to the shadow host.
  // Only `composedPath()` still exposes the menu's own node.
  function onPointerDown(event: PointerEvent): void {
    if (event.composedPath().includes(menu)) return;
    close();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    const current = buttons.indexOf(
      (menu.getRootNode() as Document | ShadowRoot).activeElement as HTMLButtonElement,
    );
    const next = agentMenuFocusIndex(current, event.key, buttons.length);
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  function onScroll(event: Event): void {
    if (event.composedPath().includes(menu)) return;
    close();
  }

  // The opening click is still in flight; listen from the next task.
  const timer = view.setTimeout(() => {
    if (disposed) return;
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, true);
    view.addEventListener("resize", close);
    buttons[0]?.focus();
  }, 0);

  return {
    close() {
      view.clearTimeout(timer);
      close();
    },
  };
}
