import {
  findProjectList,
  findProjectsSection,
  hasNativeContextMenu,
  projectUnits,
} from "./renderer-project-groups-dom.js";

export type ProjectGroupMenuState = "unknown" | "native" | "unsupported";

const MENU_SELECTOR =
  '[role="menu"], [data-radix-menu-content], [data-radix-popper-content-wrapper]';
// Native portal creation can exceed 500 ms under load or on the first open;
// a too-tight wait caused one slow open to disable the menu for the session.
const MENU_OPEN_TIMEOUT_MS = 1_500;
const MENU_CLOSE_RECHECK_MS = 1_000;
const MAX_CONSECUTIVE_FAILURES = 3;

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

export function watchNativeMenuClose(options: {
  menu: HTMLElement;
  document: Document;
  window: Window;
  onClosed: () => void;
  recheckMs?: number;
}): () => void {
  const { menu, document, window, onClosed } = options;
  let cleaned = false;
  let observer: MutationObserver | null = null;
  let interval: number | null = null;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    observer?.disconnect();
    observer = null;
    if (interval !== null) window.clearInterval(interval);
    interval = null;
  };
  const isClosed = (): boolean => !menu.isConnected || menu.getAttribute("data-state") === "closed";
  const finish = (): void => {
    if (cleaned) return;
    cleanup();
    onClosed();
  };
  const check = (): void => {
    if (isClosed()) finish();
  };
  observer = new MutationObserver(check);
  observer.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state"],
  });
  interval = window.setInterval(check, options.recheckMs ?? MENU_CLOSE_RECHECK_MS);
  check();
  return cleanup;
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
  readonly #onFailure: ((reason: string) => void) | undefined;
  readonly #onClosed: (() => void) | undefined;
  #state: ProjectGroupMenuState = "unknown";
  #openMenu: HTMLElement | null = null;
  #restoreGhost: (() => void) | null = null;
  #closeWatcher: (() => void) | null = null;
  #consecutiveFailures = 0;
  #lastError: string | null = null;

  constructor(options: {
    document: Document;
    window: Window;
    onUnsupported?: (reason: string) => void;
    onFailure?: (reason: string) => void;
    onClosed?: () => void;
  }) {
    this.#document = options.document;
    this.#window = options.window;
    this.#onUnsupported = options.onUnsupported;
    this.#onFailure = options.onFailure;
    this.#onClosed = options.onClosed;
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

  lastError(): string | null {
    return this.#lastError;
  }

  consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  /** Allow a fresh contract probe after Desktop DOM or group configuration changes. */
  reprobe(): void {
    if (this.#openMenu) return;
    this.#state = "unknown";
    this.#consecutiveFailures = 0;
    this.#lastError = null;
  }

  async open(
    nativeRow: HTMLElement,
    anchor: HTMLElement,
    timeoutMs = MENU_OPEN_TIMEOUT_MS,
  ): Promise<boolean> {
    if (this.#state === "unsupported" || this.#openMenu) return false;
    if (!hasNativeContextMenu(nativeRow)) {
      this.#markUnsupported("native-context-menu-missing");
      return false;
    }
    const rect = anchor.getBoundingClientRect();
    const existing = new Set(this.#menus());
    const first = await this.#tryOpen(nativeRow, rect, existing, null, timeoutMs);
    if (first) return true;

    const ghost = this.#positionGhost(nativeRow, rect);
    if (ghost) {
      const second = await this.#tryOpen(nativeRow, rect, new Set(this.#menus()), ghost, timeoutMs);
      if (second) return true;
      ghost();
    }

    this.#recordFailure("native-context-menu-position-unreliable");
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
    timeoutMs: number,
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
    const candidate = await this.#waitForMenu(existing, rect, timeoutMs);
    if (!candidate || !candidate.nearAnchor) {
      if (candidate) this.#closeForeignMenu();
      return false;
    }
    this.#state = "native";
    this.#consecutiveFailures = 0;
    this.#lastError = null;
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

  #waitForMenu(
    existing: ReadonlySet<HTMLElement>,
    anchor: DOMRect,
    timeoutMs: number,
  ): Promise<MenuCandidate | null> {
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
      const timer = this.#window.setTimeout(() => finish(null), timeoutMs);
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
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.#closeWatcher?.();
      this.#closeWatcher = null;
      if (this.#openMenu === menu) this.#openMenu = null;
      this.#restoreGhost?.();
      this.#restoreGhost = null;
      this.#onClosed?.();
    };
    this.#closeWatcher = watchNativeMenuClose({
      menu,
      document: this.#document,
      window: this.#window,
      onClosed: finish,
    });
  }

  #closeForeignMenu(): void {
    this.#document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  }

  #recordFailure(reason: string): void {
    this.#lastError = reason;
    this.#consecutiveFailures += 1;
    this.#onFailure?.(reason);
    if (this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.#markUnsupported(reason);
    }
  }

  #markUnsupported(reason: string): void {
    this.#lastError = reason;
    if (this.#state === "unsupported") return;
    this.#state = "unsupported";
    this.#onUnsupported?.(reason);
  }
}
