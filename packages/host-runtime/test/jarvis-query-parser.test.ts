import { afterEach, describe, expect, it, vi } from "vitest";

import { jarvisBugQuerySchema, type JarvisBugQuery } from "@codexhost/shared-contracts";

import {
  buildJarvisQueryRequest,
  createJarvisProviderQuery,
  jarvisQueryTimeContext,
} from "../src/jarvis-query-parser.js";
import { JarvisService } from "../src/jarvis-service.js";
import { ModelServiceSettingsStore } from "../src/model-service-settings.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const JARVIS_QUERY_MODEL = "gemini-3.5-flash-lite";
const JARVIS_QUERY_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${JARVIS_QUERY_MODEL}:generateContent`;
const createJarvisGeminiQuery = (
  options: Omit<Parameters<typeof createJarvisProviderQuery>[0], "provider">,
) => createJarvisProviderQuery({ ...options, provider: "gemini" });

const NOW = Date.parse("2026-11-16T01:30:00+08:00");
const QUERY: JarvisBugQuery = {
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

/** Captured Gemini 3 response shape: a thought part precedes the JSON answer. */
function response(value: unknown = QUERY): Response {
  return Response.json({
    candidates: [
      {
        content: {
          parts: [
            { text: "Thinking about the query", thought: true },
            { text: JSON.stringify(value) },
          ],
          role: "model",
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 251,
      candidatesTokenCount: 48,
      totalTokenCount: 299,
    },
    modelVersion: JARVIS_QUERY_MODEL,
    responseId: "captured-gemini-response",
  });
}

afterEach(() => vi.useRealTimers());

describe("Jarvis Gemini structured query", () => {
  it("posts the whole query to Gemini 3.5 Flash-Lite with a response schema", async () => {
    const fetchImpl = vi.fn(async () => response());
    const client = createJarvisGeminiQuery({ readApiKey: async () => "test-key", fetchImpl });
    expect(await client.interpret("我还没处理的标题有发货的", NOW)).toEqual(QUERY);
    expect(JARVIS_QUERY_MODEL).toBe("gemini-3.5-flash-lite");
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      JARVIS_QUERY_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": "test-key" },
      }),
    );
    const request = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(request.systemInstruction.parts[0].text).toBe(
      buildJarvisQueryRequest("我还没处理的标题有发货的", NOW).instructions,
    );
    expect(JSON.parse(request.contents[0].parts[0].text)).toMatchObject({
      query: "我还没处理的标题有发货的",
      nowMs: NOW,
      now: new Date(NOW).toISOString(),
      timeZone: "Asia/Shanghai",
      date: "2026-11-16",
    });
    expect(request.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      temperature: 0,
      maxOutputTokens: 2_048,
    });
    expect(request.generationConfig.responseSchema).toMatchObject({
      type: "OBJECT",
      properties: {
        scope: { type: "STRING", enum: ["assigned", "created", "both"] },
        timeWindow: {
          type: "OBJECT",
          nullable: true,
          properties: {
            since: { type: "INTEGER", nullable: true },
            field: { type: "STRING", enum: ["create", "update"] },
          },
        },
        unrecognized: { type: "STRING", nullable: true },
      },
    });
    expect(JSON.stringify(request.generationConfig.responseSchema)).not.toContain(
      "additionalProperties",
    );
    expect(JSON.stringify(request)).not.toContain("test-key");
  });

  it("provides last-week boundaries on Shanghai Monday even when UTC is still Sunday", async () => {
    const context = jarvisQueryTimeContext(NOW);
    const window = {
      since: Date.parse("2026-11-09T00:00:00+08:00"),
      until: Date.parse("2026-11-16T00:00:00+08:00"),
      field: "create" as const,
    };
    expect(context.boundaries.lastWeek).toEqual({ since: window.since, until: window.until });
    expect(context.boundaries.today.since).toBe(window.until);
    const fetchImpl = vi.fn(async () =>
      response({
        ...QUERY,
        scope: "created",
        severities: [1, 2],
        titleKeywords: ["登录"],
        timeWindow: window,
      }),
    );
    const result = await createJarvisGeminiQuery({
      readApiKey: async () => "key",
      fetchImpl,
    }).interpret("上周我提的跟登录有关的严重问题", NOW);
    expect(result).toMatchObject({
      scope: "created",
      severities: [1, 2],
      titleKeywords: ["登录"],
      projectNames: [],
      timeWindow: window,
    });
  });

  it.each([
    { ...QUERY, scope: "mine" },
    { ...QUERY, statuses: [4] },
    { ...QUERY, priorities: [0] },
    { ...QUERY, severities: [5] },
    { ...QUERY, order: "random" },
    { ...QUERY, projectNames: [" "] },
    { ...QUERY, titleKeywords: "发货" },
    { ...QUERY, extra: true },
    { ...QUERY, timeWindow: { since: null, until: null, field: "unknown" } },
  ])("rejects values outside the zod schema: %j", async (value) => {
    expect(jarvisBugQuerySchema.safeParse(value).success).toBe(false);
    const client = createJarvisGeminiQuery({
      readApiKey: async () => "key",
      fetchImpl: async () => response(value),
    });
    await expect(client.interpret("我还没处理完成的bug", NOW)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each([
    null,
    {},
    { candidates: [] },
    { candidates: [{ finishReason: "MAX_TOKENS" }] },
    { candidates: [{ finishReason: "STOP", content: null }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }] },
  ])("rejects malformed, blocked or truncated Gemini responses: %j", async (value) => {
    const client = createJarvisGeminiQuery({
      readApiKey: async () => "key",
      fetchImpl: async () => Response.json(value),
    });
    await expect(client.interpret("bug", NOW)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("keeps project names separate from title keywords", async () => {
    const client = createJarvisGeminiQuery({
      readApiKey: async () => "key",
      fetchImpl: async () =>
        response({ ...QUERY, titleKeywords: ["登录"], projectNames: ["安心买"] }),
    });
    expect(await client.interpret("安心买的标题含登录的bug", NOW)).toMatchObject({
      titleKeywords: ["登录"],
      projectNames: ["安心买"],
    });
  });

  it("reports a missing Gemini key without making an API request", async () => {
    const fetchImpl = vi.fn();
    const client = createJarvisGeminiQuery({ readApiKey: async () => null, fetchImpl });
    await expect(client.interpret("我还没处理完成的bug", NOW)).rejects.toMatchObject({
      code: "missing_key",
      provider: "gemini",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await client.test()).toEqual({ ok: false, latencyMs: null, errorCode: "missing_key" });
  });

  it.each([
    [401, "unauthorized"],
    [402, "quota_exhausted"],
    [403, "unauthorized"],
    [429, "quota_exhausted"],
    [500, "provider_failed"],
  ])("reports HTTP %i", async (status, code) => {
    const client = createJarvisGeminiQuery({
      readApiKey: async () => "key",
      fetchImpl: async () => new Response(null, { status: Number(status) }),
    });
    await expect(client.interpret("bug", NOW)).rejects.toMatchObject({ code });
  });

  it("reports fetch and JSON decoding failures", async () => {
    const network = createJarvisGeminiQuery({
      readApiKey: async () => "key",
      fetchImpl: async () => {
        throw new Error("network");
      },
    });
    await expect(network.interpret("bug", NOW)).rejects.toMatchObject({ code: "network" });
    const invalid = createJarvisGeminiQuery({
      readApiKey: async () => "key",
      fetchImpl: async () => new Response("invalid JSON"),
    });
    await expect(invalid.interpret("bug", NOW)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each(["key", "fetch", "body"])(
    "enforces a single twenty-second deadline including stalled %s",
    async (stage) => {
      vi.useFakeTimers();
      const stalled = () => new Promise<never>(() => {});
      const fetchImpl = vi.fn(async () =>
        stage === "fetch" ? stalled() : ({ ok: true, json: stalled } as unknown as Response),
      );
      const client = createJarvisGeminiQuery({
        readApiKey: () => (stage === "key" ? stalled() : Promise.resolve("key")),
        fetchImpl,
      });
      const result = client.interpret("我还没处理完成的bug", NOW);
      const assertion = expect(result).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(19_999);
      if (stage !== "key") expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels a superseded request and aborts its HTTP signal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    const client = createJarvisGeminiQuery({
      readApiKey: async () => "key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = client.interpret("旧查询", NOW, controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ code: "cancelled" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the local Gemini key and ignores a legacy parser provider selection", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "jarvis-query-parser-"));
    const configDirectory = path.join(home, ".config", "codexhost");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(path.join(configDirectory, "model-service.json"), '{"provider":"openai"}\n');
    await writeFile(path.join(configDirectory, "gemini-api-key"), "local-test-key\n");
    await writeFile(path.join(configDirectory, "openai-api-key"), "unused-openai-key\n");
    const readKey = vi.spyOn(ModelServiceSettingsStore.prototype, "readKey");
    const fetchImpl = vi.fn(async () => response());
    const service = new JarvisService({
      environment: { HOME: home },
      fetchImpl,
      isLocalHost: true,
      now: () => NOW,
    });
    expect(await service.testSettings()).toEqual({ ok: true, latencyMs: 0, errorCode: null });
    expect(readKey).toHaveBeenCalledWith("gemini");
    expect(fetchImpl).toHaveBeenCalledWith(
      JARVIS_QUERY_ENDPOINT,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-goog-api-key": "local-test-key" }),
      }),
    );
    const remote = new JarvisService({ fetchImpl, isLocalHost: false });
    expect(await remote.searchBugs({ query: "bug" })).toMatchObject({
      available: false,
      source: "model",
      errorCode: "local_only",
    });
    expect(readKey).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    readKey.mockRestore();
  });
});
