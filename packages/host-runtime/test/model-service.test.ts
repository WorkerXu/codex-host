import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_SERVICE_TEST_METHOD, MODEL_SERVICE_SET_METHOD } from "@codexhost/shared-contracts";
import { ModelServiceSettingsStore } from "../src/model-service-settings.js";
import { ModelService } from "../src/model-service.js";

const directories: string[] = [];
async function store() {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "model-service-test-"));
  directories.push(configDirectory);
  return new ModelServiceSettingsStore({ configDirectory });
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

describe("shared model settings", () => {
  it("preserves old key files and exposes only the Gemini key state", async () => {
    const settings = await store();
    const gemini = settings.keyPath();
    const legacy = path.join(path.dirname(gemini), "openai-api-key");
    await writeFile(legacy, "legacy-test-fixture\n", { mode: 0o600 });
    expect(await settings.read()).toEqual({ gemini: { configured: false, lastFour: null } });
    await writeFile(gemini, "legacy-gemini-fixture-5678\n", { mode: 0o600 });
    expect(await settings.read()).toEqual({ gemini: { configured: true, lastFour: "5678" } });

    expect(
      await settings.update({ key: { provider: "gemini", value: "new-test-fixture-1234" } }),
    ).toEqual({ gemini: { configured: true, lastFour: "1234" } });
    expect(await readFile(gemini, "utf8")).toBe("new-test-fixture-1234\n");
    if (process.platform !== "win32") expect((await stat(gemini)).mode & 0o777).toBe(0o600);
    expect(await settings.update({ key: { provider: "gemini", value: null } })).toEqual({
      gemini: { configured: false, lastFour: null },
    });
    expect(await readFile(legacy, "utf8")).toBe("legacy-test-fixture\n");
  });

  it("rejects malformed inputs and OpenAI requests", async () => {
    const settings = await store();
    await expect(
      settings.update({ key: { provider: "gemini", value: "test\nfixture" } }),
    ).rejects.toThrow();
    const service = new ModelService(settings);
    await expect(
      service.request(MODEL_SERVICE_SET_METHOD, { key: { provider: "openai", value: null } }),
    ).rejects.toThrow();
    await expect(
      service.request(MODEL_SERVICE_TEST_METHOD, { provider: "openai" }),
    ).rejects.toThrow();
    expect(await settings.read()).toEqual({ gemini: { configured: false, lastFour: null } });
    expect(await service.request(MODEL_SERVICE_TEST_METHOD, { provider: "gemini" })).toEqual({
      ok: false,
      latencyMs: null,
      errorCode: "missing_key",
    });
  });
  it("tests the Gemini key using the same Decisions endpoint and model as DingTalk", async () => {
    const settings = await store();
    await settings.update({ key: { provider: "gemini", value: "fake-gemini-key" } });
    const fetchImpl = vi.fn(async () =>
      Response.json({ answers: { mentions_project: { noul: 0.9 } } }),
    );
    const result = await new ModelService(settings, fetchImpl).request(MODEL_SERVICE_TEST_METHOD, {
      provider: "gemini",
    });
    expect(result).toMatchObject({ ok: true, errorCode: null });
    const [endpoint, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "gemini-decision-1",
      questions: { mentions_project: { type: "noul" } },
    });
    expect(init.headers).toMatchObject({ "x-goog-api-key": "fake-gemini-key" });
  });
  it.each([
    [402, "quota_exhausted"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [429, "rate_limited"],
    [500, "provider_failed"],
  ])("maps Decisions HTTP %i for the Gemini key test", async (status, errorCode) => {
    const settings = await store();
    await settings.update({ key: { provider: "gemini", value: "fake-gemini-key" } });
    const service = new ModelService(settings, async () =>
      Response.json({ error: { message: "raw English error" } }, { status: Number(status) }),
    );
    expect(await service.request(MODEL_SERVICE_TEST_METHOD, { provider: "gemini" })).toEqual({
      ok: false,
      latencyMs: null,
      errorCode,
    });
  });
});
