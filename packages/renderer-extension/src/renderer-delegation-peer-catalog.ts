import type {
  DelegationPeerCatalog,
  DelegationPeerCatalogEntry,
  HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";
import { localMachineLabel } from "./renderer-cross-host-harness-catalog.js";
import type { RendererDelegationTarget } from "./renderer-delegation-mention.js";

export interface RendererDelegationPeerNotice {
  name: string;
  reason: string;
}

type PeerTarget = RendererDelegationTarget & {
  hostId: string;
  hostLabel: string;
};

export interface RendererDelegationPeerTargets {
  targets: PeerTarget[];
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

/** An unreachable machine contributes one notice. Only ready targets can be selected. */
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
  const targets: PeerTarget[] = [];
  const notices: RendererDelegationPeerNotice[] = [];
  for (const peer of catalog.peers) {
    const hostLabel = displayNameForPeer?.(peer) ?? peer.name;
    if (peer.state !== "ready") {
      notices.push({ name: hostLabel, reason: peer.error ?? "" });
      continue;
    }
    for (const harnessId of new Set(peer.harnesses)) {
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(harnessId)) continue;
      const plugin = pluginFor(harnessId, peer);
      targets.push({
        agent: harnessId,
        label: labelFor(harnessId, plugin),
        ...(plugin ? { plugin } : {}),
        hostId: peer.name,
        hostLabel,
      });
    }
  }
  return { targets, notices };
}
