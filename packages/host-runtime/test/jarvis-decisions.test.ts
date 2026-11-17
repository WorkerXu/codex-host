import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { JarvisBug } from "@codexhost/shared-contracts";

import {
  buildBugInterpretRequest,
  buildBugOrderRequest,
  createJarvisDecisions,
  parseBugDecisionAnswers,
  parseBugOrderResponse,
  parseAgentScores,
} from "../src/jarvis-decisions.js";

const bug = (id: number, title: string, updatedAt: string): JarvisBug => ({
  id,
  projectId: 9001,
  title,
  status: 1,
  priority: 3,
  severity: 3,
  createdAt: updatedAt,
  updatedAt,
});

describe("Jarvis bug Decisions requests", () => {
  it("asks one question per unsettled field only", () => {
    const request = buildBugInterpretRequest({
      query: "我还没处理完成的bug",
      fields: ["scope", "status"],
      today: "2026-11-16",
    });
    expect(Object.keys(request.questions)).toEqual(["scope", "status"]);
    expect(request.questions.scope).toMatchObject({
      type: "choice",
      criteria: {
        assigned: "指派给我",
        created: "我创建的",
        both: "指派给我和我创建的",
      },
    });
    expect(request.input).toContain("当前日期：2026-11-16");
    expect(request.input).toContain("我还没处理完成的bug");
  });

  it("uses a noul question for a possible project mention", () => {
    const request = buildBugInterpretRequest({
      query: "示例买的bug",
      fields: ["mentionsProject"],
    });
    expect(request.questions.mentions_project).toMatchObject({ type: "noul" });
  });

  it("puts each bug in its own score question for semantic re-ordering", () => {
    const request = buildBugOrderRequest({
      query: "登录失败",
      bugs: [bug(1, "登录失败", "2026-11-15 09:00:00"), bug(2, "支付失败", "2026-11-14 09:00:00")],
    });
    expect(Object.keys(request.questions)).toEqual(["rel_0", "rel_1"]);
    expect(String(request.questions.rel_0?.instructions)).toContain("id=1");
    expect(String(request.questions.rel_1?.instructions)).toContain("id=2");
    expect(request.questions.rel_0).toMatchObject({
      type: "score",
      criteria: ["不相关", "有点相关", "高度相关"],
    });
  });
});

