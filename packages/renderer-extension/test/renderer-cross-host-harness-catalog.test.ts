import { harnessIdSchema, type HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  crossHostMachineEntries,
  loadCrossHostHarnessCatalog,
  readyHarnessPlugins,
} from "../src/renderer-cross-host-harness-catalog.js";

const claudeCode: HarnessPluginDescriptor = {
  id: harnessIdSchema.parse("claude-code"),
  name: "Claude Code",
  version: "1",
};
const notInstalled: HarnessPluginDescriptor = {
  id: harnessIdSchema.parse("grok"),
  name: "Grok",
  version: "1",
};
const usageOnly: HarnessPluginDescriptor = {
  id: harnessIdSchema.parse("usage-only"),
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
      {
        hostId: "remote-ssh-codex-managed:one",
        label: "oracle-sg",
        displayName: "oracle-sg",
      },
      { hostId: "remote-ssh-discovered:colab", label: "colab" },
    ]);
  });

  it("drops offline Hosts that only survive as stale remote projects", async () => {
    const catalog = await loadCrossHostHarnessCatalog({
      connections: [{ hostId: "remote-ssh-discovered:oracle-main", displayName: "甲骨文新加坡" }],
      knownHostIds: ["local"],
      remoteProjectHostIds: [
        "remote-ssh-discovered:oracle-main",
        "remote-ssh-codex-managed:967b5332-4d90-4970-8b4a-c71cc495f5d9",
      ],
      isOnline: (hostId) =>
        hostId !== "remote-ssh-codex-managed:967b5332-4d90-4970-8b4a-c71cc495f5d9",
      refresh: async () => undefined,
      directory: () => ({ plugins: [], availability: {}, error: null }),
    });
    expect(catalog.machines.map(({ hostId, label }) => ({ hostId, label }))).toEqual([
      { hostId: "remote-ssh-discovered:oracle-main", label: "甲骨文新加坡" },
    ]);
  });

  it("keeps an offline configured machine with its Desktop display name", async () => {
    const catalog = await loadCrossHostHarnessCatalog({
      connections: [{ hostId: "remote-ssh-codex-managed:offline", displayName: "远程测试机" }],
      knownHostIds: [],
      isOnline: () => false,
      refresh: async () => undefined,
      directory: () => ({ plugins: [], availability: {}, error: null }),
    });
    expect(catalog.machines).toEqual([
      {
        hostId: "remote-ssh-codex-managed:offline",
        label: "远程测试机",
        state: "offline",
        harnesses: [],
      },
    ]);
  });

  it("offers this Mac and skips the machine that owns the project", async () => {
    const catalog = await loadCrossHostHarnessCatalog({
      connections: [
        { hostId: "remote-ssh-discovered:oracle-main", displayName: "甲骨文新加坡" },
        { hostId: "remote-ssh-codex-managed:colab", displayName: "colab" },
      ],
      knownHostIds: ["local", "remote-ssh-discovered:oracle-main"],
      includeLocal: true,
      excludeHostIds: ["remote-ssh-discovered:oracle-main"],
      isOnline: () => true,
      refresh: async () => undefined,
      directory: () => ({
        plugins: [claudeCode, notInstalled],
        availability: { "claude-code": "ready", grok: "notInstalled" },
        error: null,
      }),
    });
    expect(
      catalog.machines.map(({ hostId, label, harnesses }) => ({
        hostId,
        label,
        harnesses: harnesses.map(({ id }) => id),
      })),
    ).toEqual([
      { hostId: "local", label: "此计算机", harnesses: ["codex", "claude-code"] },
      {
        hostId: "remote-ssh-codex-managed:colab",
        label: "colab",
        harnesses: ["codex", "claude-code"],
      },
    ]);
    expect(catalog.loadedPeers).toBe(2);
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
