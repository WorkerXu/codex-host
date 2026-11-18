import { isCodexServiceRegistry, loadCodexNativeServices } from "./codex-native-services.js";

/** Native SSH service signatures consumed by the SSH Adapter. */
export interface CodexSshServices {
  sshConnections: {
    refresh(): Promise<unknown>;
    save(params: unknown): Promise<unknown>;
  };
  remoteConnections: {
    setAutoConnect(params: unknown): Promise<unknown>;
    getState(hostId: string): Promise<unknown>;
  };
}

function isSshServices(value: unknown): value is CodexSshServices {
  if (
    !isCodexServiceRegistry(value) ||
    !Object.hasOwn(value, "sshConnections") ||
    !Object.hasOwn(value, "remoteConnections")
  )
    return false;
  const ssh = value.sshConnections;
  const remote = value.remoteConnections;
  // Native RPC stubs are callable proxies, so the individual services need not be plain objects.
  return (
    ssh != null &&
    remote != null &&
    typeof (ssh as CodexSshServices["sshConnections"]).refresh === "function" &&
    typeof (ssh as CodexSshServices["sshConnections"]).save === "function" &&
    typeof (remote as CodexSshServices["remoteConnections"]).getState === "function" &&
    typeof (remote as CodexSshServices["remoteConnections"]).setAutoConnect === "function"
  );
}

export async function loadCodexSshServices(
  ownerWindow: Window,
  importModule?: (url: string) => Promise<Record<string, unknown>>,
): Promise<CodexSshServices | null> {
  return loadCodexNativeServices(ownerWindow, isSshServices, importModule);
}
