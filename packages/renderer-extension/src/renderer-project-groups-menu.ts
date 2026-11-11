import {
  findProjectList,
  findProjectsSection,
  hasNativeContextMenu,
  projectUnits,
} from "./renderer-project-groups-dom.js";

export type ProjectGroupMenuState = "unknown" | "native" | "unsupported";

const MENU_SELECTOR =
  '[role="menu"], [data-radix-menu-content], [data-radix-popper-content-wrapper]';
const MENU_TIMEOUT_MS = 500;
const MENU_CLOSE_TIMEOUT_MS = 15_000;

interface MenuCandidate {
  element: HTMLElement;
  nearAnchor: boolean;
}

function visibleRect(element: Element): DOMRect | null {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function isNear(rect: DOMRect, anchor: DOMRect): boolean {
  return (
    rect.right >= anchor.left - 420 &&
    rect.left <= anchor.right + 420 &&
    rect.bottom >= anchor.top - 520 &&
    rect.top <= anchor.bottom + 520
  );
}

function projectUnitForRow(row: HTMLElement): HTMLElement | null {
  const section = findProjectsSection(row.ownerDocument);
  if (!section) return null;
  const list = findProjectList(section);
  if (!list) return null;
  return projectUnits(list).find((unit) => unit.contains(row)) ?? null;
}

function restoreStyle(element: HTMLElement, value: string): void {
  element.style.cssText = value;
}

/**
 * Opens the native Thread context menu next to a companion row. The native row
 * normally sits inside a `display:none` project unit; while the menu is open we
 * give that row an invisible, correctly-sized fixed position, then restore the
 * exact inline styles. No React node is moved or permanently changed.
 */
export class ProjectGroupMenuProxy {
  readonly #document: Document;
  readonly #window: Window;
  readonly #onUnsupported: ((reason: string) => void) | undefined;
  #state: ProjectGroupMenuState = "unknown";
  #openMenu: HTMLElement | null = null;
  #restoreGhost: (() => void) | null = null;
  #closeWatcher: (() => void) | null = null;

  constructor(options: {
    document: Document;
    window: Window;
    onUnsupported?: (reason: string) => void;
  }) {
    this.#document = options.document;
    this.#window = options.window;
    this.#onUnsupported = options.onUnsupported;
  }

  state(): ProjectGroupMenuState {
    return this.#state;
  }

  isOpen(): boolean {
    return this.#openMenu !== null;
  }

  isAvailable(): boolean {
    return this.#state !== "unsupported";
  }

  async open(nativeRow: HTMLElement, anchor: HTMLElement): Promise<boolean> {
    if (this.#state === "unsupported" || this.#openMenu) return false;
    if (!hasNativeContextMenu(nativeRow)) {
      this.#markUnsupported("native-context-menu-missing");
      return false;
    }
    const rect = anchor.getBoundingClientRect();
    const existing = new Set(this.#menus());
    const first = await this.#tryOpen(nativeRow, rect, existing, null);
    if (first) return true;

    const ghost = this.#positionGhost(nativeRow, rect);
    if (ghost) {
      const second = await this.#tryOpen(nativeRow, rect, new Set(this.#menus()), ghost);
      if (second) return true;
      ghost();
    }

    this.#markUnsupported("native-context-menu-position-unreliable");
    this.#closeForeignMenu();
    return false;
  }

  dispose(): void {
    this.#closeWatcher?.();
    this.#closeWatcher = null;
    this.#restoreGhost?.();
    this.#restoreGhost = null;
    this.#openMenu = null;
  }

  async #tryOpen(
    nativeRow: HTMLElement,
    rect: DOMRect,
    existing: ReadonlySet<HTMLElement>,
    ghost: (() => void) | null,
  ): Promise<boolean> {
    nativeRow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: this.#window,
        button: 2,
        buttons: 2,
        clientX: rect.right - 4,
        clientY: rect.top + rect.height / 2,
      }),
    );
    const candidate = await this.#waitForMenu(existing, rect);
    if (!candidate || !candidate.nearAnchor) {
      if (candidate) this.#closeForeignMenu();
      return false;
    }
    this.#state = "native";
    this.#openMenu = candidate.element;
    this.#restoreGhost = ghost;
    this.#watchClose(candidate.element);
    return true;
  }

  #menus(): HTMLElement[] {
    return [...this.#document.querySelectorAll<HTMLElement>(MENU_SELECTOR)].filter(
      (element) => !element.closest("[data-codexhost-project-groups-root]"),
    );
  }

  #waitForMenu(existing: ReadonlySet<HTMLElement>, anchor: DOMRect): Promise<MenuCandidate | null> {
    const found = this.#menus().filter(
      (element) => !existing.has(element) && visibleRect(element) !== null,
    );
    const pick = (): MenuCandidate | null => {
      for (const element of found) {
        const rect = visibleRect(element);
        if (rect) return { element, nearAnchor: isNear(rect, anchor) };
      }
      return null;
    };
    const immediate = pick();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        for (const element of this.#menus()) {
          if (existing.has(element)) continue;
          const rect = visibleRect(element);
          if (!rect) continue;
          finish({ element, nearAnchor: isNear(rect, anchor) });
          return;
        }
      });
      const timer = this.#window.setTimeout(() => finish(null), MENU_TIMEOUT_MS);
      const finish = (value: MenuCandidate | null): void => {
        this.#window.clearTimeout(timer);
        observer.disconnect();
        resolve(value);
      };
      observer.observe(this.#document.body ?? this.#document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-state", "style", "class"],
      });
    });
  }

  #positionGhost(nativeRow: HTMLElement, anchor: DOMRect): (() => void) | null {
    const unit = projectUnitForRow(nativeRow);
    if (!unit) return null;
    const unitStyle = unit.style.cssText;
    const rowStyle = nativeRow.style.cssText;
    unit.style.setProperty("display", "block", "important");
    unit.style.setProperty("position", "fixed", "important");
    unit.style.setProperty("top", "0", "important");
    unit.style.setProperty("left", "0", "important");
    unit.style.setProperty("width", "1px", "important");
    unit.style.setProperty("height", "1px", "important");
    unit.style.setProperty("overflow", "visible", "important");
    unit.style.setProperty("opacity", "0", "important");
    unit.style.setProperty("pointer-events", "none", "important");
    unit.style.setProperty("z-index", "-1", "important");
    nativeRow.style.setProperty("display", "flex", "important");
    nativeRow.style.setProperty("position", "fixed", "important");
    nativeRow.style.setProperty("top", `${anchor.top}px`, "important");
    nativeRow.style.setProperty("left", `${anchor.left}px`, "important");
    nativeRow.style.setProperty("width", `${anchor.width}px`, "important");
    nativeRow.style.setProperty("height", `${anchor.height}px`, "important");
    nativeRow.style.setProperty("margin", "0", "important");
    nativeRow.style.setProperty("opacity", "0", "important");
    nativeRow.style.setProperty("pointer-events", "none", "important");
    nativeRow.style.setProperty("z-index", "-1", "important");
    const actual = nativeRow.getBoundingClientRect();
    if (Math.abs(actual.top - anchor.top) > 2 || Math.abs(actual.left - anchor.left) > 2) {
      restoreStyle(unit, unitStyle);
      restoreStyle(nativeRow, rowStyle);
      return null;
    }
    return () => {
      restoreStyle(unit, unitStyle);
      restoreStyle(nativeRow, rowStyle);
    };
  }

  #watchClose(menu: HTMLElement): void {
    this.#closeWatcher?.();
    const finish = (): void => {
      this.#closeWatcher?.();
      this.#closeWatcher = null;
      if (this.#openMenu === menu) this.#openMenu = null;
      this.#restoreGhost?.();
      this.#restoreGhost = null;
    };
    const observer = new MutationObserver(() => {
      if (!menu.isConnected || menu.getAttribute("data-state") === "closed") finish();
    });
    observer.observe(this.#document.body ?? this.#document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    const timer = this.#window.setTimeout(finish, MENU_CLOSE_TIMEOUT_MS);
    this.#closeWatcher = () => {
      observer.disconnect();
      this.#window.clearTimeout(timer);
    };
  }

  #closeForeignMenu(): void {
    this.#document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  }

  #markUnsupported(reason: string): void {
    if (this.#state === "unsupported") return;
    this.#state = "unsupported";
    this.#onUnsupported?.(reason);
  }
}
