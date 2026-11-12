export interface CrossHostHarness {
  id: string;
  label: string;
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

export interface CrossHostHarnessCatalogInput {
  connections: readonly { hostId: string; displayName: string }[];
  knownHostIds: readonly string[];
  remoteProjectHostIds?: readonly string[];
  isOnline(hostId: string): boolean;
  request(hostId: string, method: string, params: unknown): Promise<unknown>;
}

export const CODEX_HARNESS: CrossHostHarness = { id: "codex", label: "Codex" };

const HARNESS_PLUGIN_LIST_METHOD = "codexhost/harness/plugins/list";
const HARNESS_PLUGIN_LIST_TIMEOUT_MS = 1_500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Host Harness directory timed out")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
 * The Host directory already lists installed plugins; `usage` entries are
 * capability-only and cannot host a Thread. Codex is always available and is
 * not a plugin, so every machine starts with it.
 */
export function parseHarnessPlugins(value: unknown): CrossHostHarness[] {
  if (!isRecord(value) || !Array.isArray(value.plugins))
    throw new Error("Host did not return a Harness plugin list");
  const harnesses: CrossHostHarness[] = [CODEX_HARNESS];
  const seen = new Set<string>([CODEX_HARNESS.id]);
  for (const plugin of value.plugins) {
    if (!isRecord(plugin) || typeof plugin.id !== "string") continue;
    if (plugin.kind === "usage" || seen.has(plugin.id)) continue;
    seen.add(plugin.id);
    harnesses.push({
      id: plugin.id,
      label: typeof plugin.name === "string" && plugin.name.trim() ? plugin.name.trim() : plugin.id,
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
        const value = await withTimeout(
          input.request(entry.hostId, HARNESS_PLUGIN_LIST_METHOD, {}),
          HARNESS_PLUGIN_LIST_TIMEOUT_MS,
        );
        return { ...entry, state: "ready", harnesses: parseHarnessPlugins(value) };
      } catch {
        // The Host is reachable but could not enumerate plugins. Codex is still
        // the native default, so keep the machine usable instead of hiding it.
        return { ...entry, state: "error", harnesses: [CODEX_HARNESS] };
      }
    }),
  );
  return { machines, loadedPeers: machines.filter(({ state }) => state === "ready").length };
}
