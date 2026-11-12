import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";

export interface CrossHostHarness {
  id: string;
  label: string;
  plugin?: HarnessPluginDescriptor;
}

export interface CrossHostMachine {
  hostId: string;
  label: string;
  state: "ready" | "offline" | "error";
  harnesses: CrossHostHarness[];
}

export interface CrossHostHarnessCatalog {
  machines: CrossHostMachine[];
  /** Machines whose Harness directory loaded successfully. */
  loadedPeers: number;
}

export interface CrossHostMachineEntry {
  hostId: string;
  label: string;
}

/** Snapshot from the renderer binding probe, which owns per-Host availability. */
export interface CrossHostHarnessDirectory {
  plugins: readonly HarnessPluginDescriptor[] | null;
  availability: Readonly<Record<string, string | undefined>>;
  error: string | null;
}

export interface CrossHostHarnessCatalogInput {
  connections: readonly { hostId: string; displayName: string }[];
  knownHostIds: readonly string[];
  remoteProjectHostIds?: readonly string[];
  isOnline(hostId: string): boolean;
  directory(hostId: string): CrossHostHarnessDirectory;
  refresh(hostId: string): Promise<void>;
}

export const CODEX_HARNESS: CrossHostHarness = { id: "codex", label: "Codex" };

/** `remote-ssh-discovered:colab` → `colab`; managed Hosts rely on displayName. */
export function fallbackHostLabel(hostId: string): string {
  const separator = hostId.lastIndexOf(":");
  return separator >= 0 ? hostId.slice(separator + 1) : hostId;
}

/** Desktop display names first, then discovered Hosts without a connection entry. */
export function crossHostMachineEntries(
  input: Pick<
    CrossHostHarnessCatalogInput,
    "connections" | "knownHostIds" | "remoteProjectHostIds"
  >,
): CrossHostMachineEntry[] {
  const entries: CrossHostMachineEntry[] = [];
  const seen = new Set<string>();
  const push = (hostId: string, label: string): void => {
    if (hostId === "local" || hostId === "durable" || seen.has(hostId)) return;
    seen.add(hostId);
    entries.push({ hostId, label: label.trim() || fallbackHostLabel(hostId) });
  };
  for (const connection of input.connections)
    push(connection.hostId, connection.displayName || fallbackHostLabel(connection.hostId));
  for (const hostId of input.knownHostIds) push(hostId, fallbackHostLabel(hostId));
  for (const hostId of input.remoteProjectHostIds ?? []) push(hostId, fallbackHostLabel(hostId));
  return entries;
}

/**
 * Availability is authoritative: the plugin directory also lists Harnesses that
 * are not installed on this Host. Only `ready` plugins can host a Thread. Codex
 * is the native default and is never a plugin, so it is always present.
 */
export function readyHarnessPlugins(
  plugins: readonly HarnessPluginDescriptor[] | null,
  availability: Readonly<Record<string, string | undefined>>,
): CrossHostHarness[] {
  const harnesses: CrossHostHarness[] = [CODEX_HARNESS];
  if (!plugins) return harnesses;
  const seen = new Set<string>([CODEX_HARNESS.id]);
  for (const plugin of plugins) {
    if (plugin.kind === "usage" || seen.has(plugin.id)) continue;
    if (availability[plugin.id] !== "ready") continue;
    seen.add(plugin.id);
    harnesses.push({
      id: plugin.id,
      label: plugin.name.trim() || plugin.id,
      plugin,
    });
  }
  return harnesses;
}

export async function loadCrossHostHarnessCatalog(
  input: CrossHostHarnessCatalogInput,
): Promise<CrossHostHarnessCatalog> {
  const machines = await Promise.all(
    crossHostMachineEntries(input).map(async (entry): Promise<CrossHostMachine> => {
      if (!input.isOnline(entry.hostId)) return { ...entry, state: "offline", harnesses: [] };
      try {
        await input.refresh(entry.hostId);
        const directory = input.directory(entry.hostId);
        if (directory.error || !directory.plugins)
          return { ...entry, state: "error", harnesses: [CODEX_HARNESS] };
        return {
          ...entry,
          state: "ready",
          harnesses: readyHarnessPlugins(directory.plugins, directory.availability),
        };
      } catch {
        // The Host is reachable but could not inspect its Harnesses. Codex is
        // still the native default, so keep the machine usable.
        return { ...entry, state: "error", harnesses: [CODEX_HARNESS] };
      }
    }),
  );
  return { machines, loadedPeers: machines.filter(({ state }) => state === "ready").length };
}
