import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDingTalkDispatchMatcher } from "../src/dingtalk-dispatch-matcher.js";
import { buildAgentScoreRequest } from "../src/jarvis-decisions.js";
import { ModelServiceSettingsStore } from "../src/model-service-settings.js";

const directories: string[] = [];
const CANDIDATES = [
  { fileName: "qa.toml", name: "技术问答", description: "查询知识库" },
  { fileName: "review.toml", name: "代码评审", description: "评审代码变更" },
];
const response = () =>
  Response.json({ answers: { agent_0: { score: 0.95 }, agent_1: { score: 0.2 } } });
async function settings() {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "dispatch-decisions-test-"));
  directories.push(configDirectory);
  return new ModelServiceSettingsStore({ configDirectory });
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DingTalk Gemini Decisions matching", () => {
  it("scores every candidate in one Gemini Decisions request", async () => {
    const store = await settings();
    await store.update({ key: { provider: "gemini", value: "fake-gemini-key" } });
    const fetchImpl = vi.fn(async () => response());
    const matcher = createDingTalkDispatchMatcher({ settings: store, fetchImpl });
    expect(await matcher.scoreDingTalkCandidates("请查知识库", CANDIDATES)).toEqual({
      available: true,
      errorCode: null,
      scores: { "qa.toml": 0.95, "review.toml": 0.2 },
      probabilities: { "qa.toml": {}, "review.toml": {} },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const [endpoint, init] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(endpoint).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
      expect(init.headers).toEqual({
        "content-type": "application/json",
        "x-goog-api-key": "fake-gemini-key",
      });
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("gemini-decision-1");
      expect(body).toEqual(buildAgentScoreRequest({ text: "请查知识库", candidates: CANDIDATES }));
      expect(JSON.stringify(body)).not.toContain("fake-gemini-key");
    }
  });

  it("reads Gemini key updates from General settings on each request", async () => {
    const store = await settings();
    const fetchImpl = vi.fn(async () => response());
    const matcher = createDingTalkDispatchMatcher({ settings: store, fetchImpl });
    expect(await matcher.scoreDingTalkCandidates("消息", CANDIDATES)).toEqual({
      available: false,
      scores: {},
      errorCode: "missing_key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await store.update({ key: { provider: "gemini", value: "fake-gemini-key" } });
    expect((await matcher.scoreDingTalkCandidates("消息", CANDIDATES)).available).toBe(true);
    await store.update({ key: { provider: "gemini", value: "fake-updated-gemini-key" } });
    expect((await matcher.scoreDingTalkCandidates("消息", CANDIDATES)).available).toBe(true);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[1]?.[1].headers).toMatchObject({ "x-goog-api-key": "fake-updated-gemini-key" });
    await store.update({ key: { provider: "gemini", value: null } });
    expect((await matcher.scoreDingTalkCandidates("消息", CANDIDATES)).errorCode).toBe(
      "missing_key",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "unauthorized"],
    [429, "http_429"],
    [500, "http_500"],
  ])(
    "preserves HTTP %i error handling without retries or another provider",
    async (status, errorCode) => {
      const store = await settings();
      await store.update({ key: { provider: "gemini", value: "fake-gemini-key" } });
      const fetchImpl = vi.fn(async () =>
        Response.json({ error: { message: "raw English failure" } }, { status: Number(status) }),
      );
      const result = await createDingTalkDispatchMatcher({
        settings: store,
        fetchImpl,
      }).scoreDingTalkCandidates("消息", CANDIDATES);
      expect(result).toEqual({ available: false, scores: {}, errorCode });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("raw English");
    },
  );

  it("preserves the Decisions timeout with no retry or parser fallback", async () => {
    const store = await settings();
    await store.update({ key: { provider: "gemini", value: "fake-gemini-key" } });
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const matcher = createDingTalkDispatchMatcher({ settings: store, fetchImpl });
    const result = matcher.scoreDingTalkCandidates("消息", CANDIDATES);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(8000);
    expect(await result).toEqual({ available: false, scores: {}, errorCode: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
