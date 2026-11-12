import { describe, expect, it } from "vitest";

import {
  crossHostMachineEntries,
  loadCrossHostHarnessCatalog,
  parseHarnessPlugins,
} from "../src/renderer-cross-host-harness-catalog.js";

describe("cross-host harness catalog", () => {
  it("uses Desktop display names and deduplicates Host IDs", () => {
    expect(
      crossHostMachineEntries({
        connections: [
          { hostId: "remote-ssh-codex-managed:one", displayName: "oracle-sg" },
          { hostId: "local", displayName: "This Mac" },
        ],
        knownHostIds: [
          "local",
          "durable",
          "remote-ssh-codex-managed:one",
          "remote-ssh-discovered:colab",
        ],
      }),
    ).toEqual([
      { hostId: "remote-ssh-codex-managed:one", label: "oracle-sg" },
      { hostId: "remote-ssh-discovered:colab", label: "colab" },
    ]);
  });

  it("always exposes Codex and hides capability-only plugins", () => {
    expect(
      parseHarnessPlugins({
        plugins: [
          { id: "claude-code", name: "Claude Code" },
          { id: "usage-only", name: "Usage", kind: "usage" },
          { id: "claude-code", name: "Duplicate" },
          { id: "codex", name: "Codex plugin" },
        ],
      }),
    ).toEqual([
      { id: "codex", label: "Codex" },
      { id: "claude-code", label: "Claude Code" },
    ]);
    expect(() => parseHarnessPlugins({})).toThrow("Harness plugin list");
  });

  it("marks offline machines and keeps Codex when discovery fails", async () => {
    const catalog = await loadCrossHostHarnessCatalog({
      connections: [
        { hostId: "remote-ssh-codex-managed:one", displayName: "oracle-sg" },
        { hostId: "remote-ssh-codex-managed:two", displayName: "colab" },
        { hostId: "remote-ssh-codex-managed:three", displayName: "tencent" },
      ],
      knownHostIds: [],
      isOnline: (hostId) => hostId !== "remote-ssh-codex-managed:three",
      request: async (hostId) => {
        if (hostId === "remote-ssh-codex-managed:two") throw new Error("unsupported");
        return { plugins: [{ id: "claude-code", name: "Claude Code" }] };
      },
    });
    expect(catalog.loadedPeers).toBe(1);
    expect(catalog.machines).toMatchObject([
      {
        label: "oracle-sg",
        state: "ready",
        harnesses: [
          { id: "codex", label: "Codex" },
          { id: "claude-code", label: "Claude Code" },
        ],
      },
      { label: "colab", state: "error", harnesses: [{ id: "codex", label: "Codex" }] },
      { label: "tencent", state: "offline", harnesses: [] },
    ]);
  });
});
