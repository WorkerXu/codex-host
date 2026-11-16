import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveDingTalkHost } from "../src/dingtalk-settings.js";

const directories: string[] = [];

async function environmentWithPeers(peers: Record<string, { ssh: string; hostIds: string[] }>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dingtalk-settings-"));
  directories.push(directory);
  await writeFile(
    path.join(directory, "peers.json"),
    `${JSON.stringify({ formatVersion: 1, peers, self: { hostIds: ["host-local"] } }, null, 2)}\n`,
  );
  return { ...process.env, CODEXHOST_USER_DIR: directory, HOME: directory };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("DingTalk host resolution", () => {
  it("defaults to the tencent peer without exposing a login choice", async () => {
    const environment = await environmentWithPeers({
      tencent: { ssh: "tencent", hostIds: ["host-tencent"] },
      other: { ssh: "other", hostIds: ["host-other"] },
    });
    const resolved = await resolveDingTalkHost(environment, null);
    expect(resolved).toMatchObject({
      name: "tencent",
      hostId: "host-tencent",
      local: false,
      configured: null,
    });
    expect(resolved.peer?.name).toBe("tencent");
  });

  it("still reads a manual defaultHost override from the config file", async () => {
    const environment = await environmentWithPeers({
      tencent: { ssh: "tencent", hostIds: ["host-tencent"] },
    });
    const resolved = await resolveDingTalkHost(environment, "local");
    expect(resolved.name).toBe("local");
    expect(resolved.local).toBe(true);
  });

  it("falls back to the local login when tencent is not configured", async () => {
    const environment = await environmentWithPeers({});
    const resolved = await resolveDingTalkHost(environment, null);
    expect(resolved.name).toBe("local");
    expect(resolved.local).toBe(true);
  });
});
