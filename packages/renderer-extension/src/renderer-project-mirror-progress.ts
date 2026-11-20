const PROGRESS_ATTRIBUTE = "data-codexhost-project-mirror-progress";
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
const CARD_MAX_WIDTH = 360;
const SUCCESS_MS = 1_600;
const ERROR_MS = 8_000;

export type ProjectMirrorProgressStage = "prepare" | "create" | "section" | "open";

/** Copy for the steps of one mirror run. */
export interface ProjectMirrorProgressText {
  prepare: string;
  create: string;
  section: string;
  open: string;
  done: string;
  /** Shown while Desktop's native folder-trust dialog can appear. */
  trustHint: string | null;
}

export function projectMirrorProgressText(input: {
  machineLabel: string;
  local: boolean;
}): ProjectMirrorProgressText {
  return {
    prepare: input.local ? "正在本机准备项目…" : `正在 ${input.machineLabel} 上准备项目…`,
    create: input.local ? "正在本机创建项目…" : `正在 ${input.machineLabel} 上创建项目…`,
    section: "加入分区…",
    open: "打开新对话…",
    done: "已在新对话中打开",
    // Only `createRemote` asks Desktop to trust a new remote folder; reusing an
    // existing project never shows that dialog, so the hint belongs to creation.
    trustHint: input.local ? null : "接下来 Desktop 会请你确认信任这个文件夹",
  };
}

/** Only the create step can open Desktop's folder-trust dialog. */
export function projectMirrorTrustHint(
  stage: ProjectMirrorProgressStage,
  text: ProjectMirrorProgressText,
): string | null {
  return stage === "create" ? text.trustHint : null;
}

export interface ProjectMirrorProgressAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

export interface ProjectMirrorProgressPlacement {
  left: number;
  top: number;
  above: boolean;
}

/** Keep the content-sized card inside the viewport and next to the composer. */
export function projectMirrorProgressPlacement(input: {
  anchor: ProjectMirrorProgressAnchor;
  viewport: { width: number; height: number };
  card: { width: number; height: number };
}): ProjectMirrorProgressPlacement {
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(input.anchor.left, input.viewport.width - input.card.width - VIEWPORT_MARGIN),
  );
  const aboveTop = input.anchor.top - input.card.height - ANCHOR_GAP;
  const above = aboveTop >= VIEWPORT_MARGIN;
  const top = above
    ? aboveTop
    : Math.min(
        input.viewport.height - input.card.height - VIEWPORT_MARGIN,
        input.anchor.bottom + ANCHOR_GAP,
      );
  return { left, top: Math.max(VIEWPORT_MARGIN, top), above };
}

export interface ProjectMirrorProgress {
  /** Advance the card; call before each awaited step. */
  step(stage: ProjectMirrorProgressStage): void;
  done(): void;
  fail(message: string): void;
}

export interface ProjectMirrorProgressControl extends ProjectMirrorProgress {
  element: HTMLElement;
  dispose(): void;
}

export interface ProjectMirrorProgressOptions {
  document: Document;
  anchor: Element;
  /** Resolve the Composer again if the original node was replaced. */
  resolveAnchor?(): Element | null;
  text: ProjectMirrorProgressText;
  successMs?: number;
  errorMs?: number;
}

const TEXT_COLOR = "var(--color-text, #111)";
const TERTIARY_COLOR = "var(--color-text-tertiary, #8b8b8b)";
const SUCCESS_COLOR = "var(--color-chart-green, #3fb950)";
const ERROR_COLOR = "var(--color-chart-red, #f85149)";

/**
 * Compact status card anchored to the Composer. It shows the mirror's current
 * step while Desktop is still working, so the trust dialog that `createRemote`
 * opens is expected instead of looking like a frozen window.
 */
