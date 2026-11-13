import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_JARVIS_THRESHOLD } from "@codexhost/shared-contracts";

import { JarvisSettingsStore } from "../src/jarvis-settings.js";

const directories: string[] = [];
async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "codexhost-jarvis-settings-"));
  directories.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("Jarvis settings", () => {
  it("starts without a key and with the default threshold", async () => {
    const store = new JarvisSettingsStore({ configDirectory: await directory() });
    expect(await store.read()).toEqual({ hasKey: false, threshold: DEFAULT_JARVIS_THRESHOLD });
  });

  it("writes the key 0600 and never returns it from read()", async () => {
    const configDirectory = await directory();
    const store = new JarvisSettingsStore({ configDirectory });
    await store.writeKey("  test-key-value  ");
    expect(await store.readKey()).toBe("test-key-value");
    expect(await store.read()).toEqual({ hasKey: true, threshold: DEFAULT_JARVIS_THRESHOLD });
    if (process.platform !== "win32") {
      expect((await stat(store.keyPath)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(store.keyPath, "utf8")).toBe("test-key-value\n");
  });

  it("clears the key and clamps the threshold", async () => {
    const store = new JarvisSettingsStore({ configDirectory: await directory() });
    await store.writeKey("key");
    await store.writeThreshold(2);
    expect(await store.readThreshold()).toBe(1);
    await store.writeThreshold(-1);
    expect(await store.readThreshold()).toBe(0);
    await store.writeKey(null);
    expect(await store.readKey()).toBeNull();
  });

  it("rejects a multi-line or oversized stored value on read", async () => {
    const configDirectory = await directory();
    const store = new JarvisSettingsStore({ configDirectory });
    await store.writeKey("key");
    await chmod(store.keyPath, 0o600);
    await store.writeKey("two\nlines");
    expect(await store.readKey()).toBeNull();
  });

  it("falls back to defaults for malformed settings JSON", async () => {
    const configDirectory = await directory();
    const store = new JarvisSettingsStore({ configDirectory });
    await store.writeThreshold(0.3);
    const file = path.join(configDirectory, "jarvis-settings.json");
    await rm(file);
    expect(await store.readThreshold()).toBe(DEFAULT_JARVIS_THRESHOLD);
  });
});
