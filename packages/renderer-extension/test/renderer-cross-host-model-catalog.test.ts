import { describe, expect, it } from "vitest";

import {
  crossHostMachineLabel,
  loadCrossHostModelCatalog,
} from "../src/renderer-cross-host-model-catalog.js";

const connections = [
  {
    hostId: "remote-ssh-discovered:colab",
    displayName: "colab",
    source: "discovered",
  },
  {
    hostId: "remote-ssh-codex-managed:tencent-id",
    displayName: "tencent",
    source: "codex-managed",
  },
];

describe("cross-host model catalog", () => {
  it("labels machines from the remote connection catalog", () => {
    expect(crossHostMachineLabel("remote-ssh-discovered:colab", connections)).toBe("colab");
    expect(crossHostMachineLabel("remote-ssh-discovered:unknown", connections)).toBe("unknown");
  });

  it("groups each ready machine by provider and marks offline machines", async () => {
    const catalog = await loadCrossHostModelCatalog({
      hostIds: ["remote-ssh-discovered:colab", "remote-ssh-codex-managed:tencent-id"],
      connections,
      isOnline: (hostId) => hostId.includes("colab"),
      request: async (hostId, method) => {
        if (method === "model/list") {
          return {
            data: [
              {
                id: "gpt-6",
                displayName: "GPT 6",
                defaultReasoningEffort: "high",
                isDefault: true,
              },
            ],
          };
        }
        return {
          config: {
            model_provider: "eshetang",
            model_providers: { eshetang: { name: "OpenAI" } },
          },
        };
      },
    });

    expect(catalog.machines.map((machine) => [machine.label, machine.state])).toEqual([
      ["colab", "ready"],
      ["tencent", "offline"],
    ]);
    expect(catalog.machines[0]?.providers).toEqual([
      {
        providerId: "eshetang",
        providerLabel: "OpenAI",
        models: [{ id: "gpt-6", label: "GPT 6", defaultReasoningEffort: "high", isDefault: true }],
      },
    ]);
  });

  it("reports a failing host as error without hiding the others", async () => {
    const catalog = await loadCrossHostModelCatalog({
      hostIds: ["remote-ssh-discovered:colab"],
      connections,
      isOnline: () => true,
      request: async () => {
        throw new Error("unavailable");
      },
    });
    expect(catalog.machines[0]?.state).toBe("error");
  });
});
