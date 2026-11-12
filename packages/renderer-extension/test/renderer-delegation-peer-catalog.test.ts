import { describe, expect, it } from "vitest";

import type { DelegationPeerCatalog } from "@codexhost/shared-contracts";

import { delegationPeerTargets } from "../src/renderer-delegation-peer-catalog.js";

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

const labels: Record<string, string> = {
  grok: "Grok",
  "claude-code": "Claude Code",
};

describe("renderer delegation peer targets", () => {
  it("groups ready peers by machine and marks offline Harnesses disabled", () => {
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
      {
        agent: "grok",
        label: "Grok",
        hostId: "colab",
        hostLabel: "colab",
        disabledReason: "ssh: connect timed out",
      },
    ]);
    expect(result.notices).toEqual([{ name: "newbox", reason: "ssh: no route to host" }]);
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
