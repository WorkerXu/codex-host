import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_SERVICE_TEST_METHOD,
  MODEL_SERVICE_SET_METHOD,
  jarvisBugQuerySchema,
} from "@codexhost/shared-contracts";
import { ModelServiceSettingsStore } from "../src/model-service-settings.js";
import { ModelService } from "../src/model-service.js";
import {
  createJarvisProviderQuery,
  createJarvisQueryParser,
  buildJarvisQueryRequest,
  JARVIS_QUERY_SCHEMA,
} from "../src/jarvis-query-parser.js";
import { strictJsonSchema } from "../src/structured-query-client.js";

const directories: string[] = [];
const QUERY = {
  scope: "assigned",
  statuses: [1],
  priorities: [],
  severities: [],
  order: "newest",
  timeWindow: null,
  titleKeywords: ["发货"],
  projectNames: [],
  unrecognized: null,
};
const openaiResponse = (value: unknown = QUERY) =>
  Response.json({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }],
  });
const client = (fetchImpl: typeof fetch, readApiKey = async () => "fake-api-key-1234") =>
  createJarvisProviderQuery({ provider: "openai", fetchImpl, readApiKey });
async function store() {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "model-service-test-"));
  directories.push(configDirectory);
  return new ModelServiceSettingsStore({ configDirectory });
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
describe("OpenAI structured parser", () => {
  it("rejects a removed parser provider before reading credentials or sending a request", async () => {
    const readApiKey = vi.fn();
    const fetchImpl = vi.fn();
    const parser = createJarvisProviderQuery({
      provider: "gemini",
      readApiKey,
      fetchImpl,
    } as never);
    await expect(parser.interpret("bug", 0)).rejects.toMatchObject({ code: "provider_failed" });
    expect(readApiKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a proxy response after 5.8 seconds and aborts at exactly ten seconds", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_800));
      return openaiResponse();
    });
    const result = client(fetchImpl).interpret("我还没处理的，标题有发货的", 0);
    await vi.advanceTimersByTimeAsync(5_800);
    expect(await result).toEqual(QUERY);
    const signals: AbortSignal[] = [];
    const stalled = client(async (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise(() => {});
    });
    const assertion = expect(stalled.interpret("bug", 0)).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["key", "fetch", "body"])(
    "cancels stalled %s immediately and aborts the HTTP signal",
    async (stage) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let signal: AbortSignal | null | undefined;
      const stalled = () => new Promise<never>(() => {});
      const parser = client(
        async (_url, init) => {
          signal = init?.signal;
          return stage === "fetch"
            ? stalled()
            : ({ ok: true, json: stalled } as unknown as Response);
        },
        stage === "key" ? stalled : async () => "fake-key",
      );
      const result = parser.interpret("旧查询", 0, controller.signal);
      const assertion = expect(result).rejects.toMatchObject({ code: "cancelled" });
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      await assertion;
      if (stage !== "key") expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("posts the original instructions, whole query and Shanghai boundaries with a strict schema", async () => {
    const fetchImpl = vi.fn(async () => openaiResponse());
    const now = Date.parse("2026-11-16T01:30:00+08:00");
    expect(await client(fetchImpl).interpret("我还没处理的标题有发货的", now)).toEqual(QUERY);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer fake-api-key-1234",
    });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4.1-mini");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "jarvis_bug_query", strict: true, schema: JARVIS_QUERY_SCHEMA },
    });
    const request = buildJarvisQueryRequest("我还没处理的标题有发货的", now);
    expect(body.messages[0].content).toBe(request.instructions);
    expect(JSON.parse(body.messages[1].content)).toMatchObject({
      query: "我还没处理的标题有发货的",
      timeZone: "Asia/Shanghai",
      date: "2026-11-16",
      boundaries: {
        lastWeek: {
          since: Date.parse("2026-11-09T00:00:00+08:00"),
          until: Date.parse("2026-11-16T00:00:00+08:00"),
        },
      },
    });
    expect(init.body).not.toContain("fake-api-key");
  });
  it("converts nested nullable objects with all fields required and no additional properties", () => {
    expect(
      strictJsonSchema({
        type: "OBJECT",
        properties: {
          window: {
            type: "OBJECT",
            nullable: true,
            properties: { since: { type: "INTEGER", nullable: true } },
          },
        },
      }),
    ).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["window"],
      properties: {
        window: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["since"],
          properties: { since: { type: ["integer", "null"] } },
        },
      },
    });
    const visit = (node: Record<string, unknown>) => {
      expect(node).not.toHaveProperty("nullable");
      if (node.properties) {
        expect(node.additionalProperties).toBe(false);
        expect(node.required).toEqual(Object.keys(node.properties));
        for (const child of Object.values(node.properties)) visit(child as Record<string, unknown>);
      }
      if (node.items) visit(node.items as Record<string, unknown>);
    };
    visit(JARVIS_QUERY_SCHEMA);
  });
  it.each([
    [401, {}, "unauthorized"],
    [403, {}, "unauthorized"],
    [402, {}, "quota_exhausted"],
    [429, { error: { code: "insufficient_quota" } }, "quota_exhausted"],
    [429, { error: { message: "prepayment credits are depleted" } }, "quota_exhausted"],
    [429, { error: { code: "rate_limit_exceeded" } }, "rate_limited"],
    [500, {}, "provider_failed"],
  ])("maps HTTP %s without exposing API error text", async (status, body, code) => {
    await expect(
      client(async () => Response.json(body, { status })).interpret("bug", Date.now()),
    ).rejects.toMatchObject({ code, provider: "openai", message: code });
  });
  it.each([
    { choices: [{ finish_reason: "length", message: { content: JSON.stringify(QUERY) } }] },
    {
      choices: [
        { finish_reason: "stop", message: { refusal: "refused", content: JSON.stringify(QUERY) } },
      ],
    },
    { choices: [{ finish_reason: "stop", message: { content: "{invalid" } }] },
    { choices: [] },
    null,
  ])("rejects incomplete, refused or invalid responses", async (value) => {
    await expect(
      client(async () => Response.json(value)).interpret("bug", 0),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("keeps Zod validation and project/title separation", async () => {
    const value = { ...QUERY, titleKeywords: ["登录"], projectNames: ["安心买"] };
    expect(
      await client(async () => openaiResponse(value)).interpret("安心买的标题含登录的bug", 0),
    ).toEqual(value);
    expect(jarvisBugQuerySchema.safeParse({ ...QUERY, scope: "invalid" }).success).toBe(false);
    await expect(
      client(async () => openaiResponse({ ...QUERY, extra: true })).interpret("bug", 0),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each(["key", "fetch", "body"])("bounds stalled %s to ten seconds", async (stage) => {
    vi.useFakeTimers();
    const stalled = () => new Promise<never>(() => {});
    const parser = client(
      async () =>
        stage === "fetch" ? stalled() : ({ ok: true, json: stalled } as unknown as Response),
      stage === "key" ? stalled : async () => "fake-key",
    );
    const assertion = expect(parser.interpret("bug", 0)).rejects.toMatchObject({
      code: "timeout",
      provider: "openai",
    });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("includes stalled provider selection in the ten-second deadline", async () => {
    vi.useFakeTimers();
    const settings = await store();
    vi.spyOn(settings, "provider").mockImplementation(() => new Promise(() => {}));
    const readKey = vi.spyOn(settings, "readKey");
    const parser = createJarvisQueryParser({ settings, isLocalHost: true });
    const assertion = expect(parser.interpret("bug", 0)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(readKey).not.toHaveBeenCalled();
  });
  it("does not request a model with no key", async () => {
    const fetchImpl = vi.fn();
    await expect(
      client(fetchImpl, async () => null as unknown as string).interpret("bug", 0),
    ).rejects.toMatchObject({ code: "missing_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
describe("shared model settings", () => {
  it("defaults to OpenAI, stores private keys and returns only configured state and four characters", async () => {
    const settings = await store();
    expect(await settings.read()).toEqual({
      provider: "openai",
      openai: { configured: false, lastFour: null },
      gemini: { configured: false, lastFour: null },
    });
    const snapshot = await settings.update({
      key: { provider: "openai", value: "fake-openai-key-1234" },
    });
    expect(snapshot.openai).toEqual({ configured: true, lastFour: "1234" });
    expect(JSON.stringify(snapshot)).not.toContain("fake-openai");
    expect(await readFile(settings.keyPath("openai"), "utf8")).toBe("fake-openai-key-1234\n");
    if (process.platform !== "win32")
      expect((await stat(settings.keyPath("openai"))).mode & 0o777).toBe(0o600);
    await writeFile(settings.keyPath("gemini"), "legacy-gemini-key-5678\n");
    expect((await settings.read()).gemini).toEqual({ configured: true, lastFour: "5678" });
    await settings.update({ key: { provider: "openai", value: null } });
    expect(await settings.readKey("openai")).toBeNull();
  });
  it("rejects invalid keys/provider values and never returns unsaved input", async () => {
    const settings = await store();
    await expect(
      settings.update({ key: { provider: "openai", value: "key\nwith\nnewlines" } }),
    ).rejects.toThrow();
    const service = new ModelService(settings);
    await expect(
      service.request(MODEL_SERVICE_SET_METHOD, { provider: "unknown" }),
    ).rejects.toThrow();
    expect((await settings.read()).openai.configured).toBe(false);
  });
  it("normalizes legacy Gemini parser selection to OpenAI and keeps both keys independent", async () => {
    const settings = await store();
    await settings.update({ key: { provider: "gemini", value: "fake-gemini-key" } });
    await writeFile(
      path.join(path.dirname(settings.keyPath("gemini")), "model-service.json"),
      JSON.stringify({ provider: "gemini" }),
    );
    expect((await settings.read()).provider).toBe("openai");
    const fetchImpl = vi.fn(async () => openaiResponse());
    const parser = createJarvisQueryParser({ settings, isLocalHost: true, fetchImpl });
    await expect(parser.interpret("bug", 0)).rejects.toMatchObject({
      code: "missing_key",
      provider: "openai",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await settings.update({ key: { provider: "openai", value: "fake-openai-key" } });
    expect(await parser.interpret("bug", 0)).toEqual(QUERY);
    expect((fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]?.[0]).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(await settings.readKey("gemini")).toBe("fake-gemini-key");
    await expect(settings.update({ provider: "gemini" } as never)).rejects.toThrow();
    const remote = createJarvisQueryParser({ settings, isLocalHost: false, fetchImpl });
    const key = vi.spyOn(settings, "readKey");
    await expect(remote.interpret("bug", 0)).rejects.toMatchObject({ code: "missing_key" });
    expect(key).not.toHaveBeenCalled();
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
  it("tests each provider independently and reports latency or stable errors only", async () => {
    const settings = await store();
    await settings.update({ key: { provider: "openai", value: "fake-openai-key" } });
    const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1123);
    const service = new ModelService(settings, async () => openaiResponse({ ok: true }), now);
    expect(await service.request(MODEL_SERVICE_TEST_METHOD, { provider: "openai" })).toEqual({
      ok: true,
      latencyMs: 123,
      errorCode: null,
    });
    expect(await service.request(MODEL_SERVICE_TEST_METHOD, { provider: "gemini" })).toEqual({
      ok: false,
      latencyMs: null,
      errorCode: "missing_key",
    });
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
