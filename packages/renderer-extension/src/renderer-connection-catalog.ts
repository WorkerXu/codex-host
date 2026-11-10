/**
 * Native SSH connection records are the source of truth for SSH Hosts. Codex can
 * keep a deleted connection's app-server route alive until restart, so observed
 * Renderer Hosts must be reconciled against the current connection catalog.
 */

const SSH_HOST_ID_PREFIX = "remote-ssh-";

export function isSshHostId(hostId: string): boolean {
  return hostId.startsWith(SSH_HOST_ID_PREFIX);
}

/** Observed SSH Hosts that no longer exist in the native connection catalog. */
export function retiredSshConnectionHosts(
  observedHostIds: Iterable<string>,
  connectionHostIds: Iterable<string>,
): string[] {
  const connections = new Set(connectionHostIds);
  return [...observedHostIds].filter((hostId) => isSshHostId(hostId) && !connections.has(hostId));
}

/** Release per-Host state for deleted SSH connections; returns whether anything was released. */
export function releaseRetiredSshConnectionHosts(
  observedHostIds: Iterable<string>,
  connectionHostIds: Iterable<string>,
  release: (hostId: string) => void,
): boolean {
  const retired = retiredSshConnectionHosts(observedHostIds, connectionHostIds);
  for (const hostId of retired) release(hostId);
  return retired.length > 0;
}
