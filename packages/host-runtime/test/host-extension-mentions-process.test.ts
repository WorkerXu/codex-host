import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ExtensionBackendProcess } from "@codexhost/extension-backend";
import { formatHostExtensionMentionToken } from "@codexhost/shared-contracts";
import { expect, it } from "vitest";
import { HostExtensionMentions } from "../src/host-extension-mentions.js";

it("completes a 15 second search through short calls in the same live backend process", async () => {
  const extensionDir = await realpath(
    fileURLToPath(new URL("../../../tests/fixtures/host-extension-mentions", import.meta.url)),
  );
  const dataDir = await mkdtemp(path.join(tmpdir(), "mention-process-"));
  const backend = new ExtensionBackendProcess({
    readSettings: async () => ({}),
    writeSettings: async (values) => values,
  });
  const entry = path.join(extensionDir, "backend/index.mjs");
  const { dev, ino } = await stat(extensionDir, { bigint: true });
  try {
    await backend.activate({
      extensionId: "mention-sample",
      extensionDir,
      dataDir,
      url: pathToFileURL(entry).href,
      hash: createHash("sha256")
        .update(await readFile(entry))
        .digest("hex"),
      installation: `${dev}:${ino}`,
    });
    const invoke = (method: string, params: unknown) => backend.invoke(method, params);
    const sources = [
      { id: "demo", label: { en: "Demo", "zh-CN": "示例" } },
      { id: "two-step", label: { en: "Picker", "zh-CN": "面板" }, picker: true },
    ];
    const resolved = { id: "mention-sample", sources, invoke };
    const mentions = new HostExtensionMentions({
      listBackends: async () => [resolved],
      resolveBackend: async () => ({ backend: resolved }),
      diagnose: () => undefined,
    });
    const before = (await backend.invoke("fixture/status", {})) as { pid: number };
    const started = Date.now();
    const searchId = randomUUID();
    let result = await mentions.search({ requestId: searchId, query: "slow" });
    while (result.pending) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = await mentions.search({ requestId: searchId, query: "slow" });
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(15_000);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.items.map((item) => item.itemId)).toEqual([
      "alpha",
      "beta",
      "unicode",
    ]);
    expect(await backend.invoke("fixture/status", {})).toMatchObject({
      pid: before.pid,
      activeJobs: 0,
    });
    const requestId = randomUUID();
    const pending = mentions.search({ requestId, query: "slow" });
    await expect
      .poll(async () => (await backend.invoke("fixture/status", {})) as { activeJobs: number })
      .toMatchObject({ activeJobs: 1 });
    await mentions.cancel({ requestId });
    expect(await pending).toEqual({ groups: [], pending: true });
    expect(await backend.invoke("fixture/status", {})).toMatchObject({
      pid: before.pid,
      activeJobs: 0,
      cancelled: 1,
    });
    const token = (itemId: string) =>
      formatHostExtensionMentionToken({
        extensionId: "mention-sample",
        sourceId: "two-step",
        itemId,
        label: itemId,
      });
    const expanded = await mentions.expandTexts([`${token("alpha")} ${token("beta")}`]);
    expect(expanded[0]).toContain("[Demo mention] Alpha");
    expect(expanded[0]).toContain("[Demo mention] Beta");
    expect(expanded[0]).not.toContain("codexhost-extension://");
  } finally {
    await backend.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 25_000);
