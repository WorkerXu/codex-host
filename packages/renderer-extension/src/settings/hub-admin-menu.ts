import { hubMenuFocusIndex, hubMenuPlacement } from "./hub-action-menu.js";
import { createRendererSettingsIcon } from "./icons.js";

export type HubSelect = HTMLButtonElement & {
  setOptions(values: readonly (readonly [string, string])[]): void;
};

/** A single-choice Desktop-style popover, including keyboard navigation. */
export function hubSelect(
  document: Document,
  label: string,
  initial: readonly (readonly [string, string])[],
): HubSelect {
  const trigger = document.createElement("button") as HubSelect;
  trigger.type = "button";
  trigger.className = "hub-select";
  trigger.setAttribute("aria-label", label);
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  let values = initial;
  let selected = initial[0]?.[0] ?? "";
  let closeMenu: (() => void) | null = null;
  const render = () => {
    const text = document.createElement("span");
    text.textContent = values.find(([value]) => value === selected)?.[1] ?? label;
    trigger.replaceChildren(text, createRendererSettingsIcon("chevron-down", 14));
  };
  Object.defineProperty(trigger, "value", {
    get: () => selected,
    set: (value: string) => {
      selected = value;
      render();
    },
  });
  trigger.setOptions = (next) => {
    closeMenu?.();
    values = next;
    render();
  };
  const open = (last = false) => {
    if (closeMenu || trigger.disabled) return;
    const view = document.defaultView;
    if (!view) return;
    const menu = document.createElement("div");
    menu.className = "hub-select-menu";
    menu.popover = "auto";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", label);
    const buttons = values.map(([value, text]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hub-select-option";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(selected === value));
      button.tabIndex = -1;
      const copy = document.createElement("span");
      copy.textContent = text;
      button.append(copy, createRendererSettingsIcon("check", 16));
      button.addEventListener("click", () => {
        trigger.value = value;
        closeMenu?.();
        trigger.focus();
        trigger.dispatchEvent(new Event("change", { bubbles: true }));
      });
      menu.append(button);
      return button;
    });
    const controller = new AbortController();
    const close = () => {
      controller.abort();
      if (menu.matches(":popover-open")) menu.hidePopover();
      menu.remove();
      closeMenu = null;
      trigger.setAttribute("aria-expanded", "false");
    };
    closeMenu = close;
    (trigger.closest("dialog") ?? trigger.closest(".hub-page") ?? trigger.parentElement)?.append(
      menu,
    );
    menu.showPopover();
    const rect = menu.getBoundingClientRect();
    const placement = hubMenuPlacement({
      anchor: trigger.getBoundingClientRect(),
      viewport: { width: view.innerWidth, height: view.innerHeight },
      menu: { width: rect.width, height: rect.height },
    });
    menu.style.top = `${placement.top}px`;
    menu.style.left = `${placement.left}px`;
    trigger.setAttribute("aria-expanded", "true");
    buttons[
      last
        ? buttons.length - 1
        : Math.max(
            0,
            values.findIndex(([value]) => value === selected),
          )
    ]?.focus();
    menu.addEventListener(
      "toggle",
      (event) => {
        if ((event as ToggleEvent).newState === "closed") close();
      },
      { signal: controller.signal },
    );
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
        close();
        trigger.focus();
        return;
      }
      const current = buttons.indexOf(
        (menu.getRootNode() as ShadowRoot).activeElement as HTMLButtonElement,
      );
      const next = hubMenuFocusIndex(current, event.key, buttons.length);
      if (next !== null) {
        event.preventDefault();
        buttons[next]?.focus();
      }
    });
    view.addEventListener("resize", close, { signal: controller.signal });
    document.addEventListener(
      "scroll",
      (event) => {
        if (!event.composedPath().includes(menu)) close();
      },
      { capture: true, signal: controller.signal },
    );
  };
  trigger.addEventListener("click", () => {
    if (closeMenu) closeMenu();
    else open();
  });
  trigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      open(event.key === "End" || event.key === "ArrowUp");
    }
  });
  render();
  return trigger;
}
