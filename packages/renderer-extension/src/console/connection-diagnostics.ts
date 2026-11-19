import {
  harnessIdSchema,
  type CodexhostError,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";
import type { RendererAgentAvailability } from "../agent-selection-state.js";
import {
  readCachedHarnessDirectory,
  writeCachedHarnessDirectory,
} from "../renderer-harness-directory-cache.js";
import type { RendererModelClient } from "../renderer-model-client.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionSnapshot,
} from "../settings/pages.js";

const LOCAL_HOST = "local";

/** The console consumes the local Host's cached directory, never a compiled Harness list. */
export function createConsoleConnectionDiagnostics(
  client: RendererModelClient,
): RendererConnectionDiagnostics {
  const cached = readCachedHarnessDirectory(LOCAL_HOST);
  let plugins: readonly HarnessPluginDescriptor[] = cached?.plugins ?? [];
  let fingerprint = cached?.fingerprint ?? null;
  let directoryError: string | undefined;
  const availability = new Map<string, RendererAgentAvailability>(
    Object.entries(cached?.availability ?? {}),
  );
  const errors = new Map<string, CodexhostError | null>();
  const webUi = new Map<string, boolean>(Object.entries(cached?.webUi ?? {}));
  const listeners = new Set<() => void>();
  let pending: Promise<void> | null = null;
  let started = false;
  const publish = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const persist = (): void => {
    const statuses: Record<string, "ready" | "notInstalled" | "unavailable" | "error"> = {};
    for (const [id, status] of availability) {
      if (
        status === "ready" ||
        status === "notInstalled" ||
        status === "unavailable" ||
        status === "error"
      ) {
        statuses[id] = status;
      }
    }
    writeCachedHarnessDirectory(LOCAL_HOST, {
      fingerprint,
      plugins,
      availability: statuses,
      webUi: Object.fromEntries(webUi),
    });
  };

  const applyStatus = (agent: string, status: RendererAgentAvailability): void => {
    availability.set(agent, status);
  };

  const inspect = async (plugin: HarnessPluginDescriptor, refresh: boolean): Promise<void> => {
    const { id } = plugin;
    try {
      const inspection = await client.inspectHarness({ harnessId: id, refresh });
      applyStatus(id, inspection.status);
      webUi.set(id, inspection.status === "ready" && inspection.webUi?.open === true);
      const error = inspection.status === "ready" ? null : inspection.error;
      errors.set(
        id,
        error
          ? {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
              ...(error.stage ? { stage: error.stage } : {}),
              ...(error.durationMs !== undefined ? { durationMs: error.durationMs } : {}),
              ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
            }
          : null,
      );
    } catch (error) {
      applyStatus(id, "error");
      webUi.set(id, false);
      errors.set(id, {
        code: "internalError",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        stage: "request",
      });
    }
    publish();
  };

  /**
   * Only installed or unknown Harnesses are refreshed in the background. A
   * not-installed CLI stays on its cached 「未安装」 row and costs no request.
   */
  const inspectInstalled = async (refresh: boolean): Promise<void> => {
    const targets = refresh
      ? plugins
      : plugins.filter(({ id }) => availability.get(id) !== "notInstalled");
    await Promise.all(targets.map((plugin) => inspect(plugin, refresh)));
  };

  /** Full checks only fill Web UI/error details the directory does not carry. */
  const inspectMissingWebUi = async (): Promise<void> => {
    const targets = plugins.filter(({ id }) => availability.get(id) === "ready" && !webUi.has(id));
    await Promise.all(targets.map((plugin) => inspect(plugin, false)));
    persist();
  };

  const revalidate = (force: boolean): Promise<void> => {
    if (pending) {
      if (!force) return pending;
      const previous = pending;
      return previous.catch(() => undefined).then(() => revalidate(true));
    }
    pending = Promise.resolve()
      .then(async () => {
        if (!client.listHarnessPlugins) {
          directoryError = "This Host does not support Harness plugin discovery";
          publish();
          return;
        }
        let result;
        try {
          result = await client.listHarnessPlugins(
            force
              ? { refresh: true }
              : fingerprint === null
                ? { ifNoneMatch: "" }
                : { ifNoneMatch: fingerprint },
          );
        } catch (error) {
          directoryError = error instanceof Error ? error.message : String(error);
          publish();
          return;
        }
        directoryError = undefined;
        if (result.unchanged === true) return;
        plugins = (result.plugins ?? []).filter(({ kind }) => kind !== "usage");
        fingerprint = result.fingerprint ?? null;
        for (const { id } of plugins) {
          const hostStatus = result.availability?.[id];
          if (hostStatus) applyStatus(id, hostStatus);
          else if (!availability.has(id)) applyStatus(id, "checking");
        }
        for (const id of [...availability.keys()]) {
          if (!plugins.some((plugin) => plugin.id === id)) {
            availability.delete(id);
            errors.delete(id);
            webUi.delete(id);
          }
        }
        // New Hosts return availability with the directory; older Hosts still
        // need a background inspection, but never for a not-installed CLI.
        if (!result.availability) await inspectInstalled(force);
        persist();
        publish();
        if (result.availability) void inspectMissingWebUi().catch(() => undefined);
      })
      .finally(() => {
        pending = null;
        publish();
      });
    return pending;
  };

  const installation = client.installation?.bind(client);
  return {
    ...(installation
      ? {
          installation: async (
            hostId: string,
            agent: string,
            action: "check" | "update" | "install",
          ) => {
            if (hostId !== LOCAL_HOST)
              throw new Error("Web console installation only supports the local Host");
            return installation({ harnessId: harnessIdSchema.parse(agent), action });
          },
        }
      : {}),
    harnessDirectory() {
      return {
        plugins,
        availability: Object.fromEntries(availability),
        error: directoryError ?? null,
      };
    },
    snapshot(): RendererConnectionSnapshot {
      if (!started) {
        started = true;
        void revalidate(false);
      }
      return {
        adapter: { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
        hosts: [
          {
            hostId: LOCAL_HOST,
            active: true,
            ...(directoryError ? { directoryError } : {}),
            agents: plugins.map((plugin) => ({
              agent: plugin.id,
              plugin,
              availability: availability.get(plugin.id) ?? "checking",
              error: errors.get(plugin.id) ?? null,
              ...(webUi.get(plugin.id) ? { webUiAvailable: true as const } : {}),
            })),
          },
        ],
      };
    },
    refresh: () => revalidate(true),
    async openWebUi(_hostId, agent) {
      if (!client.openHarnessWebUi) throw new Error("Harness Web UI is unavailable");
      await client.openHarnessWebUi({ harnessId: harnessIdSchema.parse(agent) });
    },
    async getLaunchSettings(_hostId, agent) {
      if (!client.getHarnessLaunchSettings) throw new Error("Launch settings are unavailable");
      return client.getHarnessLaunchSettings({ harnessId: harnessIdSchema.parse(agent) });
    },
    async setLaunchSettings(_hostId, agent, path) {
      if (!client.setHarnessLaunchSettings) throw new Error("Launch settings are unavailable");
      return client.setHarnessLaunchSettings({ harnessId: harnessIdSchema.parse(agent), path });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
