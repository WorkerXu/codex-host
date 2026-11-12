import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessAvailabilityStore } from "../src/harness-availability-store.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cx-availability-store-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("HarnessAvailabilityStore", () => {
  it("persists checked status under the user cache, not runtime/", async () => {
    const directory = await root();
    const environment = { CODEXHOST_USER_DIR: directory };
    const store = new HarnessAvailabilityStore(environment);
    expect(store.filePath).toBe(path.join(directory, "cache", "harness-availability.json"));

    await store.set("grok", {
      status: "ready",
      checkedAt: 1_700_000_000_000,
      fingerprint: "1.2.3:1:2",
    });

    const reopened = new HarnessAvailabilityStore(environment);
    await expect(reopened.get("grok")).resolves.toEqual({
      status: "ready",
      checkedAt: 1_700_000_000_000,
      fingerprint: "1.2.3:1:2",
    });
    const filePath = store.filePath;
    if (!filePath) throw new Error("Expected a persistent file path");
    const file = JSON.parse(await readFile(filePath, "utf8")) as {
      formatVersion: number;
      entries: Record<string, unknown>;
    };
    expect(file).toMatchObject({
      formatVersion: 1,
      entries: {
        grok: {
          status: "ready",
          checkedAt: 1_700_000_000_000,
          fingerprint: "1.2.3:1:2",
        },
      },
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("invalidates one entry and ignores a corrupt cache", async () => {
    const directory = await root();
    const environment = { CODEXHOST_USER_DIR: directory };
    const store = new HarnessAvailabilityStore(environment);
    await store.set("grok", { status: "ready", checkedAt: 1 });
    await store.set("pi", { status: "notInstalled", checkedAt: 1 });
    await store.invalidate("grok");

    const reopened = new HarnessAvailabilityStore(environment);
    await expect(reopened.get("grok")).resolves.toBeUndefined();
    await expect(reopened.get("pi")).resolves.toMatchObject({ status: "notInstalled" });

    const filePath = store.filePath;
    if (!filePath) throw new Error("Expected a persistent file path");
    await store.set("grok", { status: "ready", checkedAt: 2 });
    await rm(filePath);
    const missing = new HarnessAvailabilityStore(environment);
    await expect(missing.get("grok")).resolves.toBeUndefined();

    const corruptRoot = await root();
    const corruptPath = path.join(corruptRoot, "cache");
    const corrupt = new HarnessAvailabilityStore({ CODEXHOST_USER_DIR: corruptRoot });
    await corrupt.set("grok", { status: "ready", checkedAt: 1 });
    if (!corrupt.filePath) throw new Error("Expected a persistent file path");
    await rm(corrupt.filePath);
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(corruptPath, { recursive: true }).then(() =>
        writeFile(corrupt.filePath ?? "", "not json", "utf8"),
      ),
    );
    await expect(
      new HarnessAvailabilityStore({ CODEXHOST_USER_DIR: corruptRoot }).get("grok"),
    ).resolves.toBeUndefined();
  });
});
