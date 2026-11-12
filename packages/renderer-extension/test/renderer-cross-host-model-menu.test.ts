import { describe, expect, it } from "vitest";

import type { CrossHostModelCatalog } from "../src/renderer-cross-host-model-catalog.js";
import { crossHostMenuRows, machineStatusLabel } from "../src/renderer-cross-host-model-menu.js";

const catalog: CrossHostModelCatalog = {
  machines: [
    {
      hostId: "remote-ssh-discovered:colab",
      label: "colab",
      state: "ready",
      defaultProviderId: "eshetang",
      providers: [
        {
          providerId: "eshetang",
          providerLabel: "OpenAI",
          models: [
            { id: "gpt-6", label: "GPT 6", defaultReasoningEffort: "high", isDefault: true },
          ],
        },
        {
          providerId: "magpie",
          providerLabel: "Magpie",
          models: [
            { id: "magpie/gpt-5", label: "GPT 5", defaultReasoningEffort: null, isDefault: false },
          ],
        },
      ],
    },
    {
      hostId: "remote-ssh-codex-managed:tencent-id",
      label: "tencent",
      state: "offline",
      defaultProviderId: null,
      providers: [],
    },
  ],
};

describe("cross-host model menu rows", () => {
  it("lists machines only until one is expanded", () => {
    expect(crossHostMenuRows(catalog, {}).map((row) => row.kind)).toEqual(["machine", "machine"]);
    expect(
      crossHostMenuRows(catalog, { hostId: catalog.machines[0]?.hostId ?? null }),
    ).toHaveLength(4);
  });

  it("expands one provider into models", () => {
    const rows = crossHostMenuRows(catalog, {
      hostId: "remote-ssh-discovered:colab",
      providerId: "remote-ssh-discovered:colab\u0000eshetang",
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "machine",
      "provider",
      "model",
      "provider",
      "machine",
    ]);
    expect(rows.find((row) => row.kind === "model")).toMatchObject({
      providerLabel: "OpenAI",
      model: { id: "gpt-6", isDefault: true },
    });
  });

  it("does not expand offline machines", () => {
    const rows = crossHostMenuRows(catalog, { hostId: "remote-ssh-codex-managed:tencent-id" });
    expect(rows.map((row) => row.kind)).toEqual(["machine", "machine"]);
  });

  it("uses localized machine status text", () => {
    expect(machineStatusLabel("ready")).toBe("");
    expect(machineStatusLabel("offline")).toBe("离线");
    expect(machineStatusLabel("error")).toBe("不可用");
  });
});
