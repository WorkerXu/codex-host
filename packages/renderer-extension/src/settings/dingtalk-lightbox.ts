import ChevronLeftIcon from "lucide/dist/esm/icons/chevron-left.mjs";
import ChevronRightIcon from "lucide/dist/esm/icons/chevron-right.mjs";
import XIcon from "lucide/dist/esm/icons/x.mjs";

import type { DingTalkMessage, DingTalkResourceResult } from "@codexhost/shared-contracts";

import { decodeDingTalkDataUrl } from "./dingtalk-message-list.js";
import { createElementNode, createIconButton } from "./dingtalk-page-view.js";
import type { DingTalkPageText } from "./dingtalk-page-strings.js";

export interface DingTalkLightboxImage {
  message: DingTalkMessage;
  resource: NonNullable<DingTalkMessage["resources"]>[number];
}

export interface DingTalkLightboxOptions {
  document: Document;
  /** The workbench root; the overlay stays inside its shadow styles. */
  host: HTMLElement;
  text: DingTalkPageText;
  loadResource(
    message: DingTalkMessage,
    resource: DingTalkLightboxImage["resource"],
  ): Promise<DingTalkResourceResult>;
  createObjectUrl?(blob: Blob): string;
  revokeObjectUrl?(url: string): void;
  decodeImage?(dataUrl: string): Promise<Blob | null>;
}

export interface DingTalkLightbox {
  open(images: readonly DingTalkLightboxImage[], index: number): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

/**
 * Full-size viewer. Bytes are read only when an image is shown, the object URL
 * is revoked when navigating or closing, and nothing is kept between opens.
 */
export function createDingTalkLightbox(options: DingTalkLightboxOptions): DingTalkLightbox {
  const { document, host, text } = options;
  const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const decodeImage = options.decodeImage ?? decodeDingTalkDataUrl;
  const overlay = createElementNode(document, "div", "dingtalk-lightbox");
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.tabIndex = -1;
  const stage = createElementNode(document, "div", "dingtalk-lightbox-stage");
  const image = document.createElement("img");
  image.className = "dingtalk-lightbox-image";
  image.hidden = true;
  image.alt = "";
  const status = createElementNode(document, "span", "dingtalk-lightbox-status");
  const counter = createElementNode(document, "span", "dingtalk-lightbox-counter");
  const closeButton = createIconButton(document, text.closeImage, XIcon);
  closeButton.classList.add("dingtalk-lightbox-close");
  const previous = createIconButton(document, text.previousImage, ChevronLeftIcon);
  previous.classList.add("dingtalk-lightbox-previous");
  const next = createIconButton(document, text.nextImage, ChevronRightIcon);
  next.classList.add("dingtalk-lightbox-next");
  stage.append(image, status, previous, next);
  overlay.append(closeButton, stage, counter);
  host.append(overlay);

  let images: readonly DingTalkLightboxImage[] = [];
  let index = 0;
  let objectUrl: string | null = null;
  let generation = 0;
  let open = false;
  let previousFocus: HTMLElement | null = null;

  const release = (): void => {
    if (!objectUrl) return;
    const url = objectUrl;
    objectUrl = null;
    try {
      revokeObjectUrl(url);
    } catch {
      /* Revocation is best effort. */
    }
  };

  const setStatus = (value: string | null): void => {
    status.hidden = value === null;
    status.textContent = value ?? "";
  };

  const load = async (): Promise<void> => {
    const current = images[index];
    if (!current) return;
    const request = ++generation;
    release();
    image.hidden = true;
    image.removeAttribute("src");
    image.style.width = "";
    image.style.height = "";
    image.alt = current.message.text || "图片";
    setStatus(text.imageLoading);
    stage.classList.add("dingtalk-lightbox-stage--loading");
    const result = await options.loadResource(current.message, current.resource).catch(() => null);
    if (!open || request !== generation) return;
    if (!result?.available || !result.dataUrl) {
      setStatus(text.imageFailed);
      stage.classList.remove("dingtalk-lightbox-stage--loading");
      return;
    }
    const blob = await decodeImage(result.dataUrl).catch(() => null);
    if (!open || request !== generation) return;
    if (!blob) {
      setStatus(text.imageFailed);
      stage.classList.remove("dingtalk-lightbox-stage--loading");
      return;
    }
    const url = createObjectUrl(blob);
    objectUrl = url;
    image.onload = () => {
      if (!open || request !== generation) return;
      // Grow small images into the window; never exceed the viewport.
      const naturalWidth = image.naturalWidth || 1;
      const naturalHeight = image.naturalHeight || 1;
      const viewportWidth = document.defaultView?.innerWidth ?? 1280;
      const viewportHeight = document.defaultView?.innerHeight ?? 800;
      const fit = Math.min(
        (viewportWidth * 0.9) / naturalWidth,
        (viewportHeight * 0.86) / naturalHeight,
      );
      const scale =
        fit < 1 ? fit : Math.max(1, Math.min(fit, (viewportWidth * 0.6) / naturalWidth, 4));
      image.style.width = `${Math.round(naturalWidth * scale)}px`;
      image.style.height = `${Math.round(naturalHeight * scale)}px`;
      setStatus(null);
      stage.classList.remove("dingtalk-lightbox-stage--loading");
      image.hidden = false;
    };
    image.onerror = () => {
      if (!open || request !== generation) return;
      setStatus(text.imageFailed);
      stage.classList.remove("dingtalk-lightbox-stage--loading");
    };
    image.src = url;
  };

  const update = (): void => {
    counter.textContent = `${index + 1} / ${images.length}`;
    previous.disabled = images.length < 2;
    next.disabled = images.length < 2;
    void load();
  };

  const navigate = (step: number): void => {
    if (images.length < 2) return;
    index = (index + step + images.length) % images.length;
    update();
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    generation += 1;
    overlay.hidden = true;
    image.hidden = true;
    image.removeAttribute("src");
    image.style.width = "";
    image.style.height = "";
    image.onload = null;
    image.onerror = null;
    images = [];
    release();
    setStatus(null);
    stage.classList.remove("dingtalk-lightbox-stage--loading");
    const focus = previousFocus;
    previousFocus = null;
    try {
      focus?.focus({ preventScroll: true });
    } catch {
      /* Focus restoration is best effort. */
    }
  };

  const onKey = (event: KeyboardEvent): void => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      navigate(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      navigate(1);
    }
  };

  const onPointerDown = (event: Event): void => {
    if (!open) return;
    if (event.target === overlay) close();
  };

  closeButton.addEventListener("click", close);
  previous.addEventListener("click", () => navigate(-1));
  next.addEventListener("click", () => navigate(1));
  image.addEventListener("click", (event) => event.stopPropagation());
  overlay.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKey, true);

  return {
    open(list, first) {
      if (list.length === 0) return;
      images = list;
      index = Math.max(0, Math.min(first, list.length - 1));
      open = true;
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      overlay.hidden = false;
      overlay.focus({ preventScroll: true });
      update();
    },
    close,
    isOpen: () => open,
    dispose() {
      close();
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
    },
  };
}
