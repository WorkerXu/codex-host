import { readCachedHarnessVersion, writeCachedHarnessVersion } from "./connection-version-cache.js";
import type { ExternalRendererAgent } from "../agent-selection-state.js";
import type { RendererConnectionDiagnostics } from "./connections-page.js";
import {
  createHarnessVersionPanel,
  createHarnessVersionSession,
  type HarnessVersionPanel,
  type HarnessVersionSession,
} from "./harness-version-panel.js";
import type { RendererSettingsMessages } from "./localization.js";

const sessionStores = new WeakMap<
  RendererConnectionDiagnostics,
  Map<string, HarnessVersionSession>
>();

function getSessionStore(
  diagnostics: RendererConnectionDiagnostics,
): Map<string, HarnessVersionSession> {
  let store = sessionStores.get(diagnostics);
  if (!store) {
    store = new Map();
    sessionStores.set(diagnostics, store);
  }
  return store;
}

/**
 * Connection-owned version sessions outlive individual page mounts so an
 * in-flight update keeps reporting its progress when Settings is reopened.
 */
export function createConnectionVersions(
  document: Document,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
  diagnostics: RendererConnectionDiagnostics | null,
  onChange: () => void,
): {
  get(hostId: string, agent: ExternalRendererAgent): HarnessVersionPanel | undefined;
  isUpdating(hostId: string, agent: ExternalRendererAgent): boolean;
} {
  const panels = new Map<string, HarnessVersionPanel>();
  const installation = diagnostics?.installation?.bind(diagnostics);
  const sessions = diagnostics ? getSessionStore(diagnostics) : null;
  const sessionKey = (hostId: string, agent: ExternalRendererAgent): string =>
    JSON.stringify([hostId, agent]);

  return {
    isUpdating(hostId, agent) {
      return Boolean(sessions?.get(sessionKey(hostId, agent))?.updating);
    },
    get(hostId, agent) {
      if (!installation || signal.aborted) return undefined;
      const key = sessionKey(hostId, agent);
      let panel = panels.get(key);
      if (!panel) {
        const run = async (action: "check" | "update") => {
          const result = await installation(hostId, agent, action);
          writeCachedHarnessVersion(hostId, agent, result);
          return result;
        };
        let session = sessions?.get(key);
        if (!session) {
          const cached = readCachedHarnessVersion(hostId, agent);
          session = createHarnessVersionSession({ run }, cached ? { cached } : undefined);
          sessions?.set(key, session);
        }
        panel = createHarnessVersionPanel(
          document,
          messages,
          signal,
          agent,
          { run },
          onChange,
          session,
        );
        panels.set(key, panel);
      }
      return panel;
    },
  };
}
