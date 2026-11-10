import type { RendererSettingsMessages } from "./localization.js";
import { createRendererSettingsIcon } from "./icons.js";

/** Shared Host tab strip controls, used by the Connections and Accounts pages. */
export function createHostScrollButton(
  document: Document,
  direction: "left" | "right",
  messages: RendererSettingsMessages,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-connection-host-scroll";
  button.dataset.connectionHostScroll = direction;
  const label =
    direction === "left" ? messages.connectionHostsScrollLeft : messages.connectionHostsScrollRight;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(
    createRendererSettingsIcon(direction === "left" ? "chevron-left" : "chevron-right", 16),
  );
  return button;
}

export function configureHostScroller(
  document: Document,
  strip: HTMLElement,
  tabs: HTMLElement,
  left: HTMLButtonElement,
  right: HTMLButtonElement,
): () => void {
  const maxScrollLeft = (): number =>
    Math.max(0, (tabs.scrollWidth || 0) - (tabs.clientWidth || 0));
  const updateButtons = (): void => {
    const maximum = maxScrollLeft();
    strip.dataset.connectionHostOverflow = String(maximum > 1);
    left.disabled = tabs.scrollLeft <= 1;
    right.disabled = maximum <= 1 || tabs.scrollLeft >= maximum - 1;
  };
  const scroll = (direction: -1 | 1): void => {
    const distance = Math.max(180, Math.round((tabs.clientWidth || 250) * 0.72));
    if (typeof tabs.scrollBy === "function") {
      tabs.scrollBy({ left: direction * distance, behavior: "smooth" });
    } else {
      tabs.scrollLeft += direction * distance;
      updateButtons();
    }
  };
  const onLeft = (): void => scroll(-1);
  const onRight = (): void => scroll(1);
  const onWheel = (event: WheelEvent): void => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const maximum = maxScrollLeft();
    const canScroll = delta < 0 ? tabs.scrollLeft > 1 : tabs.scrollLeft < maximum - 1;
    if (!delta || maximum <= 1 || !canScroll) return;
    event.preventDefault();
    tabs.scrollLeft += delta;
  };
  left.addEventListener("click", onLeft);
  right.addEventListener("click", onRight);
  tabs.addEventListener("scroll", updateButtons, { passive: true });
  tabs.addEventListener("wheel", onWheel, { passive: false });
  const ownerWindow = document.defaultView;
  ownerWindow?.addEventListener("resize", updateButtons);
  ownerWindow?.setTimeout(updateButtons, 0);
  updateButtons();
  return () => {
    left.removeEventListener("click", onLeft);
    right.removeEventListener("click", onRight);
    tabs.removeEventListener("scroll", updateButtons);
    tabs.removeEventListener("wheel", onWheel);
    ownerWindow?.removeEventListener("resize", updateButtons);
  };
}