describe("Jarvis bug Decisions responses", () => {
  it("reads choices and the project confidence", () => {
    const answers = parseBugDecisionAnswers({
      answers: {
        scope: { choice: "created", confidence: 0.92 },
        status: { choice: "active", confidence: 0.8 },
        priority: { choice: "high", confidence: 0.7 },
        severity: { choice: "low", confidence: 0.6 },
        order: { choice: "oldest", confidence: 0.75 },
        time_window: { choice: "week", confidence: 0.7 },
        mentions_project: { noul: 0.88 },
      },
    });
    expect(answers).toEqual({
      scope: { choice: "created", confidence: 0.92 },
      status: { choice: "active", confidence: 0.8 },
      priority: { choice: "high", confidence: 0.7 },
      severity: { choice: "low", confidence: 0.6 },
      order: { choice: "oldest", confidence: 0.75 },
      timeWindow: { choice: "week", confidence: 0.7 },
      mentionsProject: 0.88,
    });
  });

  it("ignores unknown choices and malformed answers", () => {
    expect(parseBugDecisionAnswers({ answers: { scope: { choice: "epic" } } })).toEqual({});
    expect(parseBugDecisionAnswers(null)).toEqual({});
  });

  it("reads scores in question order and defaults missing answers to zero", () => {
    expect(
      parseBugOrderResponse({ answers: { rel_0: { score: 1.8 }, rel_1: { score: 0.4 } } }, 3),
    ).toEqual([0.9, 0.2, 0]);
  });

  it("applies the threshold and turns answers into search conditions", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      expect(Object.keys(body.questions).sort()).toEqual(
        [
          "mentions_project",
          "order",
          "priority",
          "scope",
          "severity",
          "status",
          "time_window",
        ].sort(),
      );
      return new Response(
        JSON.stringify({
          answers: {
            scope: { choice: "created", confidence: 0.9 },
            status: { choice: "active", confidence: 0.9 },
            priority: { choice: "high", confidence: 0.9 },
            severity: { choice: "low", confidence: 0.9 },
            order: { choice: "oldest", confidence: 0.9 },
            time_window: { choice: "week", confidence: 0.9 },
            mentions_project: { noul: 0.8 },
          },
        }),
        { status: 200 },
      );
    });
    const decisions = createJarvisDecisions({
      readApiKey: async () => "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await decisions.interpret("最近的示例买bug", [
      "scope",
      "status",
      "priority",
      "severity",
      "order",
      "time",
      "mentionsProject",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(true);
    expect(result.values).toEqual({
      scope: "created",
      statuses: [1],
      priorities: [1],
      severities: [4],
      order: "oldest",
      timeWindow: "week",
      mentionsProject: true,
    });
  });

  it("ignores low-confidence choices and keeps a low project confidence as false", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              scope: { choice: "created", confidence: 0.2 },
              mentions_project: { noul: 0.2 },
            },
          }),
          { status: 200 },
        ),
    );
    const decisions = createJarvisDecisions({
      readApiKey: async () => "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await decisions.interpret("q", ["scope", "mentionsProject"])).toEqual({
      available: true,
      values: { mentionsProject: false },
    });
  });

  it("re-orders every candidate without dropping low scores", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            answers: { rel_0: { score: 0.2 }, rel_1: { score: 1.8 } },
          }),
          { status: 200 },
        ),
    );
    const decisions = createJarvisDecisions({
      readApiKey: async () => "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await decisions.orderBugs("登录失败", [
      bug(1, "支付失败", "2026-11-15 09:00:00"),
      bug(2, "登录失败", "2026-11-14 09:00:00"),
    ]);
    expect(result.available).toBe(true);
    expect(result.bugs.map(({ id }) => id)).toEqual([2, 1]);
  });

  it("does not call the API without a key", async () => {
    const fetchImpl = vi.fn();
    const decisions = createJarvisDecisions({
      readApiKey: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(decisions.interpret("q", ["scope"])).rejects.toMatchObject({
      code: "missing_key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("DingTalk agent matching", () => {
  it("scores all descriptions in one request and fails closed for malformed scores", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(Object.keys(body.questions)).toEqual(["agent_0", "agent_1", "agent_2"]);
      expect(body.questions.agent_1.instructions).toContain("采购审批");
      return new Response(
        JSON.stringify({
          answers: { agent_0: { score: 1.7 }, agent_1: { score: 1.9 }, agent_2: { score: "1" } },
        }),
      );
    });
    const decisions = createJarvisDecisions({
      readApiKey: async () => "fake-key",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(
      await decisions.scoreCandidates("采购服务器", [
        { fileName: "a.toml", name: "技术", description: "回答技术问题" },
        { fileName: "b.toml", name: "采购", description: "采购审批" },
        { fileName: "c.toml", name: "闲聊", description: "聊天" },
      ]),
    ).toEqual({
      scores: { "a.toml": 0.85, "b.toml": 0.95, "c.toml": 0 },
      probabilities: { "a.toml": {}, "b.toml": {}, "c.toml": {} },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("requires a local Gemini key", async () => {
    const fetchImpl = vi.fn();
    const decisions = createJarvisDecisions({ readApiKey: async () => null, fetchImpl });
    await expect(
      decisions.scoreCandidates("hi", [{ fileName: "a.toml", name: "a", description: "a" }]),
    ).rejects.toMatchObject({ code: "missing_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const realReviewScore = JSON.parse(
  readFileSync(new URL("./fixtures/dingtalk-decisions-review-score.json", import.meta.url), "utf8"),
);
it("accepts probabilities keyed by criterion text", () => {
  const parsed = parseAgentScores(
    { answers: { agent_0: { score: 2, probabilities: { 高度相关: 0.9 } } } },
    [{ fileName: "a.toml" }],
  );
  expect(parsed.scores["a.toml"]).toBe(1);
  expect(parsed.probabilities["a.toml"]).toEqual({ 高度相关: 0.9 });
});

it("normalizes the reported MR-review answer by the number of criterion intervals", () => {
  const parsed = parseAgentScores(realReviewScore, [{ fileName: "问源代问.toml" }]);
  expect(parsed.scores["问源代问.toml"]).toBeCloseTo(0.517);
  expect(parsed.scores["问源代问.toml"]).toBeLessThan(0.85);
  // Real Decisions answers key probabilities by criterion index and name them in `legend`.
  const distribution = parsed.probabilities["问源代问.toml"] ?? {};
  expect(Object.keys(distribution).sort()).toEqual(["不相关", "有点相关", "高度相关"].sort());
  expect(distribution["不相关"]).toBeCloseTo(0.288, 3);
  expect(distribution["有点相关"]).toBeCloseTo(0.39, 2);
  expect(distribution["高度相关"]).toBeCloseTo(0.322, 3);
});

it.each([
  [0, 0],
  [1, 0.5],
  [2, 1],
  [Number.NaN, 0],
  [Number.POSITIVE_INFINITY, 0],
  ["1.034", 0],
])("normalizes score %s and keeps malformed scores closed", (raw, expected) => {
  expect(
    parseAgentScores({ answers: { agent_0: { score: raw } } }, [{ fileName: "a" }]).scores.a,
  ).toBe(expected);
});

it("keeps valid scores above one distinct when sorting Jarvis bugs", async () => {
  const decisions = createJarvisDecisions({
    readApiKey: async () => "fake-key",
    fetchImpl: async () =>
      Response.json({
        answers: {
          rel_0: realReviewScore.answers.agent_0,
          rel_1: { score: 1.8 },
          rel_2: { score: 0.9 },
        },
      }),
  });
  const bugs = [
    bug(1, "登录异常", "2026-11-15"),
    bug(2, "登录失败", "2026-11-14"),
    bug(3, "登录超时", "2026-11-13"),
  ];
  const order = parseBugOrderResponse(
    { answers: { rel_0: realReviewScore.answers.agent_0, rel_1: { score: 1.8 } } },
    2,
  );
  expect(order[0]).toBeCloseTo(0.517, 3);
  expect(order[1]).toBeCloseTo(0.9, 6);
  expect((await decisions.orderBugs("登录失败", bugs)).bugs.map((bug) => bug.id)).toEqual([
    2, 1, 3,
  ]);
});
