import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { InputTriggerPick } from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";
import {
  formatHostExtensionMentionToken,
  hostExtensionMentionCandidateSchema,
  type HostExtensionRuntimeEntry,
  type WebExtensionMentionPickerRender,
} from "@codexhost/shared-contracts";
import { HOST_EXTENSION_MENTION_SOURCE } from "../extension-mentions.ts";
import { resolveContributionTitle } from "./contributions.ts";
import type { WebNativeExtensionRpcClient } from "./rpc.ts";
import theme from "./surface.module.css";
import css from "./mention-picker.module.css";

/** One declared picker owns one menu source and at most one mounted panel. */
export function registerMentionPicker(
  ctx: Context,
  doc: Document,
  entry: HostExtensionRuntimeEntry,
  sourceId: string,
  render: WebExtensionMentionPickerRender,
  extensionSignal: AbortSignal,
  rpc: WebNativeExtensionRpcClient,
): () => void {
  const source = entry.manifest.mentions?.sources.find(
    (source) => source.id === sourceId && source.picker,
  );
  if (!source || typeof render !== "function")
    throw new Error(`Undeclared mention picker: ${sourceId}`);
  let closeActive: (() => void) | undefined;
  const queries = new WeakMap<object, string>();
  const supported = (id: SessionId) => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    const hostId = row?.projectionValues?.threadReference?.hostId;
    return row !== undefined && (hostId === undefined || hostId === "local");
  };
  const open = (pick: InputTriggerPick, initialQuery: string) => {
    closeActive?.();
    if (extensionSignal.aborted || !supported(pick.session.sessionId)) return;
    const scope = ctx.sessions.scope(pick.session.sessionId);
    const input = scope?.get("conversation")?.input.for(scope);
    const anchor = [...doc.querySelectorAll<HTMLElement>("[data-composer-card]")].find(
      (el) => el.getBoundingClientRect().width > 0,
    );
    if (!scope || !input || !anchor || input.state.getSnapshot().draftRev !== pick.span.draftRev)
      return;
    const controller = new AbortController();
    const { signal } = controller;
    const requestId = randomUUID();
    const container = doc.createElement("div");
    container.className = `${theme.theme} ${css.panel}`;
    container.dataset.cxMentionPicker = `${entry.id}:${sourceId}`;
    container.setAttribute("role", "dialog");
    container.setAttribute("aria-label", resolveContributionTitle(ctx, source.label));
    container.tabIndex = -1;
    let dispose: (() => void | Promise<void>) | undefined;
    const cleanups: (() => void)[] = [];
    const runDispose = (fn: typeof dispose) => {
      if (fn)
        void Promise.resolve()
          .then(fn)
          .catch((error: unknown) => console.error("[mention-picker] cleanup failed", error));
    };
    const close = () => {
      if (signal.aborted) return;
      controller.abort();
      cleanups.forEach((cleanup) => cleanup());
      container.remove();
      runDispose(dispose);
      closeActive = undefined;
      // Cancellation must survive extension deactivation and the panel's own abort.
      void rpc
        .backendInvoke(entry.id, entry.activationId, "mentions/cancel", { requestId })
        .catch(() => undefined);
      if (
        anchor.isConnected &&
        ctx.uiSession.adapter.current.getSnapshot().key === pick.session.sessionId
      )
        input.focus();
    };
    closeActive = close;
    const position = () => {
      if (!anchor.isConnected) {
        close();
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const viewport = doc.defaultView!;
      const width = Math.min(640, rect.width, viewport.innerWidth - 16);
      container.style.left = `${Math.max(8, Math.min(rect.left, viewport.innerWidth - width - 8))}px`;
      container.style.width = `${width}px`;
      container.style.bottom = `${Math.max(8, viewport.innerHeight - rect.top + 8)}px`;
      container.style.maxHeight = `${Math.max(0, rect.top - 16)}px`;
    };
    doc.body.append(container);
    position();
    container.focus();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onOutside = (event: PointerEvent) => {
      if (!container.contains(event.target as Node)) close();
    };
    doc.addEventListener("keydown", onEscape, { signal });
    doc.addEventListener("pointerdown", onOutside, { signal });
    doc.addEventListener("scroll", position, { capture: true, signal });
    doc.defaultView?.addEventListener("resize", position, { signal });
    const observer = new ResizeObserver(position);
    observer.observe(anchor);
    cleanups.push(() => observer.disconnect());
    cleanups.push(
      input.state.subscribe(() => {
        if (input.state.getSnapshot().draftRev !== pick.span.draftRev) close();
      }),
    );
    const session = ctx.uiSession.adapter.current.getSnapshot();
    cleanups.push(
      ctx.uiSession.adapter.current.subscribe(() => {
        if (ctx.uiSession.adapter.current.getSnapshot() !== session) close();
      }),
    );
    cleanups.push(
      ctx.layout.panelInfo.subscribe(() => {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null) close();
      }),
    );
    try {
      const mounted = render(container, {
        sourceId,
        requestId,
        initialQuery,
        signal,
        close,
        insert(items) {
          if (
            signal.aborted ||
            !supported(pick.session.sessionId) ||
            items.length === 0 ||
            items.length > 50
          )
            return false;
          const validated = items.map((item) => hostExtensionMentionCandidateSchema.parse(item));
          const ref = validated
            .map((item) =>
              formatHostExtensionMentionToken({
                extensionId: entry.id,
                sourceId,
                itemId: item.itemId,
                label: item.label,
              }),
            )
            .join(" ");
          // A batch is one editor transaction and one chip; every carrier expands separately.
          const inserted = input.insertReference(
            {
              source: HOST_EXTENSION_MENTION_SOURCE,
              ref,
              label: validated.map((item) => item.label).join("、"),
              clipboardText: ref,
            },
            pick.span,
          );
          if (inserted) close();
          return inserted;
        },
      });
      void Promise.resolve(mounted)
        .then((cleanup) => {
          if (typeof cleanup !== "function") return;
          if (signal.aborted) runDispose(cleanup);
          else dispose = cleanup;
        })
        .catch((error: unknown) => {
          if (!signal.aborted) {
            input.notify("error", "提及面板加载失败，请重试。");
            console.error("[mention-picker] render failed", error);
            close();
          }
        });
      queueMicrotask(() => {
        if (!signal.aborted) {
          const target =
            container.querySelector<HTMLElement>("input, textarea, [autofocus]") ??
            container.querySelector<HTMLElement>("button, [tabindex='0']");
          target?.focus();
        }
      });
    } catch (error) {
      input.notify("error", "提及面板加载失败，请重试。");
      console.error("[mention-picker] render failed", error);
      close();
    }
  };
  const unregister = ctx.inputTriggers.registerSource({
    trigger: "@",
    name: `${HOST_EXTENSION_MENTION_SOURCE}:picker:${entry.id}:${sourceId}`,
    order: 34,
    launcher: "command",
    showGroupTitle: false,
    candidates: async ({ sessionId }, req) => {
      if (!supported(sessionId)) return [];
      const label = resolveContributionTitle(ctx, source.label);
      const candidate = {
        name: `${entry.id}:${sourceId}`,
        label,
        showAlias: false,
        description: req.query.trim() || undefined,
      };
      queries.set(candidate, req.query.trim());
      return [candidate];
    },
    onPick: (pick) => {
      const initialQuery = queries.get(pick.candidate) ?? "";
      queueMicrotask(() => open(pick, initialQuery));
      return "handled";
    },
  });
  const dispose = () => {
    unregister();
    closeActive?.();
    extensionSignal.removeEventListener("abort", dispose);
  };
  extensionSignal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
