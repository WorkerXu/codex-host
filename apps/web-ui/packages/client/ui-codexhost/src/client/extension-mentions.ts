import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  InputTriggerCandidate,
  InputTriggerPick,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";
import {
  formatHostExtensionMentionToken,
  resolveLocalizedExtensionText,
  type HostExtensionMentionToken,
} from "@codexhost/shared-contracts";
import {
  cancelHostExtensionMentionSearch,
  searchHostExtensionMentions,
} from "./host-extension-mentions-api.ts";
import { subscribeHostExtensionEvents } from "./host-extensions-events.ts";

export const HOST_EXTENSION_MENTION_SOURCE = "codexhost-extension-mention";
const SEARCH_DEBOUNCE_MS = 250;

function debounceAbortable(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Web-only `@` source backed by enabled Host extensions with mention declarations. */
export function registerExtensionMentions(ctx: Context): void {
  const t = ctx.locale.bind("codexhostImport");
  const selected = new WeakMap<InputTriggerCandidate, HostExtensionMentionToken>();
  const supported = (id: SessionId) => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    if (!row) return false;
    const hostId = row.projectionValues?.threadReference?.hostId;
    return hostId === undefined || hostId === "local";
  };
  const notify = (id: SessionId, text: string) => {
    const scope = ctx.sessions.scope(id);
    scope?.get("conversation")?.input.for(scope)?.notify("error", text);
  };

  ctx.effect(
    () =>
      ctx.inputTriggers.registerSource({
        trigger: "@",
        name: HOST_EXTENSION_MENTION_SOURCE,
        order: 35,
        launcher: "command",
        showGroupTitle: false,
        codec: {
          clipboardText: (ref) => ref,
          serialize: async (ref) => ref,
        },
        subscribeCandidates: ({ sessionId }, listener) => {
          if (!supported(sessionId)) return () => undefined;
          return subscribeHostExtensionEvents({
            document,
            onExtensionsChanged: listener,
            onReconnect: listener,
          });
        },
        candidates: async ({ sessionId }, req) => {
          if (!supported(sessionId)) return [];
          try {
            await debounceAbortable(req.signal, SEARCH_DEBOUNCE_MS);
          } catch {
            return [];
          }
          if (req.signal.aborted) return [];
          const requestId = randomUUID();
          let sent = false;
          try {
            sent = true;
            const input = { requestId, query: req.query.trim(), limit: 20 };
            let result = await searchHostExtensionMentions(input, req.signal);
            while (result.pending && !req.signal.aborted) {
              await debounceAbortable(req.signal, SEARCH_DEBOUNCE_MS);
              result = await searchHostExtensionMentions(input, req.signal);
            }
            if (req.signal.aborted) return [];
            const activeLocale = ctx.locale.getLocale().active;
            const locale = activeLocale.toLowerCase().startsWith("zh") ? "zh-CN" : activeLocale;
            const rows: InputTriggerCandidate[] = [];
            for (const group of result.groups) {
              const section = resolveLocalizedExtensionText(group.label, locale);
              if (group.error) {
                rows.push({
                  name: `error:${group.extensionId}:${group.sourceId}`,
                  label: t("mentions.failed"),
                  section,
                  description: group.error,
                  disabledReason: group.error,
                });
                continue;
              }
              for (const item of group.items) {
                const candidate: InputTriggerCandidate = {
                  name: `${group.extensionId}:${group.sourceId}:${item.itemId}`,
                  value: item.itemId,
                  label: item.label,
                  section,
                  showAlias: false,
                  ...(item.description ? { description: item.description } : {}),
                };
                selected.set(candidate, {
                  extensionId: group.extensionId,
                  sourceId: group.sourceId,
                  itemId: item.itemId,
                  label: item.label,
                });
                rows.push(candidate);
              }
            }
            return rows;
          } catch (error) {
            if (req.signal.aborted) return [];
            return [
              {
                name: "retry",
                value: "retry",
                label: t("mentions.retry"),
                section: t("mentions.title"),
                description: `${t("mentions.unavailable")} ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            ];
          } finally {
            if (sent && req.signal.aborted)
              void cancelHostExtensionMentionSearch({ requestId }).catch(() => undefined);
          }
        },
        onPick: (pick: InputTriggerPick) => {
          const id = pick.session.sessionId;
          if (!supported(id)) {
            notify(id, t("discovery.stale"));
            return "handled";
          }
          if (pick.candidate.value === "retry") return "refresh";
          const mention = selected.get(pick.candidate);
          if (!mention) {
            notify(id, t("discovery.stale"));
            return "handled";
          }
          const ref = formatHostExtensionMentionToken(mention);
          return {
            insert: {
              source: HOST_EXTENSION_MENTION_SOURCE,
              ref,
              label: mention.label,
              clipboardText: ref,
            },
          };
        },
      }),
    "ui-codexhost: extension mentions",
  );
}
