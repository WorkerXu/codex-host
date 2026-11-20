import { readPeerConfig, resolvePeerTarget, peerThreadReference } from "./peer-config.js";
import { requestPeerRoute, type PeerSpawn } from "./peer-transport.js";
import { DelegationControlError } from "./delegation-types.js";

export async function resolveCliPeer(
  environment: NodeJS.ProcessEnv,
  host: string | undefined,
  desktopRead = false,
) {
  if (!host || host === "local") return;
  const config = await readPeerConfig(environment);
  const target = resolvePeerTarget(config, host);
  if (target === "local") return;
  if (target) return { target, selfHostId: config.self?.hostIds[0] ?? "local" };
  if (!desktopRead)
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `No peer is configured for Host '${host}'`,
    );
}

export async function requestCliPeer(input: {
  environment: NodeJS.ProcessEnv;
  peer: NonNullable<Awaited<ReturnType<typeof resolveCliPeer>>>;
  route: string;
  body: Record<string, unknown>;
  spawnImpl?: PeerSpawn | undefined;
}) {
  const { environment, peer, route, body, spawnImpl } = input;
  const result = await requestPeerRoute({
    environment,
    peer: peer.target,
    route,
    body,
    // Let a bounded long poll finish on the peer before timing out SSH.
    ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs + 15_000 } : {}),
    ...(spawnImpl ? { spawnImpl } : {}),
  });
  if (typeof result.threadId !== "string") return result;
  const hostId = peer.target.linkHostId;
  const next = result.next;
  return {
    ...result,
    hostId,
    ...(route === "/v1/delegate/start"
      ? { deepLink: peerThreadReference(result.threadId, hostId) }
      : {}),
    ...(next && typeof next === "object" && !Array.isArray(next)
      ? {
          next: Object.fromEntries(
            Object.entries(next).map(([key, value]) => [
              key,
              typeof value === "string" ? `${value} --host ${peer.target.name}` : value,
            ]),
          ),
        }
      : {}),
  };
}
