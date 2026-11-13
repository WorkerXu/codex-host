import { describe, expect, it, vi } from "vitest";

import type { JarvisCandidate } from "@codexhost/shared-contracts";

import {
  buildClassifyRequest,
  buildRankRequest,
  createJarvisDecisions,
  parseClassifyAnswers,
  parseRankResponse,
} from "../src/jarvis-decisions.js";

const candidate = (id: number, title: string): JarvisCandidate => ({
  kind: "bug",
  id,
  projectId: 4029,
  title,
  status: 1,
  creatorId: 10473,
  assigneeId: 10058,
  createdAt: "2026-10-27 09:48:52",
});

describe("Jarvis Decisions requests", () => {
  it("builds the documented classify question shape", () => {
    expect(buildClassifyRequest("测试新提给我的bug")).toEqual({
      model: "gemini-decision-1",
      input: "测试新提给我的bug",
      questions: {
        is_jarvis: {
          type: "noul",
          instructions: expect.stringContaining("Jarvis"),
        },
        kind: {
          type: "choice",
          instructions: expect.stringContaining("类型"),
          criteria: {
            project: "项目",
            requirement: "需求",
            task: "任务",
            bug: "Bug",
            none: "不是 Jarvis 条目",
          },
        },
      },
    });
  });

  it("puts candidate context in the input and one score question per candidate", () => {
    const request = buildRankRequest({
      query: "测试新提给我的bug",
      kind: "bug",
      candidates: [candidate(928, "填写已查码的序列号"), candidate(936, "查码日志缺少序列号")],
      user: { id: 10058, name: "许涛" },
      today: "2026-11-13",
    });
    expect(Object.keys(request.questions)).toEqual(["rel_0", "rel_1"]);
    expect(request.questions.rel_0).toMatchObject({
      type: "score",
      criteria: ["不相关", "有点相关", "高度相关"],
    });
    expect(String(request.questions.rel_0?.instructions)).toContain("id=928");
    expect(String(request.questions.rel_1?.instructions)).toContain("id=936");
    expect(request.input).toContain("当前日期：2026-11-13");
    expect(request.input).toContain("当前用户：许涛 (ID 10058)");
    expect(request.input).toContain("id=928");
    expect(request.input).toContain("创建人ID=10473");
    expect(request.input).toContain("指派给ID=10058");
  });

  it("caps candidates at the documented rank limit", () => {
    const candidates = Array.from({ length: 250 }, (_unused, index) =>
      candidate(index + 1, `bug ${index}`),
    );
    const request = buildRankRequest({
      query: "q",
      kind: "bug",
      candidates,
      user: null,
      today: "2026-11-13",
    });
    expect(Object.keys(request.questions)).toHaveLength(200);
    expect(request.input).not.toContain("id=201");
  });
});

describe("Jarvis Decisions responses", () => {
  it("reads noul, choice and confidence", () => {
    const answers = parseClassifyAnswers({
      answers: {
        is_jarvis: { type: "noul", noul: 0.72, confidence: 0.72 },
        kind: {
          type: "choice",
          choice: "bug",
          confidence: 0.94,
          probabilities: { bug: 0.94 },
        },
      },
    });
    expect(answers).toEqual({ noul: 0.72, kind: "bug", confidence: 0.94 });
  });

  it("falls back to none for an unknown choice or malformed response", () => {
    expect(parseClassifyAnswers({ answers: { kind: { choice: "epic" } } })).toEqual({
      noul: 0,
      kind: "none",
      confidence: 0,
    });
    expect(parseClassifyAnswers(null)).toEqual({ noul: 0, kind: "none", confidence: 0 });
  });

  it("reads scores in question order and defaults missing answers to zero", () => {
    expect(
      parseRankResponse(
        {
          answers: {
            rel_0: { type: "score", score: 1.8 },
            rel_1: { type: "score", score: 0.4 },
          },
        },
        3,
      ),
    ).toEqual([1.8, 0.4, 0]);
  });

  it("applies the configured threshold and returns ranked suggestions", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((key, index) => [
          key,
          { type: "score", score: index === 0 ? 1.7 : 0.8 },
        ]),
      );
      return new Response(JSON.stringify({ answers }), { status: 200 });
    });
    const decisions = createJarvisDecisions({
      readApiKey: async () => "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await decisions.rank(
      "测试新提给我的bug",
      "bug",
      [candidate(928, "填写已查码的序列号"), candidate(936, "查码日志缺少序列号")],
      { id: 10058, name: "许涛" },
    );
    expect(result.available).toBe(true);
    expect(result.suggestions.map(({ id }) => id)).toEqual([928]);
    expect(result.suggestions[0]?.score).toBe(1.7);
  });

  it("reports missing keys instead of calling the API", async () => {
    const fetchImpl = vi.fn();
    const decisions = createJarvisDecisions({
      readApiKey: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(decisions.classify("x")).rejects.toMatchObject({ code: "missing_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
