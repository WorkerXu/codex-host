import { describe, expect, it, vi } from "vitest";

import type { JarvisBug, JarvisBugSearchResult } from "@codexhost/shared-contracts";

import { JarvisBugSearcher, type JarvisBugSearchCli } from "../src/jarvis-bug-search.js";
import type { JarvisBugListOptions, JarvisProjectRow } from "../src/jarvis-cli.js";

const NOW = Date.parse("2026-11-16T10:00:00+08:00");

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
  { id: 4041, name: "示例后台 · 迭代 B" },
  { id: 4029, name: "示例商城 · 迭代 A" },
];
const VISIBLE: JarvisProjectRow[] = [
  { id: 4078, name: "示例买 · 消息通知" },
  { id: 4081, name: "示例买 · 标记迭代" },
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

function searcher(
  cli: JarvisBugSearchCli,
  decisions = {
    interpret: vi.fn(async () => ({ available: true, values: {} })),
    orderBugs: vi.fn(async (_query: string, bugs: readonly JarvisBug[]) => ({
      available: false,
      bugs: [...bugs],
    })),
  },
  isLocalHost = false,
): JarvisBugSearcher {
  return new JarvisBugSearcher({
    cli,
    decisions,
    isLocalHost,
    now: () => NOW,
    concurrency: 2,
  });
}

describe("Jarvis structured bug search", () => {
  it("filters assigned unresolved bugs across every project without a project search", async () => {
    const cli = fakeCli([
      bug({ id: 1, projectId: 4041 }),
      bug({ id: 2, projectId: 4041 }),
      bug({ id: 3, projectId: 4041, status: 2 }),
      bug({ id: 4, projectId: 4041, assigned: false, created: true }),
      bug({ id: 5, projectId: 4029 }),
    ]);
    const result = await searcher(cli).search({ query: "我还没处理完成的bug" });
    expect(cli.searchProjects).not.toHaveBeenCalled();
    expect(cli.bugs).toHaveBeenCalledTimes(2);
    expect(cli.bugs).toHaveBeenCalledWith(
      4041,
      expect.objectContaining({ createdByMe: false, statuses: [1] }),
    );
    expect(result.bugs.map(({ id }) => id).sort()).toEqual([1, 2, 5]);
    expect(result.total).toBe(3);
    expect(result.capped).toBe(false);
    expect(result.conditions).toEqual([
      { key: "scope:assigned", kind: "scope", label: "指派给我" },
      { key: "status:1", kind: "status", label: "未解决" },
    ]);
  });

  it("resolves a project name on demand and merges every matching project", async () => {
    const cli = fakeCli([
      bug({
        id: 10,
        projectId: 4078,
        updateTime: "2026-11-15 09:00:00",
      }),
      bug({
        id: 11,
        projectId: 4078,
        updateTime: "2026-11-10 09:00:00",
      }),
      bug({
        id: 12,
        projectId: 4081,
        updateTime: "2026-11-16 09:00:00",
      }),
    ]);
    const result = await searcher(cli).search({ query: "示例买的最近的bug" });
    expect(cli.searchProjects).toHaveBeenCalledWith("示例买");
    expect(cli.bugs).toHaveBeenCalledTimes(2);
    expect(result.bugs.map(({ id }) => id)).toEqual([12, 10, 11]);
    expect(result.total).toBe(3);
    expect(result.conditions).toContainEqual({
      key: "project:示例买",
      kind: "project",
      label: "示例买 ×2 个项目",
    });
  });

  it("never turns a matched project into a title keyword for Gemini", async () => {
    const decisions = {
      interpret: vi.fn(async () => ({
        available: true,
        values: { mentionsProject: false },
      })),
      orderBugs: vi.fn(async (_query: string, bugs: readonly JarvisBug[]) => ({
        available: false,
        bugs: [...bugs],
      })),
    };
    const cli = fakeCli([bug({ id: 13, projectId: 4078 })]);
    const result = await searcher(cli, decisions, true).search({
      query: "示例买的最近的bug",
    });
    expect(result.conditions).toContainEqual({
      key: "project:示例买",
      kind: "project",
      label: "示例买 ×2 个项目",
    });
    expect(result.conditions.some(({ kind }) => kind === "title")).toBe(false);
  });

  it("starts auth, project list and project-name search together", async () => {
    const cli = fakeCli([]);
    const pending = searcher(cli).search({ query: "示例买的bug" });
    expect(cli.user).toHaveBeenCalledTimes(1);
    expect(cli.projects).toHaveBeenCalledTimes(1);
    expect(cli.searchProjects).toHaveBeenCalledWith("示例买");
    await pending;
  });

  it("merges assigned and created scopes and de-duplicates by project and bug id", async () => {
    const cli = fakeCli([
      bug({ id: 20, projectId: 4041, assigned: true, created: true }),
      bug({ id: 21, projectId: 4041, assigned: false, created: true }),
      bug({ id: 22, projectId: 4029, assigned: true, created: false }),
    ]);
    const result = await searcher(cli).search({ query: "我创建的指派给我的bug" });
    expect(cli.bugs).toHaveBeenCalledTimes(4);
    expect(result.bugs.map(({ id }) => id).sort()).toEqual([20, 21, 22]);
    expect(result.conditions[0]).toEqual({
      key: "scope:both",
      kind: "scope",
      label: "指派或创建",
    });
  });

  it("pages through results and stops at the documented cap", async () => {
    const rows = Array.from({ length: 250 }, (_unused, index) =>
      bug({ id: index + 1, projectId: 4041, updateTime: "2026-11-10 09:00:00" }),
    );
    const cli = fakeCli(rows);
    const result = await searcher(cli).search({ query: "bug" });
    expect(result.total).toBe(250);
    expect(result.bugs).toHaveLength(200);
    expect(result.capped).toBe(true);
    expect(cli.bugs).toHaveBeenCalledTimes(3);
    expect(cli.bugs).toHaveBeenLastCalledWith(4041, expect.objectContaining({ page: 2 }));
  });

  it("removes a chip condition when the key is omitted", async () => {
    const cli = fakeCli([
      bug({ id: 30, projectId: 4041, status: 1 }),
      bug({ id: 31, projectId: 4041, status: 2 }),
    ]);
    const result = await searcher(cli).search({ query: "未解决的bug", omit: ["status:1"] });
    expect(cli.bugs).toHaveBeenCalledWith(4041, expect.not.objectContaining({ statuses: [1] }));
    expect(result.bugs.map(({ id }) => id).sort()).toEqual([30, 31]);
    expect(result.conditions.some(({ kind }) => kind === "status")).toBe(false);
  });

  it("uses the created scope for '我提的'", async () => {
    const cli = fakeCli([
      bug({ id: 40, projectId: 4041, assigned: false, created: true }),
      bug({ id: 41, projectId: 4041, assigned: true, created: false }),
    ]);
    const result = await searcher(cli).search({ query: "我提的bug" });
    expect(cli.bugs).toHaveBeenCalledWith(4041, expect.objectContaining({ createdByMe: true }));
    expect(result.bugs.map(({ id }) => id)).toEqual([40]);
  });

  it("uses unmatched leftover text as the title keyword", async () => {
    const cli = fakeCli([
      bug({ id: 50, projectId: 4041, bugTitle: "登录失败" }),
      bug({ id: 51, projectId: 4041, bugTitle: "支付失败" }),
    ]);
    const result = await searcher(cli).search({ query: "登录问题" });
    expect(cli.searchProjects).toHaveBeenCalledWith("登录");
    expect(cli.bugs).toHaveBeenCalledWith(4041, expect.objectContaining({ title: "登录" }));
    expect(result.bugs.map(({ id }) => id)).toEqual([50]);
    expect(result.conditions).toContainEqual({
      key: "title",
      kind: "title",
      label: "标题含「登录」",
    });
  });

  it("can omit a project token that was matched from a longer phrase", async () => {
    const cli = fakeCli([bug({ id: 55, projectId: 4078, bugTitle: "示例买支付回调失败" })]);
    const api = searcher(cli);
    const first = await api.search({ query: "示例买支付的bug" });
    expect(first.conditions).toContainEqual({
      key: "project:示例买",
      kind: "project",
      label: "示例买 ×2 个项目",
    });
    const second = await api.search({ query: "示例买支付的bug", omit: ["project:示例买"] });
    expect(second.conditions.some(({ kind }) => kind === "project")).toBe(false);
    expect(second.conditions).toContainEqual({
      key: "title",
      kind: "title",
      label: "标题含「示例买支付」",
    });
  });

  it("caches project searches briefly", async () => {
    const cli = fakeCli([]);
    const api = searcher(cli);
    await api.search({ query: "示例买bug" });
    await api.search({ query: "示例买的bug" });
    expect(cli.searchProjects).toHaveBeenCalledTimes(1);
  });

  it("filters severity and time locally", async () => {
    const cli = fakeCli([
      bug({ id: 60, projectId: 4041, severity: 1, updateTime: "2026-11-15 09:00:00" }),
      bug({ id: 61, projectId: 4041, severity: 3, updateTime: "2026-11-15 09:00:00" }),
      bug({ id: 62, projectId: 4041, severity: 1, updateTime: "2026-10-01 09:00:00" }),
    ]);
    const result = await searcher(cli).search({ query: "最近3天严重的bug" });
    expect(result.bugs.map(({ id }) => id)).toEqual([60]);
  });

  it("applies decisions only to fields the rules did not settle", async () => {
    const decisions = {
      interpret: vi.fn(async () => ({
        available: true,
        values: { scope: "created" as const, statuses: [1], mentionsProject: true },
      })),
      orderBugs: vi.fn(async (_query: string, bugs: readonly JarvisBug[]) => ({
        available: false,
        bugs: [...bugs],
      })),
    };
    const cli = fakeCli([
      bug({ id: 70, projectId: 4078, assigned: false, created: true }),
      bug({ id: 71, projectId: 4078, assigned: true, created: false }),
    ]);
    const result = await searcher(cli, decisions, true).search({
      query: "最近的示例买bug",
    });
    expect(decisions.interpret).toHaveBeenCalledTimes(1);
    const fields = (
      decisions.interpret.mock.calls as unknown as [string, readonly string[]][]
    )[0]?.[1];
    expect(fields).toContain("scope");
    expect(fields).toContain("status");
    expect(fields).not.toContain("mentionsProject");
    expect(fields).not.toContain("order");
    expect(cli.bugs).toHaveBeenCalledWith(
      4078,
      expect.objectContaining({ createdByMe: true, statuses: [1] }),
    );
    expect(result.bugs.map(({ id }) => id)).toEqual([70]);
  });

  it("skips the model entirely when the rules settle every field", async () => {
    const decisions = {
      interpret: vi.fn(async () => ({ available: true, values: {} })),
      orderBugs: vi.fn(async (_query: string, bugs: readonly JarvisBug[]) => ({
        available: false,
        bugs: [...bugs],
      })),
    };
    const cli = fakeCli([bug({ id: 80, projectId: 4041 })]);
    await searcher(cli, decisions, true).search({
      query: "我还没处理完成的高优先级严重的最旧的最近3天bug",
    });
    expect(decisions.interpret).not.toHaveBeenCalled();
  });

  it("reports an unavailable account instead of returning empty success", async () => {
    const cli = fakeCli([]);
    vi.mocked(cli.user).mockResolvedValue(null);
    expect(await searcher(cli).search({ query: "bug" })).toEqual({
      available: false,
      errorCode: "not_logged_in",
      conditions: [],
      bugs: [],
      total: 0,
      capped: false,
    });
  });

  it("surfaces a CLI failure when every project query fails", async () => {
    const cli = fakeCli([], { fail: true });
    const result: JarvisBugSearchResult = await searcher(cli).search({ query: "bug" });
    expect(result.available).toBe(true);
    expect(result.errorCode).toBe("cli_failed");
    expect(result.bugs).toEqual([]);
  });
});
