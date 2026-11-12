import type {
  CrossHostMachine,
  CrossHostModel,
  CrossHostModelCatalog,
} from "./renderer-cross-host-model-catalog.js";

export interface CrossHostMenuSelection {
  machine: CrossHostMachine;
  providerId: string;
  providerLabel: string;
  model: CrossHostModel;
}

export interface CrossHostMenuExpansion {
  hostId?: string | null;
  providerId?: string | null;
}

export type CrossHostMenuRow =
  | {
      kind: "machine";
      hostId: string;
      label: string;
      state: CrossHostMachine["state"];
      expanded: boolean;
      providerCount: number;
    }
  | {
      kind: "provider";
      hostId: string;
      providerId: string;
      label: string;
      expanded: boolean;
      modelCount: number;
    }
  | {
      kind: "model";
      hostId: string;
      providerId: string;
      providerLabel: string;
      model: CrossHostModel;
    };

/** Flatten the catalog into the rows the injected menu renders. */
export function crossHostMenuRows(
  catalog: CrossHostModelCatalog,
  expansion: CrossHostMenuExpansion,
): CrossHostMenuRow[] {
  const rows: CrossHostMenuRow[] = [];
  for (const machine of catalog.machines) {
    const machineExpanded = expansion.hostId === machine.hostId;
    rows.push({
      kind: "machine",
      hostId: machine.hostId,
      label: machine.label,
      state: machine.state,
      expanded: machineExpanded,
      providerCount: machine.providers.length,
    });
    if (!machineExpanded || machine.state !== "ready") continue;
    for (const provider of machine.providers) {
      const providerExpanded =
        expansion.providerId === `${machine.hostId}\u0000${provider.providerId}`;
      rows.push({
        kind: "provider",
        hostId: machine.hostId,
        providerId: provider.providerId,
        label: provider.providerLabel,
        expanded: providerExpanded,
        modelCount: provider.models.length,
      });
      if (!providerExpanded) continue;
      for (const model of provider.models) {
        rows.push({
          kind: "model",
          hostId: machine.hostId,
          providerId: provider.providerId,
          providerLabel: provider.providerLabel,
          model,
        });
      }
    }
  }
  return rows;
}

export function machineStatusLabel(state: CrossHostMachine["state"]): string {
  switch (state) {
    case "ready":
      return "";
    case "offline":
      return "离线";
    case "error":
      return "不可用";
    default:
      return "";
  }
}

const MENU_CANDIDATES = [
  '[data-radix-popper-content-wrapper] [role="menu"]',
  '[data-radix-popper-content-wrapper] [role="listbox"]',
  "[data-radix-popper-content-wrapper] > div",
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
];

function visible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 20) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style?.visibility !== "hidden" && style?.display !== "none" && Number(style?.opacity ?? 1) > 0
  );
}

function containsExtensionMenu(element: HTMLElement): boolean {
  return element.hasAttribute("data-codexhost-cross-host-model-menu");
}

/**
 * The native model menu is React-owned and has no stable data attribute. Its
 * Radix popover wrapper is the most stable landmark; the nearest visible
 * menu/listbox to the trigger is the model list.
 */
export function findNativeModelMenu(document: Document, trigger: HTMLElement): HTMLElement | null {
  const triggerRect = trigger.getBoundingClientRect();
  const candidates: HTMLElement[] = [];
  const near = (element: HTMLElement): boolean => {
    const rect = element.getBoundingClientRect();
    return (
      Math.abs(rect.left - triggerRect.left) <= 900 && Math.abs(rect.top - triggerRect.top) <= 900
    );
  };
  const acceptable = (element: HTMLElement): boolean =>
    !containsExtensionMenu(element) &&
    !element.closest("[data-codexhost-cross-host-model-menu]") &&
    visible(element) &&
    near(element) &&
    element.querySelectorAll('button, [role="menuitem"], [role="option"]').length >= 2;
  for (const selector of MENU_CANDIDATES) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (acceptable(element)) candidates.push(element);
    }
  }
  if (candidates.length === 0) {
    // Custom popovers without Radix/ARIA landmarks: keep floating layers near
    // the trigger that contain interactive rows.
    for (const element of document.body.querySelectorAll<HTMLElement>("div")) {
      const style = document.defaultView?.getComputedStyle(element);
      if (style?.position !== "fixed" && style?.position !== "absolute") continue;
      if (Number(style?.zIndex ?? 0) < 20) continue;
      if (acceptable(element)) candidates.push(element);
    }
  }
  const outer = candidates.filter(
    (candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)),
  );
  return (outer.length > 0 ? outer : candidates).at(-1) ?? null;
}

/** Wait for the native menu React mounts after the trigger click. */
export function observeNativeModelMenu(input: {
  document: Document;
  trigger: HTMLElement;
  window: Window;
  onOpen(menu: HTMLElement): void;
  onClose?(): void;
  timeoutMs?: number;
}): () => void {
  const { document, trigger, window } = input;
  let menu: HTMLElement | null = null;
  let timer: number | undefined;
  let disposed = false;
  const deadline = Date.now() + (input.timeoutMs ?? 1_200);
  const stop = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    document.removeEventListener("pointerdown", onPointerDown, true);
    observer.disconnect();
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (menu && event.target instanceof Node && !menu.contains(event.target)) {
      stop();
      input.onClose?.();
    }
  };
  const check = (): void => {
    if (disposed) return;
    const found = findNativeModelMenu(document, trigger);
    if (found) {
      menu = found;
      stop();
      input.onOpen(found);
      return;
    }
    if (Date.now() >= deadline) {
      stop();
      input.onClose?.();
      return;
    }
    timer = window.setTimeout(check, 40);
  };
  const observer = new MutationObserver(() => {
    if (!menu && !disposed) check();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("pointerdown", onPointerDown, true);
  timer = window.setTimeout(check, 0);
  return stop;
}
