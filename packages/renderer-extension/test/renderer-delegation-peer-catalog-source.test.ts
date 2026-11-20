import { describe, expect, it, vi } from "vitest";

import type { DelegationPeerCatalog } from "@codexhost/shared-contracts";

import { createDelegationPeerCatalogSource } from "../src/renderer-delegation-peer-catalog-source.js";

/** The Mac's Host Runtime lists oracle-main; oracle-main lists this Mac. */
const macCatalog: DelegationPeerCatalog = {
  peers: [
    {
      name: "oracle-main",
      hostIds: ["remote-ssh-discovered:oracle-main"],
      ssh: "oracle-main",
      state: "ready",
      harnesses: ["antigravity", "claude-code", "codex"],
    },
  ],
  self: { hostIds: ["local"] },
};

const oracleCatalog: DelegationPeerCatalog = {
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

function catalogFor(hostId: string): DelegationPeerCatalog {
  return hostId === "local" ? macCatalog : oracleCatalog;
}

async function flushed(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("per-Host delegation peer catalogs", () => {
  it("keeps each Host's peers apart", async () => {
    const load = vi.fn(async (hostId: string) => catalogFor(hostId));
    const source = createDelegationPeerCatalogSource({ load });
    source.refresh("local");
    source.refresh("remote-ssh-discovered:oracle-main");
    await flushed();
    expect(load.mock.calls.map(([hostId]) => hostId)).toEqual([
      "local",
      "remote-ssh-discovered:oracle-main",
    ]);
    expect(source.get("local")?.peers[0]?.name).toBe("oracle-main");
    expect(source.get("remote-ssh-discovered:oracle-main")?.peers[0]?.name).toBe("mac");
    expect(source.get("remote-ssh-discovered:unloaded")).toBeNull();
  });

  it("refreshes a cached Host in the background and tells the menu", async () => {
    let now = 1_000;
    const load = vi.fn(async (hostId: string) => catalogFor(hostId));
    const onUpdate = vi.fn();
    const source = createDelegationPeerCatalogSource({
      load,
      onUpdate,
      now: () => now,
      revalidateMs: 100,
    });
    source.refresh("local");
    await flushed();
    expect(load).toHaveBeenLastCalledWith("local", { refresh: false });

    now += 50;
    source.refresh("local");
    await flushed();
    expect(load).toHaveBeenCalledTimes(1);

    now += 60;
    source.refresh("local");
    await flushed();
    expect(load).toHaveBeenLastCalledWith("local", { refresh: true });
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("shares one request per Host and keeps the last catalog on failure", async () => {
    const pending: { resolve?: (catalog: DelegationPeerCatalog) => void } = {};
    const load = vi.fn(
      () =>
        new Promise<DelegationPeerCatalog>((done) => {
          pending.resolve = done;
        }),
    );
    const source = createDelegationPeerCatalogSource({ load, revalidateMs: 0 });
    source.refresh("local");
    source.refresh("local");
    await flushed();
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve?.(macCatalog);
    await flushed();
    expect(source.get("local")).toBe(macCatalog);

    load.mockRejectedValueOnce(new Error("Host runtime is unavailable"));
    source.refresh("local");
    await flushed();
    expect(source.get("local")).toBe(macCatalog);
  });

  it("drops pending results after disposal", async () => {
    const pending: { resolve?: (catalog: DelegationPeerCatalog) => void } = {};
    const load = vi.fn(
      () =>
        new Promise<DelegationPeerCatalog>((done) => {
          pending.resolve = done;
        }),
    );
    const source = createDelegationPeerCatalogSource({ load });
    source.refresh("local");
    source.dispose();
    pending.resolve?.(macCatalog);
    await flushed();
    expect(source.get("local")).toBeNull();
  });
});
