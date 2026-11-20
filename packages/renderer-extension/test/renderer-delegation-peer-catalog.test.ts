import { describe, expect, it } from "vitest";

import type { DelegationPeerCatalog, HarnessPluginDescriptor } from "@codexhost/shared-contracts";

import {
  delegationPeerLabel,
  delegationPeerTargets,
} from "../src/renderer-delegation-peer-catalog.js";

const catalog: DelegationPeerCatalog = {
  peers: [
    {
      name: "oracle-sg",
      hostIds: ["remote-ssh-discovered:oracle"],
      state: "ready",
      harnesses: ["grok", "claude-code"],
    },
    {
      name: "colab",
      hostIds: ["remote-ssh-discovered:colab"],
      state: "unreachable",
      harnesses: ["grok"],
      error: "ssh: connect timed out",
    },
    {
      name: "newbox",
      hostIds: ["remote-ssh-discovered:newbox"],
      state: "unreachable",
      harnesses: [],
      error: "ssh: no route to host",
    },
  ],
};

/** The same shape oracle-main's Host Runtime reports for this Mac. */
const macPeerCatalog: DelegationPeerCatalog = {
  peers: [
    {
      name: "mac",
      hostIds: ["local"],
      ssh: "mac",
      state: "ready",
      harnesses: ["claude-code", "codex"],
    },
  ],
  self: { hostIds: ["remote-ssh-discovered:oracle-main"] },
};

const labels: Record<string, string> = {
  grok: "Grok",
  "claude-code": "Claude Code",
};

describe("renderer delegation peer targets", () => {
  it("groups ready peers by machine and gives each offline machine one notice", () => {
    const result = delegationPeerTargets(
      catalog,
      () => undefined,
      (harnessId) => labels[harnessId] ?? harnessId,
      (peer) => (peer.name === "oracle-sg" ? "Oracle SG" : undefined),
    );
    expect(result.targets).toEqual([
      {
        agent: "grok",
        label: "Grok",
        hostId: "oracle-sg",
        hostLabel: "Oracle SG",
      },
      {
        agent: "claude-code",
        label: "Claude Code",
        hostId: "oracle-sg",
        hostLabel: "Oracle SG",
      },
    ]);
    expect(result.notices).toEqual([
      { name: "colab", reason: "ssh: connect timed out" },
      { name: "newbox", reason: "ssh: no route to host" },
    ]);
  });

  it("labels a peer that is this Mac as 此计算机 and keeps its peer name for --host", () => {
    const result = delegationPeerTargets(
      macPeerCatalog,
      () => undefined,
      (harnessId) => labels[harnessId] ?? harnessId,
      (peer) => delegationPeerLabel(peer, "zh-CN", () => undefined),
    );
    expect(result.targets.map(({ hostId, hostLabel }) => ({ hostId, hostLabel }))).toEqual([
      { hostId: "mac", hostLabel: "此计算机" },
      { hostId: "mac", hostLabel: "此计算机" },
    ]);
  });

  it("asks for the artwork of the peer's own Host", () => {
    const peerPlugin: HarnessPluginDescriptor = {
      id: "claude-code" as HarnessPluginDescriptor["id"],
      name: "Claude Code",
      version: "2",
      icon: "data:image/svg+xml;charset=utf-8,remote",
    };
    const seen: Array<[string, string]> = [];
    const result = delegationPeerTargets(
      macPeerCatalog,
      (harnessId, peer) => {
        seen.push([harnessId, peer.hostIds[0] ?? ""]);
        return harnessId === "claude-code" ? peerPlugin : undefined;
      },
      (harnessId, plugin) => plugin?.name ?? harnessId,
    );
    expect(seen).toEqual([
      ["claude-code", "local"],
      ["codex", "local"],
    ]);
    expect(result.targets[0]).toMatchObject({ label: "Claude Code", plugin: peerPlugin });
  });

  it("omits a reachable machine with no available Harnesses", () => {
    expect(
      delegationPeerTargets(
        {
          peers: [
            {
              name: "empty",
              hostIds: [],
              state: "ready",
              harnesses: [],
            },
          ],
        },
        () => undefined,
        (id) => id,
      ),
    ).toEqual({ targets: [], notices: [] });
  });

  it("returns nothing for an unavailable catalog", () => {
    expect(
      delegationPeerTargets(
        null,
        () => undefined,
        (id) => id,
      ),
    ).toEqual({
      targets: [],
      notices: [],
    });
  });
});
