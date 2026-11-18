import { afterEach, describe, expect, it, vi } from "vitest";

import type { JarvisBugQuery } from "@codexhost/shared-contracts";

import { JarvisBugSearcher, type JarvisBugSearchCli } from "../src/jarvis-bug-search.js";
import { createJarvisProviderQuery, JarvisQueryError } from "../src/jarvis-query-parser.js";
import type { JarvisBugListOptions, JarvisProjectRow } from "../src/jarvis-cli.js";

const NOW = Date.parse("2026-11-16T10:00:00+08:00");
afterEach(() => vi.useRealTimers());

interface FakeBug {
  id: number;
  projectId: number;
  bugTitle: string;
  status: number;
  priority: number;
  severity: number;
  assigned: boolean;
  created: boolean;
  createTime: string;
  updateTime: string;
}

const KNOWN: JarvisProjectRow[] = [
  { id: 9002, name: "示例商城 · 迭代 A" },
  { id: 9001, name: "示例后台 · 迭代 B" },
];
const VISIBLE: JarvisProjectRow[] = [
  { id: 9003, name: "安心买 · 消息通知" },
  { id: 9004, name: "安心买 · 标记迭代" },
];

function bug(overrides: Partial<FakeBug> & Pick<FakeBug, "id" | "projectId">): FakeBug {
  return {
    bugTitle: `Bug ${overrides.id}`,
    status: 1,
    priority: 3,
    severity: 3,
    assigned: true,
    created: false,
    createTime: "2026-11-10 09:00:00",
    updateTime: "2026-11-10 09:00:00",
    ...overrides,
  };
}

function fakeCli(rows: FakeBug[], options: { fail?: boolean } = {}): JarvisBugSearchCli {
  return {
    user: vi.fn(async () => ({ id: 10058, name: "测试" })),
    projects: vi.fn(async () => KNOWN),
    searchProjects: vi.fn(async (name: string) =>
      VISIBLE.filter((project) => project.name.includes(name)),
    ),
    bugs: vi.fn(async (projectId: number, params: JarvisBugListOptions = {}) => {
      if (options.fail) throw new Error("cli failed");
      let filtered = rows.filter(
        (row) => row.projectId === projectId && (params.createdByMe ? row.created : row.assigned),
      );
      if (params.statuses)
        filtered = filtered.filter((row) => params.statuses?.includes(row.status));
      if (params.priorities)
        filtered = filtered.filter((row) => params.priorities?.includes(row.priority));
      if (params.title)
        filtered = filtered.filter((row) => row.bugTitle.includes(params.title ?? ""));
      const page = params.page ?? 1;
      const pageSize = params.pageSize ?? 100;
      const list = filtered.slice((page - 1) * pageSize, page * pageSize).map((row) => ({
        id: row.id,
        projectId: row.projectId,
        bugTitle: row.bugTitle,
        status: row.status,
        priority: row.priority,
        severity: row.severity,
        creatorId: row.created ? 10058 : 10473,
        assigneeId: row.assigned ? 10058 : 10474,
        createTime: row.createTime,
        updateTime: row.updateTime,
      }));
      return { list, total: filtered.length, page, pageSize };
    }),
  };
}

function searcher(cli: JarvisBugSearchCli, values: Partial<JarvisBugQuery> = {}) {
  const interpret = vi.fn(async (): Promise<JarvisBugQuery> => ({
    scope: "assigned",
    statuses: [],
    priorities: [],
    severities: [],
    order: "newest",
    timeWindow: null,
    titleKeywords: [],
    projectNames: [],
    unrecognized: null,
    ...values,
  }));
  const api = new JarvisBugSearcher({
    cli,
    interpreter: { interpret },
    isLocalHost: true,
    now: () => NOW,
    concurrency: 2,
  });
  return { api, interpret };
}

