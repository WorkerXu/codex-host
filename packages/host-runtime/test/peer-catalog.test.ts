import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DelegationPeerCatalogService } from "../src/peer-catalog.js";
import { writePeerConfig } from "../src/peer-config.js";
import type { PeerProcess, PeerSpawn } from "../src/peer-transport.js";

const roots: string[] = [];

async function environment(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(path.join(tmpdir(), "cx-peer-catalog-"));
  roots.push(root);
  const value = { CODEXHOST_USER_DIR: root };
  await writePeerConfig(value, {
    formatVersion: 1,
    peers: {
      mac: { ssh: "mac", hostIds: ["remote-ssh-discovered:mac"] },
      colab: { ssh: "colab", hostIds: ["remote-ssh-discovered:colab"] },
    },
    self: { hostIds: ["remote-ssh-discovered:self"] },
  });
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeProcess implements PeerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    this.emit("close", null, signal ?? null);
    return true;
  });
  readonly #listeners = new Map<string, ((...arguments_: never[]) => void)[]>();

  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: string, listener: (...arguments_: never[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...arguments_: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...(arguments_ as never[]));
    }
  }
}

function fakeSpawn(
  behavior: (input: { ssh: string; body: string }) => {
    code: number | null;
    stdout?: string;
    stderr?: string;
  },
): { spawnImpl: PeerSpawn; calls: { args: string[]; body: string }[] } {
  const calls: { args: string[]; body: string }[] = [];
  const spawnImpl: PeerSpawn = (_command, args) => {
    const child = new FakeProcess();
    let body = "";
    child.stdin.on("data", (chunk) => {
      body += chunk.toString();
    });
    child.stdin.on("end", () => {
      const ssh = args.at(-3) ?? "";
      calls.push({ args: [...args], body });
      const result = behavior({ ssh, body });
      setImmediate(() => {
        if (result.stdout !== undefined) child.stdout.write(result.stdout);
        if (result.stderr !== undefined) child.stderr.write(result.stderr);
        child.emit("close", result.code, null);
      });
    });
    return child;
  };
  return { spawnImpl, calls };
}

describe("DelegationPeerCatalogService", () => {
  it("lists configured peers, Harnesses and self IDs, then uses its cache", async () => {
    const env = await environment();
    const fake = fakeSpawn(({ ssh }) =>
      ssh === "mac"
        ? {
            code: 0,
            stdout: `${JSON.stringify({ harnesses: ["codex", "grok"] })}\n`,
          }
        : { code: 1, stderr: "ssh: connect to host colab: unreachable" },
    );
    const service = new DelegationPeerCatalogService(env, {
      spawnImpl: fake.spawnImpl,
      cacheTtlMs: 60_000,
      now: () => 1_000,
    });

    await expect(service.listPeers()).resolves.toEqual({
      peers: [
        {
          name: "colab",
          hostIds: ["remote-ssh-discovered:colab"],
          ssh: "colab",
          state: "unreachable",
          harnesses: [],
          error: expect.stringContaining("command failed"),
        },
        {
          name: "mac",
          hostIds: ["remote-ssh-discovered:mac"],
          ssh: "mac",
          state: "ready",
          harnesses: ["codex", "grok"],
        },
      ],
      self: { hostIds: ["remote-ssh-discovered:self"] },
    });
    expect(fake.calls).toHaveLength(2);

    await service.listPeers();
    expect(fake.calls).toHaveLength(2);
    await service.listPeers({ refresh: true });
    expect(fake.calls).toHaveLength(4);
  });

  it("serves a stale catalog immediately and revalidates in the background", async () => {
    const env = await environment();
    let now = 1_000;
    const fake = fakeSpawn(() => ({
      code: 0,
      stdout: `${JSON.stringify({ harnesses: ["codex"] })}\n`,
    }));
    const service = new DelegationPeerCatalogService(env, {
      spawnImpl: fake.spawnImpl,
      cacheTtlMs: 1_000,
      now: () => now,
    });

    const first = await service.listPeers();
    expect(fake.calls).toHaveLength(2);
    now = 2_000;
    await expect(service.listPeers()).resolves.toEqual(first);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(4));
  });

  it("drops Harnesses the peer reports as not installed or unavailable", async () => {
    const env = await environment();
    const fake = fakeSpawn(({ ssh }) =>
      ssh === "mac"
        ? {
            code: 0,
            stdout: `${JSON.stringify({
              harnesses: ["codex", "grok", "qwen"],
              availability: { codex: "ready", grok: "notInstalled", qwen: "unavailable" },
            })}\n`,
          }
        : {
            code: 0,
            stdout: `${JSON.stringify({
              harnesses: ["grok"],
              availability: { grok: "notInstalled" },
            })}\n`,
          },
    );
    const service = new DelegationPeerCatalogService(env, { spawnImpl: fake.spawnImpl });
    const result = await service.listPeers();
    expect(result.peers.find((peer) => peer.name === "mac")).toMatchObject({
      state: "ready",
      harnesses: ["codex"],
    });
    expect(result.peers.find((peer) => peer.name === "colab")).toMatchObject({
      state: "ready",
      harnesses: [],
    });
  });

  it("keeps known Harnesses when a previously reachable peer goes offline", async () => {
    const env = await environment();
    let offline = false;
    const fake = fakeSpawn(({ ssh }) =>
      offline || ssh === "colab"
        ? { code: 1, stderr: "offline" }
        : { code: 0, stdout: `${JSON.stringify({ harnesses: ["codex", "grok"] })}\n` },
    );
    const service = new DelegationPeerCatalogService(env, { spawnImpl: fake.spawnImpl });
    const first = await service.listPeers();
    expect(first.peers.find((peer) => peer.name === "mac")).toMatchObject({
      state: "ready",
      harnesses: ["codex", "grok"],
    });

    offline = true;
    const second = await service.listPeers({ refresh: true });
    expect(second.peers.find((peer) => peer.name === "mac")).toMatchObject({
      state: "unreachable",
      harnesses: ["codex", "grok"],
    });
  });

  it("reads a remote Thread through the peer transport", async () => {
    const env = await environment();
    const fake = fakeSpawn(() => ({
      code: 0,
      stdout: `${JSON.stringify({
        threadId: "remote-thread",
        harnessId: "grok",
        status: "running",
        turn: { turnId: "turn-1", status: "running" },
        progress: [],
        result: { availability: "pending" },
        nextCursor: null,
      })}\n`,
    }));
    const service = new DelegationPeerCatalogService(env, { spawnImpl: fake.spawnImpl });
    await expect(
      service.readThread({ hostId: "mac", threadId: "remote-thread" }),
    ).resolves.toMatchObject({ threadId: "remote-thread", status: "running" });
    expect(fake.calls[0]?.args).toContain("peer-exec");
    expect(JSON.parse(fake.calls[0]?.body ?? "{}")).toEqual({
      route: "/v1/thread/read",
      body: { threadId: "remote-thread", view: "result" },
    });
    await expect(
      service.readThread({ hostId: "unknown", threadId: "remote-thread" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
