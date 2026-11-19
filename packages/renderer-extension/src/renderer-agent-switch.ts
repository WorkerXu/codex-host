import createElement from "lucide/dist/esm/createElement.mjs";
import ArrowRightLeft from "lucide/dist/esm/icons/arrow-right-left.mjs";
import {
  THREAD_AGENT_SWITCH_METHOD,
  threadAgentSwitchResultSchema,
} from "@codexhost/shared-contracts";

import { openRendererThread } from "./renderer-fork-control.js";
import { rendererModelSelectionNoticePlacement } from "./renderer-model-picker-positioning.js";
import { applyRendererPopoverChrome } from "./renderer-usage-control.js";

/** Long enough for a new external Thread to reach Desktop's sidebar. */
const OPEN_SWITCHED_THREAD_TIMEOUT_MS = 20_000;

/** A conversation whose next message goes to another external Harness on the same Host. */
export interface PendingAgentSwitch {
  agent: string;
  label: string;
}

const pending = new Map<string, PendingAgentSwitch>();
const listeners = new Set<() => void>();
const pendingKey = (hostId: string, threadId: string): string => `${hostId}\u0000${threadId}`;

function notifyPendingChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* One listener must not stop the others. */
    }
  }
}

/** Pending switches live only in this window; reloading Desktop drops them. */
export const pendingAgentSwitches = {
  get(hostId: string, threadId: string): PendingAgentSwitch | null {
    return pending.get(pendingKey(hostId, threadId)) ?? null;
  },
  set(hostId: string, threadId: string, value: PendingAgentSwitch): void {
    pending.set(pendingKey(hostId, threadId), value);
    notifyPendingChanged();
  },
  clear(hostId: string, threadId: string): void {
    if (pending.delete(pendingKey(hostId, threadId))) notifyPendingChanged();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Sends a pending conversation's next `turn/start` to its Host as an Agent switch. Desktop
 * gets a finished empty Turn for the source, which the Host archives, and the new Thread opens.
 */
export function createAgentSwitchTurnStarter(
  target: unknown,
  hostId: string,
  isCurrent: () => boolean,
  next: (params: unknown, send: (params: unknown) => unknown) => unknown,
): (params: unknown, send: (params: unknown) => unknown) => unknown {
  return (params, send) => {
    if (!isRecord(params) || typeof params.threadId !== "string" || !Array.isArray(params.input)) {
      return next(params, send);
    }
    const threadId = params.threadId;
    const switchTo = pendingAgentSwitches.get(hostId, threadId);
    if (!switchTo || !isRecord(target) || typeof target.sendRequest !== "function") {
      return next(params, send);
    }
    const sendRequest = target.sendRequest as (...args: unknown[]) => unknown;
    const startedAt = Math.floor(Date.now() / 1000);
    return Promise.resolve()
      .then(() => {
        if (!isCurrent()) throw new Error("连接已变化，请重新发送");
        return sendRequest.call(target, THREAD_AGENT_SWITCH_METHOD, {
          threadId,
          agent: switchTo.agent,
          input: params.input,
        });
      })
      .then((value) => {
        const result = threadAgentSwitchResultSchema.parse(value);
        pendingAgentSwitches.clear(hostId, threadId);
        try {
          void openRendererThread(result.threadId as Parameters<typeof openRendererThread>[0], {
            hostId,
            timeoutMs: OPEN_SWITCHED_THREAD_TIMEOUT_MS,
          }).catch(() => undefined);
        } catch {
          // Opening is best effort: the switch already happened and the new
          // Thread is in the sidebar either way.
        }
        return {
          turn: {
            id: `codexhost-agent-switch-${result.threadId}`,
            status: "completed",
            items: [],
            error: null,
            startedAt,
            completedAt: startedAt,
            durationMs: 0,
            itemsView: "full",
          },
        };
      });
  };
}

export interface RendererAgentSwitchNoticeAction {
  label: string;
  primary?: boolean;
  run(): void;
}

export interface RendererAgentSwitchNotice {
  show(input: {
    heading: string;
    message: string;
    error?: boolean;
    busy?: boolean;
    actions: readonly RendererAgentSwitchNoticeAction[];
  }): void;
  hide(): void;
  isOpen(): boolean;
  reposition(): void;
  dispose(): void;
}

let nextNoticeId = 0;

function styleButton(button: HTMLButtonElement, primary: boolean): void {
  button.type = "button";
  button.style.cssText = [
    "flex:none",
    "height:var(--control-size-xs, 26px)",
    "padding:0 var(--control-gutter-xs, 10px)",
    "border:0",
    "border-radius:var(--control-radius-sm, 7px)",
    "font:inherit",
    "font-weight:500",
    "cursor:pointer",
    primary
      ? "background:var(--color-background-primary-solid, CanvasText);color:var(--color-text-primary-solid, Canvas)"
      : "background:color-mix(in srgb, CanvasText 8%, transparent);color:inherit",
  ].join(";");
  const rest = button.style.background;
  button.addEventListener("pointerenter", () => {
    if (button.disabled) return;
    button.style.background = primary
      ? "var(--color-background-primary-solid-hover, CanvasText)"
      : "color-mix(in srgb, CanvasText 14%, transparent)";
  });
  button.addEventListener("pointerleave", () => {
    button.style.background = rest;
  });
}

/**
 * The confirmation and pending state of an Agent switch, portaled above the
 * Agent picker like the Host's model notices. It stays until it is resolved.
 */
export function mountRendererAgentSwitchNotice(anchor: HTMLElement): RendererAgentSwitchNotice {
  const document = anchor.ownerDocument;
  const view = document.defaultView ?? window;
  const notice = document.createElement("div");
  notice.id = `codexhost-agent-switch-notice-${++nextNoticeId}`;
  notice.dataset.codexhostAgentSwitchNotice = "true";
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.setAttribute("popover", "manual");
  notice.hidden = true;
  notice.style.cssText =
    "position:fixed;box-sizing:border-box;margin:0;inset:auto;padding:12px 14px;overflow:auto;font:13px/1.45 system-ui,sans-serif;letter-spacing:0;text-align:left;white-space:normal;overflow-wrap:anywhere;z-index:2147483647";
  applyRendererPopoverChrome(notice);

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.alignItems = "flex-start";
  row.style.gap = "10px";
  const mark = document.createElement("span");
  mark.style.display = "inline-flex";
  mark.style.flex = "none";
  mark.style.marginTop = "1px";
  mark.style.color = "color-mix(in srgb, currentColor 72%, transparent)";
  mark.append(
    createElement(ArrowRightLeft, {
      width: 16,
      height: 16,
      "aria-hidden": "true",
      focusable: "false",
      "stroke-width": 1.8,
    }),
  );
  const copy = document.createElement("div");
  copy.style.minWidth = "0";
  copy.style.flex = "1";
  const heading = document.createElement("div");
  heading.style.fontWeight = "600";
  const message = document.createElement("div");
  message.style.marginTop = "2px";
  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "8px";
  actions.style.marginTop = "10px";
  copy.append(heading, message, actions);
  row.append(mark, copy);
  notice.append(row);
  document.body.append(notice);

  const isOpen = (): boolean => notice.matches(":popover-open");
  const hide = (): void => {
    if (isOpen()) notice.hidePopover();
    notice.hidden = true;
  };
  const anchorRendered = (): boolean => anchor.isConnected && anchor.getClientRects().length > 0;
  const reposition = (): void => {
    if (!isOpen()) return;
    if (!anchorRendered()) {
      hide();
      return;
    }
    const placement = rendererModelSelectionNoticePlacement(
      anchor.getBoundingClientRect(),
      { width: view.innerWidth, height: view.innerHeight },
      360,
    );
    notice.style.right = `${placement.right}px`;
    notice.style.bottom = `${placement.bottom}px`;
    notice.style.maxWidth = `${placement.maxWidth}px`;
    notice.style.maxHeight = `${placement.maxHeight}px`;
  };
  const listenersController = new AbortController();
  const options = { signal: listenersController.signal };
  view.addEventListener("resize", reposition, options);
  view.addEventListener("scroll", reposition, { ...options, capture: true });

  return {
    show(input) {
      if (!anchorRendered()) {
        hide();
        return;
      }
      heading.textContent = input.heading;
      message.textContent = input.message;
      message.style.color = input.error
        ? "var(--color-text-danger, #c2413b)"
        : "color-mix(in srgb, currentColor 68%, transparent)";
      notice.setAttribute("aria-busy", String(input.busy === true));
      actions.replaceChildren(
        ...input.actions.map((action) => {
          const button = document.createElement("button");
          styleButton(button, action.primary === true);
          button.textContent = action.label;
          button.disabled = input.busy === true;
          if (button.disabled) {
            button.style.opacity = "0.5";
            button.style.cursor = "default";
          }
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            if (!button.disabled) action.run();
          });
          return button;
        }),
      );
      notice.hidden = false;
      if (!isOpen()) notice.showPopover();
      reposition();
    },
    hide,
    isOpen,
    reposition,
    dispose(): void {
      hide();
      listenersController.abort();
      notice.remove();
    },
  };
}
