const GAP = 4;
const MARGIN = 8;

/** Positions both DingTalk overflow menus against their own trigger in viewport coordinates. */
export function createDingTalkAnchoredMenu(
  menu: HTMLElement,
  anchor: HTMLButtonElement,
  align: "left" | "right" = "left",
) {
  const document = anchor.ownerDocument;
  const view = document.defaultView;
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "false");
  menu.hidden = true;
  // The settings page has CSS containment; the top layer keeps viewport
  // coordinates independent of that container and its overflow clipping.
  if (typeof menu.showPopover === "function") menu.setAttribute("popover", "manual");

  const close = (): void => {
    if (typeof menu.hidePopover === "function" && menu.matches(":popover-open")) menu.hidePopover();
    menu.hidden = true;
    anchor.setAttribute("aria-expanded", "false");
    view?.removeEventListener("resize", reposition);
    view?.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("scroll", onScroll, true);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      anchor.focus();
      return;
    }
    const path = event.composedPath();
    if (!path.includes(menu) && !path.includes(anchor)) return;
    const items = [
      ...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'),
    ];
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === path[0]);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (current + 1) % items.length;
        break;
      case "ArrowUp":
        next = current <= 0 ? items.length - 1 : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  };

  const onScroll = (event: Event): void => {
    if (!event.composedPath().includes(menu)) reposition();
  };

  const reposition = (): void => {
    if (menu.hidden || !view) return;
    const rect = anchor.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      close();
      return;
    }
    menu.style.maxHeight = `${Math.max(0, view.innerHeight - MARGIN * 2)}px`;
    const naturalHeight = menu.getBoundingClientRect().height;
    const below = Math.max(0, view.innerHeight - rect.bottom - GAP - MARGIN);
    const above = Math.max(0, rect.top - GAP - MARGIN);
    const placeBelow = naturalHeight <= below || below >= above;
    menu.style.maxHeight = `${placeBelow ? below : above}px`;
    const size = menu.getBoundingClientRect();
    const maxLeft = Math.max(MARGIN, view.innerWidth - size.width - MARGIN);
    const left = align === "right" ? rect.right - size.width : rect.left;
    const top = placeBelow ? rect.bottom + GAP : rect.top - GAP - size.height;
    const maxTop = Math.max(MARGIN, view.innerHeight - size.height - MARGIN);
    menu.style.left = `${Math.min(Math.max(MARGIN, left), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(MARGIN, top), maxTop)}px`;
  };

  return {
    close,
    reposition,
    toggle(): void {
      if (!menu.hidden) {
        close();
        return;
      }
      menu.hidden = false;
      if (typeof menu.showPopover === "function") menu.showPopover();
      anchor.setAttribute("aria-expanded", "true");
      reposition();
      if (!menu.hidden) {
        menu.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
        view?.addEventListener("resize", reposition);
        view?.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("scroll", onScroll, true);
      }
    },
  };
}