export function createProjectMirrorProgress(
  options: ProjectMirrorProgressOptions,
): ProjectMirrorProgressControl {
  const { document } = options;
  const view = document.defaultView;

  const element = document.createElement("div");
  element.setAttribute(PROGRESS_ATTRIBUTE, "true");
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.setAttribute("aria-atomic", "true");
  Object.assign(element.style, {
    position: "fixed",
    // Desktop keeps modals in the overlay layer; stay below it and beside toasts.
    zIndex: "var(--toast-z-index, calc(var(--max-app-overlay-z-index, 2147480000) - 1))",
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
    padding: "10px 12px",
    borderRadius: "12px",
    border: "1px solid var(--color-border, rgba(127,127,127,0.28))",
    background: "var(--color-surface-elevated-secondary, var(--color-surface, #fff))",
    color: TEXT_COLOR,
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.18)",
    boxSizing: "border-box",
    pointerEvents: "none",
    width: "max-content",
    maxWidth: `min(${CARD_MAX_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`,
  });

  const leading = document.createElement("span");
  leading.setAttribute("aria-hidden", "true");
  Object.assign(leading.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    marginTop: "2px",
    flex: "none",
    boxSizing: "border-box",
    borderRadius: "999px",
    border: "2px solid currentColor",
    borderTopColor: "transparent",
    color: TERTIARY_COLOR,
    fontSize: "13px",
    fontWeight: "700",
    lineHeight: "14px",
  });
  let spin: Animation | null = null;

  const body = document.createElement("div");
  Object.assign(body.style, {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: "0",
  });
  const title = document.createElement("div");
  Object.assign(title.style, {
    font: "500 13px/18px system-ui, sans-serif",
    color: "inherit",
    whiteSpace: "normal",
    wordBreak: "break-word",
  });
  const hint = document.createElement("div");
  Object.assign(hint.style, {
    display: "none",
    font: "400 12px/17px system-ui, sans-serif",
    color: TERTIARY_COLOR,
    whiteSpace: "normal",
  });
  body.append(title, hint);
  element.append(leading, body);

  let anchor = options.anchor;
  let timer: number | null = null;
  let disposed = false;
  const clearTimer = (): void => {
    if (timer !== null) view?.clearTimeout(timer);
    timer = null;
  };
  const startSpin = (): void => {
    if (spin?.playState === "running") return;
    spin?.cancel();
    spin =
      leading.animate?.([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
        duration: 800,
        iterations: Infinity,
      }) ?? null;
  };
  const stopSpin = (): void => {
    spin?.cancel();
    spin = null;
    leading.style.transform = "";
  };

  const position = (): void => {
    if (anchor.isConnected === false) {
      const next = options.resolveAnchor?.();
      // A replaced Composer is re-resolved; without one the card keeps its place
      // instead of collapsing onto the viewport origin.
      if (!next) return;
      anchor = next;
    }
    const rect = anchor.getBoundingClientRect();
    const card = element.getBoundingClientRect();
    const placement = projectMirrorProgressPlacement({
      anchor: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
      },
      viewport: { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 },
      card: { width: card.width, height: card.height },
    });
    element.style.left = `${placement.left}px`;
    element.style.top = `${placement.top}px`;
  };
  const onViewportChange = (): void => position();

  const setSpinner = (): void => {
    leading.textContent = "";
    startSpin();
    leading.style.border = "2px solid currentColor";
    leading.style.borderTopColor = "transparent";
    leading.style.color = TERTIARY_COLOR;
    leading.style.fontSize = "13px";
    leading.style.fontWeight = "700";
  };
  const setMark = (mark: string, color: string): void => {
    stopSpin();
    leading.textContent = mark;
    leading.style.border = "0";
    leading.style.color = color;
    leading.style.fontSize = "14px";
    leading.style.fontWeight = "700";
  };
  const setHint = (value: string | null): void => {
    hint.textContent = value ?? "";
    hint.style.display = value ? "block" : "none";
  };

  const show = (stage: ProjectMirrorProgressStage): void => {
    if (disposed) return;
    clearTimer();
    setSpinner();
    title.style.color = "inherit";
    title.textContent = options.text[stage];
    // The dialog belongs to project creation; once it resolved the hint is stale.
    setHint(projectMirrorTrustHint(stage, options.text));
    position();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimer();
    stopSpin();
    view?.removeEventListener("resize", onViewportChange);
    view?.removeEventListener("scroll", onViewportChange, true);
    element.remove();
  };
  const hideLater = (delay: number): void => {
    clearTimer();
    timer =
      view?.setTimeout(() => {
        timer = null;
        dispose();
      }, delay) ?? null;
  };

  document.body.append(element);
  view?.addEventListener("resize", onViewportChange);
  view?.addEventListener("scroll", onViewportChange, true);
  // Rendered and measured before the caller can await the first step.
  show("prepare");

  return {
    element,
    step(stage) {
      show(stage);
    },
    done() {
      if (disposed) return;
      clearTimer();
      setMark("✓", SUCCESS_COLOR);
      title.style.color = "inherit";
      title.textContent = options.text.done;
      setHint(null);
      position();
      hideLater(options.successMs ?? SUCCESS_MS);
    },
    fail(message) {
      if (disposed) return;
      clearTimer();
      setMark("!", ERROR_COLOR);
      title.style.color = ERROR_COLOR;
      title.textContent = message;
      setHint(null);
      position();
      hideLater(options.errorMs ?? ERROR_MS);
    },
    dispose,
  };
}
