import type {
  DelegationPeerCatalog,
  DelegationPeerCatalogEntry,
} from "@codexhost/shared-contracts";

import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";

import type {
  RendererDelegationPeerNotice,
  RendererDelegationTarget,
} from "./renderer-delegation-mention.js";

export interface RendererDelegationPeerTargets {
  targets: RendererDelegationTarget[];
  notices: RendererDelegationPeerNotice[];
}

/**
 * Turn the Host Runtime's peer catalog into `#` menu rows. A peer that is
 * offline keeps its last known Harnesses as disabled rows; a peer that has no
 * known Harnesses becomes a disabled machine group instead.
 */
export function delegationPeerTargets(
  catalog: DelegationPeerCatalog | null,
  pluginFor: (harnessId: string) => HarnessPluginDescriptor | undefined,
  labelFor: (harnessId: string, plugin?: HarnessPluginDescriptor) => string,
  displayNameForPeer?: (peer: DelegationPeerCatalogEntry) => string | undefined,
): RendererDelegationPeerTargets {
  if (!catalog) return { targets: [], notices: [] };
  const targets: RendererDelegationTarget[] = [];
  const notices: RendererDelegationPeerNotice[] = [];
  for (const peer of catalog.peers) {
    const hostLabel = displayNameForPeer?.(peer) ?? peer.name;
    if (peer.harnesses.length === 0) {
      if (peer.state !== "ready") {
        notices.push({
          name: hostLabel,
          reason: peer.error ?? "Machine is unreachable",
        });
      }
      continue;
    }
    for (const harnessId of peer.harnesses) {
      const plugin = pluginFor(harnessId);
      targets.push({
        agent: harnessId,
        label: labelFor(harnessId, plugin),
        ...(plugin ? { plugin } : {}),
        hostId: peer.name,
        hostLabel,
        ...(peer.state === "ready"
          ? {}
          : { disabledReason: peer.error ?? "Machine is unreachable" }),
      });
    }
  }
  return { targets, notices };
}