describe("Jarvis structured bug search", () => {
  it.each([
    [402, "quota_exhausted"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [500, "provider_failed"],
  ])("returns an error without querying Jarvis after HTTP %i", async (status, code) => {
    const cli = fakeCli([bug({ id: 80, projectId: 9002, bugTitle: "发货失败" })]);
    const interpreter = createJarvisProviderQuery({
      provider: "gemini",
      readApiKey: async () => "test-key",
      fetchImpl: async () =>
        Response.json(
          { error: { message: "prepayment credits are depleted" } },
          { status: Number(status) },
        ),
    });
    const result = await new JarvisBugSearcher({ cli, interpreter, isLocalHost: true }).search({
      query: "我还没处理的标题有发货的",
    });
    expect(result).toEqual({
      available: false,
      source: "gemini",
      errorCode: code,
      conditions: [],
      bugs: [],
      total: 0,
      capped: false,
    });
    expect(cli.user).not.toHaveBeenCalled();
    expect(cli.projects).not.toHaveBeenCalled();
    expect(cli.searchProjects).not.toHaveBeenCalled();
    expect(cli.bugs).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("prepayment");
  });

  it.each(["missing_key", "invalid_response", "timeout", "network"])(
    "returns %s without CLI queries",
    async (code) => {
      vi.useFakeTimers();
      const cli = fakeCli([]);
      const fetchImpl = vi.fn(async () => {
        if (code === "timeout") return new Promise<Response>(() => {});
        if (code === "network") throw new Error("raw network failure");
        return Response.json({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
        });
      });
      const interpreter = createJarvisProviderQuery({
        provider: "gemini",
        readApiKey: async () => (code === "missing_key" ? null : "key"),
        fetchImpl,
      });
      const pending = new JarvisBugSearcher({ cli, interpreter, isLocalHost: true }).search({
        query: "我还没处理完成的bug",
      });
      if (code === "timeout") {
        await vi.advanceTimersByTimeAsync(19_999);
        expect(cli.bugs).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await pending).toEqual({
        available: false,
        source: "gemini",
        errorCode: code,
        conditions: [],
        bugs: [],
        total: 0,
        capped: false,
      });
      if (code === "missing_key") expect(fetchImpl).not.toHaveBeenCalled();
      expect(cli.user).not.toHaveBeenCalled();
      expect(cli.projects).not.toHaveBeenCalled();
      expect(cli.searchProjects).not.toHaveBeenCalled();
      expect(cli.bugs).not.toHaveBeenCalled();
    },
  );

  it("sends the full real query to Gemini and searches only its title keyword", async () => {
    const cli = fakeCli([
      bug({ id: 101, projectId: 9002, bugTitle: "发货失败" }),
      bug({ id: 102, projectId: 9001, bugTitle: "无法发货" }),
      bug({ id: 103, projectId: 9002, bugTitle: "发货失败", status: 2 }),
      bug({ id: 104, projectId: 9001, bugTitle: "支付失败" }),
      bug({ id: 105, projectId: 9001, bugTitle: "发货失败", assigned: false, created: true }),
    ]);
    const { api, interpret } = searcher(cli, { statuses: [1], titleKeywords: ["发货"] });
    const result = await api.search({ query: "我还没处理的标题有发货的" });
    expect(interpret).toHaveBeenCalledExactlyOnceWith("我还没处理的标题有发货的", NOW, undefined);
    expect(cli.searchProjects).not.toHaveBeenCalled();
    expect(cli.bugs).toHaveBeenCalledTimes(2);
    expect(cli.bugs).toHaveBeenCalledWith(
      9002,
      expect.objectContaining({ createdByMe: false, statuses: [1], title: "发货" }),
    );
    expect(result.bugs.map(({ id }) => id).sort()).toEqual([101, 102]);
    expect(result.source).toBe("model");
    expect(result.conditions).toEqual([
      { key: "scope:assigned", kind: "scope", label: "指派给我" },
      { key: "status:1", kind: "status", label: "未解决" },
      { key: "order:newest", kind: "order", label: "最新" },
      { key: "title", kind: "title", label: "标题含「发货」" },
    ]);
  });

  it("keeps the assigned unresolved example", async () => {
    const cli = fakeCli([
      bug({ id: 1, projectId: 9002 }),
      bug({ id: 2, projectId: 9001, status: 2 }),
    ]);
    const result = await searcher(cli, { statuses: [1] }).api.search({
      query: "我还没处理完成的bug",
    });
    expect(result.bugs.map(({ id }) => id)).toEqual([1]);
    expect(cli.searchProjects).not.toHaveBeenCalled();
  });

  it("resolves only the named project for the recent example", async () => {
    const cli = fakeCli([
      bug({ id: 10, projectId: 9003, updateTime: "2026-11-14 09:00:00" }),
      bug({ id: 11, projectId: 9004, updateTime: "2026-11-16 09:00:00" }),
    ]);
    const result = await searcher(cli, { projectNames: ["安心买"] }).api.search({
      query: "安心买的最近的bug",
    });
    expect(cli.searchProjects).toHaveBeenCalledExactlyOnceWith("安心买");
    expect(result.bugs.map(({ id }) => id)).toEqual([11, 10]);
    expect(result.conditions).toContainEqual({
      key: "project:安心买",
      kind: "project",
      label: "安心买 ×2 个项目",
    });
    expect(result.conditions.some(({ kind }) => kind === "time" || kind === "title")).toBe(false);
  });

  it("keeps the project and title separate when either chip is removed", async () => {
    const cli = fakeCli([
      bug({ id: 20, projectId: 9003, bugTitle: "登录失败" }),
      bug({ id: 21, projectId: 9003, bugTitle: "支付失败" }),
      bug({ id: 22, projectId: 9002, bugTitle: "登录失败" }),
    ]);
    const { api } = searcher(cli, { projectNames: ["安心买"], titleKeywords: ["登录"] });
    const query = "安心买的标题含登录的bug";
    expect((await api.search({ query })).bugs.map(({ id }) => id)).toEqual([20]);
    expect(cli.searchProjects).toHaveBeenCalledExactlyOnceWith("安心买");
    expect((await api.search({ query, omit: ["title"] })).bugs.map(({ id }) => id).sort()).toEqual([
      20, 21,
    ]);
    const omitted = await api.search({ query, omit: ["project:安心买"] });
    expect(omitted.bugs.map(({ id }) => id)).toEqual([22]);
    expect(omitted.conditions.some(({ kind }) => kind === "project")).toBe(false);
    expect(omitted.conditions).toContainEqual({
      key: "title",
      kind: "title",
      label: "标题含「登录」",
    });
  });

  it("queries multiple title keywords separately and de-duplicates overlapping scopes and keywords", async () => {
    const cli = fakeCli([
      bug({ id: 30, projectId: 9002, bugTitle: "登录支付失败", created: true }),
      bug({ id: 31, projectId: 9001, bugTitle: "登录失败", assigned: false, created: true }),
      bug({ id: 32, projectId: 9002, bugTitle: "支付失败" }),
    ]);
    const result = await searcher(cli, {
      scope: "both",
      titleKeywords: ["登录", "支付", "登录"],
    }).api.search({ query: "我相关的登录或支付bug" });
    expect(result.bugs.map(({ id }) => id).sort()).toEqual([30, 31, 32]);
    expect(result.total).toBe(3);
    expect(cli.bugs).toHaveBeenCalledTimes(8);
    expect(cli.bugs).toHaveBeenCalledWith(9002, expect.objectContaining({ title: "登录" }));
    expect(cli.bugs).toHaveBeenCalledWith(9002, expect.objectContaining({ title: "支付" }));
    expect(cli.bugs).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "登录 支付" }),
    );
    expect(cli.searchProjects).not.toHaveBeenCalled();
  });

  it("applies the model's Shanghai last-week create window and severity", async () => {
    const cli = fakeCli([
      bug({
        id: 40,
        projectId: 9002,
        bugTitle: "登录失败",
        created: true,
        severity: 2,
        createTime: "2026-11-09 00:00:00",
      }),
      bug({
        id: 41,
        projectId: 9002,
        bugTitle: "登录失败",
        created: true,
        severity: 2,
        createTime: "2026-11-08 23:59:59",
      }),
      bug({
        id: 42,
        projectId: 9002,
        bugTitle: "登录失败",
        created: true,
        severity: 2,
        createTime: "2026-11-16 00:00:00",
      }),
      bug({
        id: 43,
        projectId: 9002,
        bugTitle: "登录失败",
        created: true,
        severity: 3,
        createTime: "2026-11-10 00:00:00",
      }),
    ]);
    const result = await searcher(cli, {
      scope: "created",
      severities: [1, 2],
      titleKeywords: ["登录"],
      timeWindow: {
        since: Date.parse("2026-11-09T00:00:00+08:00"),
        until: Date.parse("2026-11-16T00:00:00+08:00"),
        field: "create",
      },
    }).api.search({ query: "上周我提的跟登录有关的严重问题" });
    expect(result.bugs.map(({ id }) => id)).toEqual([40]);
    expect(result.conditions.find(({ kind }) => kind === "time")?.label).toContain("11/09");
    expect(cli.bugs).toHaveBeenCalledWith(
      9002,
      expect.objectContaining({ createdByMe: true, title: "登录" }),
    );
  });

  it("enforces an until-only window", async () => {
    const cli = fakeCli([
      bug({ id: 44, projectId: 9002, updateTime: "2026-11-15 23:59:59" }),
      bug({ id: 45, projectId: 9002, updateTime: "2026-11-16 00:00:00" }),
    ]);
    const result = await searcher(cli, {
      timeWindow: { since: null, until: Date.parse("2026-11-16T00:00:00+08:00"), field: "update" },
    }).api.search({ query: "今天以前的bug" });
    expect(result.bugs.map(({ id }) => id)).toEqual([44]);
  });

  it("retains an unmatched named project without broadening to all projects or turning it into a title", async () => {
    const cli = fakeCli([bug({ id: 50, projectId: 9002 })]);
    const result = await searcher(cli, {
      projectNames: ["不存在的项目"],
      titleKeywords: ["登录"],
    }).api.search({ query: "不存在的项目的登录bug" });
    expect(cli.searchProjects).toHaveBeenCalledExactlyOnceWith("不存在的项目");
    expect(cli.bugs).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
    expect(result.conditions).toContainEqual({
      key: "project:不存在的项目",
      kind: "project",
      label: "不存在的项目",
    });
    expect(result.conditions).toContainEqual({
      key: "title",
      kind: "title",
      label: "标题含「登录」",
    });
  });

  it("accepts all iterations of a project explicitly named by the model", async () => {
    const cli = fakeCli([]);
    vi.mocked(cli.searchProjects).mockResolvedValue(
      Array.from({ length: 4 }, (_, index) => ({ id: 9100 + index, name: `安心买迭代${index}` })),
    );
    const result = await searcher(cli, { projectNames: ["安心买"] }).api.search({
      query: "安心买bug",
    });
    expect(result.conditions).toContainEqual({
      key: "project:安心买",
      kind: "project",
      label: "安心买 ×4 个项目",
    });
    expect(cli.bugs).toHaveBeenCalledTimes(4);
  });

  it("caches project lookups and de-duplicates repeated project names", async () => {
    const cli = fakeCli([]);
    const { api } = searcher(cli, { projectNames: ["安心买", "安心买"] });
    await api.search({ query: "安心买bug" });
    await api.search({ query: "安心买的bug" });
    expect(cli.searchProjects).toHaveBeenCalledTimes(1);
  });

  it("pages through results and reports the documented cap", async () => {
    const cli = fakeCli(
      Array.from({ length: 250 }, (_, index) => bug({ id: index + 1, projectId: 9002 })),
    );
    const result = await searcher(cli).api.search({ query: "bug" });
    expect(result.total).toBe(250);
    expect(result.bugs).toHaveLength(200);
    expect(result.capped).toBe(true);
  });

  it("removes status and order conditions using their existing keys", async () => {
    const cli = fakeCli([
      bug({ id: 60, projectId: 9002, status: 1 }),
      bug({ id: 61, projectId: 9002, status: 2 }),
    ]);
    const result = await searcher(cli, { statuses: [1], order: "oldest" }).api.search({
      query: "最早未解决的bug",
      omit: ["status:1", "order:oldest"],
    });
    expect(result.bugs.map(({ id }) => id).sort()).toEqual([60, 61]);
    expect(result.conditions.some(({ kind }) => kind === "status" || kind === "order")).toBe(false);
  });

  it.each([
    "missing_key",
    "quota_exhausted",
    "network",
    "timeout",
    "invalid_response",
    "unauthorized",
    "provider_failed",
  ])("returns %s without running rules or CLI queries", async (code) => {
    const cli = fakeCli([bug({ id: 70, projectId: 9002 })]);
    const { api, interpret } = searcher(cli);
    interpret.mockRejectedValue(new JarvisQueryError(code, "gemini"));
    expect(await api.search({ query: "我还没处理完成的bug" })).toEqual({
      available: false,
      source: "gemini",
      errorCode: code,
      conditions: [],
      bugs: [],
      total: 0,
      capped: false,
    });
    expect(cli.user).not.toHaveBeenCalled();
    expect(cli.projects).not.toHaveBeenCalled();
    expect(cli.searchProjects).not.toHaveBeenCalled();
    expect(cli.bugs).not.toHaveBeenCalled();
  });

  it("surfaces unrecognized text instead of silently dropping it", async () => {
    const cli = fakeCli([]);
    expect(
      await searcher(cli, { unrecognized: "不明条件" }).api.search({ query: "不明条件的bug" }),
    ).toMatchObject({ available: false, errorCode: "unrecognized_query" });
    expect(cli.bugs).not.toHaveBeenCalled();
  });

  it("does not invoke the model on a remote Host", async () => {
    const cli = fakeCli([]);
    const interpret = vi.fn();
    const api = new JarvisBugSearcher({ cli, interpreter: { interpret }, isLocalHost: false });
    expect(await api.search({ query: "我还没处理完成的bug" })).toMatchObject({
      available: false,
      errorCode: "local_only",
    });
    expect(interpret).not.toHaveBeenCalled();
    expect(cli.bugs).not.toHaveBeenCalled();
  });

  it("reports missing authentication and CLI failure", async () => {
    const cli = fakeCli([], { fail: true });
    expect(await searcher(cli).api.search({ query: "bug" })).toMatchObject({
      errorCode: "cli_failed",
    });
    vi.mocked(cli.user).mockResolvedValue(null);
    expect(await searcher(cli).api.search({ query: "bug" })).toMatchObject({
      available: false,
      errorCode: "not_logged_in",
    });
  });
});
