import type { ExternalRendererAgent } from "../agent-selection-state.js";
import { readCachedHarnessVersion, writeCachedHarnessVersion } from "./connection-version-cache.js";
import type { RendererConnectionDiagnostics } from "./connections-page.js";
import { createHarnessVersionPanel, type HarnessVersionPanel } from "./harness-version-panel.js";
import type { RendererSettingsMessages } from "./localization.js";

/** One automatic check per Host/Harness for the lifetime of the Connections page. */
export function createConnectionVersions(
  document: Document,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
  diagnostics: RendererConnectionDiagnostics | null,
  onChange: () => void,
): { get(hostId: string, agent: ExternalRendererAgent): HarnessVersionPanel | undefined } {
  const panels = new Map<string, HarnessVersionPanel>();
  const installation = diagnostics?.installation?.bind(diagnostics);
  return {
    get(hostId, agent) {
      if (!installation || signal.aborted) return undefined;
      const key = JSON.stringify([hostId, agent]);
      let panel = panels.get(key);
      if (!panel) {
        const cached = readCachedHarnessVersion(hostId, agent);
        panel = createHarnessVersionPanel(
          document,
          messages,
          signal,
          agent,
          {
            run: async (action) => {
              if (action === "check") {
                const fresh = readCachedHarnessVersion(hostId, agent);
                if (fresh?.fresh) return fresh.state;
              }
              const result = await installation(hostId, agent, action);
              writeCachedHarnessVersion(hostId, agent, result);
              return result;
            },
          },
          onChange,
          cached ? { state: cached.state, check: !cached.fresh } : undefined,
        );
        panels.set(key, panel);
      }
      return panel;
    },
  };
}
