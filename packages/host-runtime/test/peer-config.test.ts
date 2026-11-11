import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parsePeerConfig,
  peerConfigPath,
  peerThreadReference,
  readPeerConfig,
  resolvePeerTarget,
  writePeerConfig,
  type PeerConfig,
} from "../src/peer-config.js";

const roots: string[] = [];

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cx-peers-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(): PeerConfig {
  return {
    formatVersion: 1,
    peers: {
      mac: {
        ssh: "mac",
        hostIds: ["remote-ssh-discovered:mac"],
      },
      oracle: {
        ssh: "ubuntu@oracle-main",
        hostIds: ["local", "remote-ssh-discovered:oracle-main"],
        command: "/opt/codexhost/bin/codexhost",
      },
    },
  };
}

describe("peer configuration", () => {
  it("round-trips peers with owner-only permissions", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_DATA_DIR: root };
    await writePeerConfig(environment, config());
    await expect(readPeerConfig(environment)).resolves.toEqual(config());
    if (process.platform !== "win32") {
      expect((await stat(peerConfigPath(environment))).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(peerConfigPath(environment), "utf8"))).toEqual(config());
  });

  it("treats a missing file as no peers", async () => {
    const root = await dataDirectory();
    await expect(readPeerConfig({ CODEXHOST_DATA_DIR: root })).resolves.toEqual({
      formatVersion: 1,
      peers: {},
    });
  });

  it.each([
    ["not an object", []],
    ["wrong version", { formatVersion: 2, peers: {} }],
    ["missing peers", { formatVersion: 1 }],
    ["missing ssh", { formatVersion: 1, peers: { mac: { hostIds: [] } } }],
    ["reserved name", { formatVersion: 1, peers: { local: { ssh: "mac", hostIds: [] } } }],
    [
      "shell syntax in command",
      {
        formatVersion: 1,
        peers: { mac: { ssh: "mac", hostIds: [], command: "codexhost; rm -rf /" } },
      },
    ],
    ["an option-like SSH alias", { formatVersion: 1, peers: { mac: { ssh: "-o", hostIds: [] } } }],
    [
      "an option-like remote command",
      { formatVersion: 1, peers: { mac: { ssh: "mac", hostIds: [], command: "-c" } } },
    ],
    [
      "duplicate Host ID",
      {
        formatVersion: 1,
        peers: {
          mac: { ssh: "mac", hostIds: ["remote-ssh-discovered:host"] },
          other: { ssh: "other", hostIds: ["remote-ssh-discovered:host"] },
        },
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => parsePeerConfig(value)).toThrow();
  });

  it("rejects malformed stored JSON with the file path", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_DATA_DIR: root };
    await writeFile(peerConfigPath(environment), "{oops");
    await expect(readPeerConfig(environment)).rejects.toThrow(peerConfigPath(environment));
  });

  it("resolves peer names, Host IDs, and the local placeholder", () => {
    const peers = config();
    expect(resolvePeerTarget(peers, "mac")).toMatchObject({
      name: "mac",
      ssh: "mac",
      linkHostId: "remote-ssh-discovered:mac",
    });
    expect(resolvePeerTarget(peers, "remote-ssh-discovered:oracle-main")).toMatchObject({
      name: "oracle",
      linkHostId: "remote-ssh-discovered:oracle-main",
    });
    // A configured peer may claim links created with its own "local" identity.
    expect(resolvePeerTarget(peers, "local")).toMatchObject({ name: "oracle" });
    expect(resolvePeerTarget({ formatVersion: 1, peers: {} }, "local")).toBe("local");
    expect(resolvePeerTarget(peers, "unknown")).toBeUndefined();
  });

  it("encodes host-qualified Thread links", () => {
    expect(peerThreadReference("thread-1", "remote-ssh-discovered:mac")).toBe(
      "thread://thread-1?hostId=remote-ssh-discovered%3Amac",
    );
  });
});
