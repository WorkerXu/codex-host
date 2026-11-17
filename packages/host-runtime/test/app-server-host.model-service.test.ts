import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelService } from "../src/model-service.js";
import { ModelServiceSettingsStore } from "../src/model-service-settings.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

describe("Host shared model-service RPC", () => {
  it("registers only with a local service and does not return credentials", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "model-service-rpc-"));
    const fixture = createFixture({
      modelService: new ModelService(new ModelServiceSettingsStore({ configDirectory: directory })),
    });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/model-service/set",
        params: { key: { provider: "openai", value: "fake-private-key-5678" } },
      });
      const result = await fixture.collector.waitFor((message) => requestId(message, 1));
      expect(result).toMatchObject({
        result: { provider: "openai", openai: { configured: true, lastFour: "5678" } },
      });
      expect(JSON.stringify(result)).not.toContain("fake-private-key");
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/model-service/get",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        result: { openai: { configured: true, lastFour: "5678" } },
      });
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/model-service/set",
        params: { key: { provider: "unknown", value: "fake-private-key-5678" } },
      });
      const invalid = await fixture.collector.waitFor((message) => requestId(message, 3));
      expect(invalid).toMatchObject({ error: { code: -32602, message: "invalid_params" } });
      expect(JSON.stringify(invalid)).not.toContain("fake-private-key");
    } finally {
      await stopFixture(fixture);
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects model settings on Hosts without local registration", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/model-service/get",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        error: { code: -32601, message: "local_only" },
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
