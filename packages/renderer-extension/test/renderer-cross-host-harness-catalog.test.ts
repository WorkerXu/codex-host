import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  crossHostMachineEntries,
  loadCrossHostHarnessCatalog,
  readyHarnessPlugins,
} from "../src/renderer-cross-host-harness-catalog.js";

const claudeCode: HarnessPluginDescriptor = {
  id: "claude-code",
  name: "Claude Code",
  version: "1",
};
const notInstalled: HarnessPluginDescriptor = { id: "grok", name: "Grok", version: "1" };
const usageOnly: HarnessPluginDescriptor = {
  id: "usage-only",
  name: "Usage",
  version: "1",
  kind: "usage",
};

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

  it("keeps only ready Harnesses and always exposes Codex", () => {
    expect(
      readyHarnessPlugins([claudeCode, notInstalled, usageOnly], {
        "claude-code": "ready",
        grok: "notInstalled",
      }),
    ).toEqual([
      { id: "codex", label: "Codex" },
      { id: "claude-code", label: "Claude Code", plugin: claudeCode },
    ]);
  });

  it("marks offline machines and keeps Codex when the directory fails", async () => {
    const refresh = vi.fn(async () => undefined);
    const catalog = await loadCrossHostHarnessCatalog({
      connections: [
        { hostId: "remote-ssh-codex-managed:one", displayName: "oracle-sg" },
        { hostId: "remote-ssh-codex-managed:two", displayName: "colab" },
        { hostId: "remote-ssh-codex-managed:three", displayName: "tencent" },
      ],
      knownHostIds: [],
      isOnline: (hostId) => hostId !== "remote-ssh-codex-managed:three",
      refresh,
      directory: (hostId) => {
        if (hostId === "remote-ssh-codex-managed:two")
          return { plugins: null, availability: {}, error: "unsupported" };
        return {
          plugins: [claudeCode, notInstalled],
          availability: { "claude-code": "ready", grok: "notInstalled" },
          error: null,
        };
      },
    });
    expect(refresh).toHaveBeenCalledTimes(2);
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
