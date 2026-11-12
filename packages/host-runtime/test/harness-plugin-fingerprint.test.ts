import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { harnessPluginFingerprints } from "../src/harness-plugin-fingerprint.js";

const roots: string[] = [];

async function pluginRoot(version = "1.0.0"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-plugin-fingerprint-"));
  roots.push(root);
  await writeFile(path.join(root, "enabled.json"), JSON.stringify({ version: 1, enabled: ["pi"] }));
  const plugin = path.join(root, "pi");
  await mkdir(plugin);
  await writeFile(path.join(plugin, "index.mjs"), "");
  await writeFile(
    path.join(plugin, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "pi",
      name: "Pi",
      version,
      adapterApiVersion: 1,
      entry: "index.mjs",
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("harnessPluginFingerprints", () => {
  it("changes when a plugin version changes", async () => {
    const root = await pluginRoot("1.0.0");
    const first = await harnessPluginFingerprints([root]);
    expect(first.get("pi")).toContain("1.0.0");

    await writeFile(
      path.join(root, "pi", "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "pi",
        name: "Pi",
        version: "2.0.0",
        adapterApiVersion: 1,
        entry: "index.mjs",
      }),
    );
    const second = await harnessPluginFingerprints([root]);
    expect(second.get("pi")).toContain("2.0.0");
    expect(second.get("pi")).not.toBe(first.get("pi"));
  });

  it("returns an empty map without roots or when a plugin is removed", async () => {
    expect(await harnessPluginFingerprints([])).toEqual(new Map());
    const root = await pluginRoot();
    await rm(path.join(root, "pi"), { recursive: true });
    expect(await harnessPluginFingerprints([root])).toEqual(new Map());
  });
});
