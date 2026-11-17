import { afterEach, describe, expect, it, vi } from "vitest";

import { jarvisBugQuerySchema, type JarvisBugQuery } from "@codexhost/shared-contracts";

import {
  buildJarvisQueryRequest,
  createJarvisGeminiQuery,
  jarvisQueryTimeContext,
  JARVIS_QUERY_ENDPOINT,
  JARVIS_QUERY_MODEL,
} from "../src/jarvis-gemini-query.js";
import { JarvisService } from "../src/jarvis-service.js";
import { JarvisSettingsStore } from "../src/jarvis-settings.js";

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

function response(value: unknown = QUERY): Response {
  return Response.json({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
  });
}

afterEach(() => vi.useRealTimers());

describe("Jarvis Gemini structured query", () => {
  it("posts the whole query to Flash-Lite generateContent with JSON responseSchema", async () => {
    const fetchImpl = vi.fn(async () => response());
    const client = createJarvisGeminiQuery({ readApiKey: async () => "test-key", fetchImpl });
    expect(await client.interpret("我还没处理的标题有发货的", NOW)).toEqual(QUERY);
    expect(JARVIS_QUERY_MODEL).toBe("gemini-3.5-flash-lite");
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      JARVIS_QUERY_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": "test-key" },
        body: JSON.stringify(buildJarvisQueryRequest("我还没处理的标题有发货的", NOW)),
      }),
    );
    const request = buildJarvisQueryRequest("我还没处理的标题有发货的", NOW);
    expect(request.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        required: [
          "scope",
          "statuses",
          "priorities",
          "severities",
          "order",
          "timeWindow",
          "titleKeywords",
          "projectNames",
          "unrecognized",
        ],
      },
    });
    expect(JSON.parse(request.contents[0]?.parts[0]?.text ?? "{}")).toMatchObject({
      query: "我还没处理的标题有发货的",
      nowMs: NOW,
      now: new Date(NOW).toISOString(),
      timeZone: "Asia/Shanghai",
      date: "2026-11-16",
    });
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
    { ...QUERY, timeWindow: { since: 100, until: 50, field: "create" } },
    { ...QUERY, timeWindow: { since: null, until: null, field: "create" } },
    { ...QUERY, timeWindow: { since: 100, until: null, field: "invalid" } },
    { ...QUERY, timeWindow: { since: 100, until: null, field: "update", extra: true } },
    { ...QUERY, unrecognized: 3 },
    { scope: "assigned" },
    null,
  ])("rejects invalid conditions without accepting partial fields: %j", async (value) => {
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
    { candidates: [{ finishReason: "MAX_TOKENS" }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [null] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] },
  ])("rejects malformed, blocked or truncated API responses: %j", async (value) => {
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

  it("reports missing key without making an API request", async () => {
    const fetchImpl = vi.fn();
    const client = createJarvisGeminiQuery({ readApiKey: async () => null, fetchImpl });
    await expect(client.interpret("我还没处理完成的bug", NOW)).rejects.toMatchObject({
      code: "missing_key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await client.test()).toEqual({ ok: false, latencyMs: null, errorCode: "missing_key" });
  });

  it.each([
    [401, "unauthorized"],
    [402, "quota_exhausted"],
    [403, "unauthorized"],
    [429, "gemini_failed"],
    [500, "gemini_failed"],
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
    "enforces a single three-second deadline including stalled %s",
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
      await vi.advanceTimersByTimeAsync(2_999);
      if (stage !== "key") expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses the existing local settings key and avoids reading it on a remote Host", async () => {
    const settings = new JarvisSettingsStore({ configDirectory: "/unused-jarvis-test-directory" });
    const readKey = vi.spyOn(settings, "readKey").mockResolvedValue("local-test-key");
    const fetchImpl = vi.fn(async () => response());
    const service = new JarvisService({ settings, fetchImpl, isLocalHost: true, now: () => NOW });
    expect(await service.testSettings()).toEqual({ ok: true, latencyMs: 0, errorCode: null });
    expect(readKey).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      JARVIS_QUERY_ENDPOINT,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-goog-api-key": "local-test-key" }),
      }),
    );
    const remote = new JarvisService({ settings, fetchImpl, isLocalHost: false });
    expect(await remote.searchBugs({ query: "bug" })).toMatchObject({
      available: false,
      source: "gemini",
      errorCode: "local_only",
    });
    expect(readKey).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
