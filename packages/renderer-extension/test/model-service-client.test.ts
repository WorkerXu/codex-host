import { describe, expect, it, vi } from "vitest";
import {
  createRendererModelServiceClient,
  modelServiceErrorText,
} from "../src/model-service-client.js";
import {
  MODEL_SERVICE_GET_METHOD,
  MODEL_SERVICE_SET_METHOD,
  MODEL_SERVICE_TEST_METHOD,
} from "@codexhost/shared-contracts";

describe("shared renderer model service", () => {
  it("uses the supplied local route and validates snapshots", async () => {
    const snapshot = {
      provider: "openai",
      openai: { configured: true, lastFour: "1234" },
      gemini: { configured: false, lastFour: null },
    };
    const sendRequest = vi.fn(async (method: string) =>
      method === MODEL_SERVICE_TEST_METHOD
        ? { ok: true, latencyMs: 123, errorCode: null }
        : snapshot,
    );
    const client = createRendererModelServiceClient(() => ({ sendRequest }));
    expect(await client.read()).toEqual(snapshot);
    expect(await client.update({ provider: "gemini" })).toEqual(snapshot);
    expect(await client.test("gemini")).toEqual({ ok: true, latencyMs: 123, errorCode: null });
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      MODEL_SERVICE_GET_METHOD,
      MODEL_SERVICE_SET_METHOD,
      MODEL_SERVICE_TEST_METHOD,
    ]);
    sendRequest.mockResolvedValueOnce({
      ...snapshot,
      openai: { configured: true, lastFour: "1234", key: "secret" },
    } as never);
    await expect(client.read()).rejects.toThrow();
  });
  it("fails when the local route is unavailable", async () => {
    await expect(createRendererModelServiceClient(() => null).read()).rejects.toThrow("local_only");
  });
  it.each([
    ["missing_key", "未配置 OpenAI Key"],
    ["quota_exhausted", "OpenAI 额度不足"],
    ["unauthorized", "OpenAI Key 无效"],
    ["timeout", "解析超时"],
    ["network", "网络连接失败"],
    ["prepayment credits are depleted", "无法连接本地模型服务"],
  ])("maps %s to controlled Chinese copy", (code, expected) => {
    expect(modelServiceErrorText(code)).toBe(expected);
  });
  it("names an explicitly selected Gemini provider", () => {
    expect(modelServiceErrorText("quota_exhausted", "gemini")).toBe("Gemini 额度不足");
    expect(modelServiceErrorText("unauthorized", "gemini")).toBe("Gemini Key 无效");
  });
});
