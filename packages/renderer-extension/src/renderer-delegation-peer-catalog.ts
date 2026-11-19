import type {
  DelegationPeerCatalog,
  DelegationPeerCatalogEntry,
  HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";
import { localMachineLabel } from "./renderer-cross-host-harness-catalog.js";
import type {
  RendererDelegationPeerNotice,
  RendererDelegationTarget,
} from "./renderer-delegation-mention.js";

export interface RendererDelegationPeerTargets {
  targets: RendererDelegationTarget[];
  notices: RendererDelegationPeerNotice[];
}

/** A peer that is this Mac: its mention still carries the peer name. */
export function isLocalDelegationPeer(peer: DelegationPeerCatalogEntry): boolean {
  return peer.hostIds.includes("local");
}

/** Desktop folder-bar name for a peer, falling back to its `peers.json` name. */
export function delegationPeerLabel(
  peer: DelegationPeerCatalogEntry,
  locale: RendererSettingsLocale,
  desktopNameFor?: (peer: DelegationPeerCatalogEntry) => string | undefined,
): string {
  if (isLocalDelegationPeer(peer)) return localMachineLabel(locale);
  return desktopNameFor?.(peer) ?? peer.name;
}

/**
 * Turn the conversation Host's peer catalog into `#` menu rows. A peer that is
 * offline keeps its last known Harnesses as disabled rows; a peer that has no
 * known Harnesses becomes a disabled machine group instead.
 */
export function delegationPeerTargets(
  catalog: DelegationPeerCatalog | null,
  pluginFor: (
    harnessId: string,
    peer: DelegationPeerCatalogEntry,
  ) => HarnessPluginDescriptor | undefined,
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
      const plugin = pluginFor(harnessId, peer);
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
