import { describe, expect, it } from "vitest";

import {
  jarvisProjectPhrases,
  jarvisScopeLabel,
  parseJarvisBugRules,
} from "../src/jarvis-bug-query.js";

const NOW = Date.parse("2026-11-16T10:00:00+08:00");
const DAY = 86_400_000;

describe("Jarvis bug rule parser", () => {
  it("parses the assigned, unresolved example without a model", () => {
    const parsed = parseJarvisBugRules("我还没处理完成的bug", NOW);
    expect(parsed).toMatchObject({
      scope: "assigned",
      statuses: [1],
      priorities: null,
      severities: null,
      order: "newest",
      orderExplicit: false,
      timeLabel: null,
      leftover: "",
      unresolved: { scope: false, status: false },
    });
  });

  it("keeps the project phrase and the explicit recency order", () => {
    const parsed = parseJarvisBugRules("示例买的最近的bug", NOW);
    expect(parsed).toMatchObject({
      scope: "assigned",
      statuses: null,
      order: "newest",
      orderExplicit: true,
      leftover: "示例买",
    });
    expect(parsed.unresolved.scope).toBe(true);
    expect(parsed.unresolved.status).toBe(true);
  });

  it("combines created scope, severity and a relative time window", () => {
    const parsed = parseJarvisBugRules("我提的示例买最近3天严重的bug", NOW);
    expect(parsed).toMatchObject({
      scope: "created",
      severities: [1, 2],
      timeLabel: "最近 3 天",
      leftover: "示例买",
    });
    expect(parsed.since).toBe(NOW - 3 * DAY);
    expect(parsed.unresolved.scope).toBe(false);
    expect(parsed.unresolved.time).toBe(false);
  });

  it("unions several status and priority words", () => {
    const parsed = parseJarvisBugRules("已解决和已关闭的高优先级bug", NOW);
    expect(parsed.statuses).toEqual([2, 3]);
    expect(parsed.priorities).toEqual([1]);
    expect(parsed.leftover).toBe("");
  });

  it("treats 'all statuses' as no status filter", () => {
    const parsed = parseJarvisBugRules("所有状态的bug", NOW);
    expect(parsed.statuses).toBeNull();
    expect(parsed.unresolved.status).toBe(false);
  });

  it("filters the create time for 'last week created'", () => {
    const parsed = parseJarvisBugRules("上周创建的bug", NOW);
    expect(parsed.timeLabel).toBe("上周");
    expect(parsed.timeField).toBe("create");
    expect(parsed.leftover).toBe("");
    expect(parsed.until).not.toBeNull();
  });

  it("reads the sort field from 'recently updated' and 'recently created'", () => {
    const updated = parseJarvisBugRules("最近更新的bug", NOW);
    expect(updated.timeField).toBe("update");
    expect(updated.leftover).toBe("");
    const created = parseJarvisBugRules("最近创建的bug", NOW);
    expect(created.timeField).toBe("create");
    expect(created.leftover).toBe("");
  });

  it("uses create time for the oldest order", () => {
    const parsed = parseJarvisBugRules("最旧的bug", NOW);
    expect(parsed.order).toBe("oldest");
    expect(parsed.timeField).toBe("create");
  });

  it("strips stacked request words but keeps the project phrase", () => {
    expect(parseJarvisBugRules("帮我查一下示例买支付的问题", NOW).leftover).toBe("示例买支付");
    expect(jarvisProjectPhrases("示例买支付 支付")).toEqual(["示例买支付", "支付"]);
  });

  it("marks created and assigned together as both", () => {
    expect(parseJarvisBugRules("我创建的指派给我的bug", NOW).scope).toBe("both");
    expect(jarvisScopeLabel("both")).toBe("指派或创建");
  });

  it("does not strip the word 'debug' as a generic bug noun", () => {
    expect(parseJarvisBugRules("debug 的bug", NOW).leftover).toBe("debug");
  });

  it("computes today and yesterday boundaries", () => {
    const today = parseJarvisBugRules("今天的bug", NOW);
    const start = new Date(NOW);
    start.setHours(0, 0, 0, 0);
    expect(today.since).toBe(start.getTime());

    const yesterday = parseJarvisBugRules("昨天的bug", NOW);
    expect(yesterday.since).toBe(start.getTime() - DAY);
    expect(yesterday.until).toBe(start.getTime());
  });

  it("parses relative day counts and priorities", () => {
    const parsed = parseJarvisBugRules("最近10天高优先级轻微的bug", NOW);
    expect(parsed.timeLabel).toBe("最近 10 天");
    expect(parsed.since).toBe(NOW - 10 * DAY);
    expect(parsed.priorities).toEqual([1]);
    expect(parsed.severities).toEqual([4]);
  });

  it("keeps defaults for an empty query", () => {
    expect(parseJarvisBugRules("", NOW)).toMatchObject({
      scope: "assigned",
      statuses: null,
      order: "newest",
      leftover: "",
    });
  });
});
