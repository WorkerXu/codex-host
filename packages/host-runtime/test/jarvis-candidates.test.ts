import { describe, expect, it, vi } from "vitest";

import type { JarvisCandidate, JarvisKind } from "@codexhost/shared-contracts";

import { candidateFromJarvisRow, parseJarvisOutput } from "../src/jarvis-cli.js";
import { JarvisCandidatePool, type JarvisCandidatePoolOptions } from "../src/jarvis-candidates.js";

const user = { id: 10058, name: "许涛" };
const projects = [
  { id: 4029, name: "查码商补充首饰质检结果" },
  { id: 4041, name: "加盟商竞拍单" },
];
const bugs = [
  {
    id: 928,
    bugTitle: "填写已查码的序列号给新的查码任务，无法进行下一步",
    projectId: 4029,
    status: 1,
    creatorId: 10473,
    assigneeId: 10058,
    createTime: "2026-10-27 09:48:52",
  },
  {
    id: 900,
    bugTitle: "旧 Bug",
    projectId: 4029,
    status: 2,
    creatorId: 10058,
    assigneeId: 10058,
    createTime: "2026-09-01 10:00:00",
  },
];

function fakeCli(
  overrides: Partial<JarvisCandidatePoolOptions["cli"]> = {},
): JarvisCandidatePoolOptions["cli"] {
  return {
    user: vi.fn(async () => user),
    projects: vi.fn(async () => projects),
    bugs: vi.fn(async () => bugs),
    requirements: vi.fn(async () => [
      {
        id: 2530,
        requireTitle: "顺店通：用户通知调整",
        projectId: 4100,
        status: 7,
        creatorId: 10490,
        assigneeId: 10058,
        createTime: "2026-11-09 16:15:01",
      },
    ]),
    tasks: vi.fn(async () => [
      {
        taskId: 101170,
        taskName: "[查码]开发",
        projectId: 4029,
        userId: 10058,
        startDate: "2026-08-03T15:30:00+08:00",
      },
    ]),
    ...overrides,
  } as unknown as JarvisCandidatePoolOptions["cli"];
}

describe("jarvis CLI output parsing", () => {
  it("uses the last terminal JSON object even after event lines", () => {
    const stdout = [
      '{"event":"bug.list","outcome":"success","level":"INFO"}',
      '{"data":{"list":[{"id":1}]},"ok":true}',
    ].join("\n");
    expect(parseJarvisOutput(stdout, "")).toEqual({
      ok: true,
      data: { list: [{ id: 1 }] },
      errorCode: null,
      errorMessage: null,
    });
  });

  it("keeps server error codes and rejects missing output", () => {
    expect(
      parseJarvisOutput(
        '{"error":{"code":"operation_failed","message":"认证失败"},"ok":false}',
        "",
      ),
    ).toEqual({
      ok: false,
      data: null,
      errorCode: "operation_failed",
      errorMessage: "认证失败",
    });
    expect(parseJarvisOutput("not json", "")).toMatchObject({
      ok: false,
      errorCode: "invalid_output",
    });
  });

  it("maps rows to candidates and drops rows without the required fields", () => {
    const candidates = candidateFromJarvisRow(
      "bug",
      bugs[0] as Record<string, unknown>,
      new Map([[4029, "查码商补充首饰质检结果"]]),
    );
    expect(candidates).toMatchObject({
      kind: "bug",
      id: 928,
      projectId: 4029,
      projectName: "查码商补充首饰质检结果",
      title: "填写已查码的序列号给新的查码任务，无法进行下一步",
      status: 1,
      creatorId: 10473,
      assigneeId: 10058,
      createdAt: "2026-10-27 09:48:52",
    });
    expect(candidateFromJarvisRow("bug", { id: 1 }, new Map())).toBeNull();
    expect(candidateFromJarvisRow("task", { taskId: 1 }, new Map())).toBeNull();
  });
});

describe("Jarvis candidate pool", () => {
  it("fetches each kind once and reuses it inside the TTL", async () => {
    let now = 1_000;
    const cli = fakeCli();
    const pool = new JarvisCandidatePool({ cli, now: () => now, ttlMs: 5_000 });
    const first = await pool.get("bug");
    expect(first.available).toBe(true);
    expect(first.candidates.map(({ id }) => id)).toEqual([928, 900]);
    expect(cli.bugs).toHaveBeenCalledTimes(4);
    now += 4_999;
    await pool.get("bug");
    expect(cli.bugs).toHaveBeenCalledTimes(4);
    now += 1;
    const stale = await pool.get("bug");
    expect(stale.candidates).toHaveLength(2);
    await vi.waitFor(() => expect(cli.bugs).toHaveBeenCalledTimes(8));
    await vi.waitFor(async () => {
      const refreshed = await pool.get("bug");
      expect(refreshed.candidates).toHaveLength(2);
    });
  });

  it("deduplicates a bug returned by both assigned and created queries", async () => {
    const first = bugs[0];
    if (!first) throw new Error("fixture is missing a bug");
    const cli = fakeCli({
      bugs: vi.fn(async (): Promise<Record<string, unknown>[]> => [first, first]),
    });
    const pool = new JarvisCandidatePool({ cli, now: () => 1 });
    const result = await pool.get("bug");
    expect(result.candidates).toHaveLength(1);
  });

  it("returns no availability when the CLI is not signed in", async () => {
    const cli = fakeCli({ user: vi.fn(async () => null) });
    const pool = new JarvisCandidatePool({ cli, now: () => 1 });
    expect(await pool.get("project")).toEqual({
      available: false,
      candidates: [],
      user: null,
      fetchedAt: null,
    });
  });

  it("loads projects, requirements and tasks with the current user filters", async () => {
    const cli = fakeCli();
    const pool = new JarvisCandidatePool({ cli, now: () => 1 });
    const projectsResult = await pool.get("project");
    expect(projectsResult.candidates.map(({ title }) => title)).toEqual([
      "查码商补充首饰质检结果",
      "加盟商竞拍单",
    ]);
    const requirements = await pool.get("requirement");
    expect(requirements.candidates[0]).toMatchObject({ kind: "requirement", id: 2530 });
    const tasks = await pool.get("task");
    expect(tasks.candidates[0]).toMatchObject({ kind: "task", id: 101170 });
    expect(cli.requirements).toHaveBeenCalledWith(10058);
    expect(cli.tasks).toHaveBeenCalledWith(10058);
  });

  it("serves the last good cache when a refresh loses authentication", async () => {
    const cli = fakeCli();
    const pool = new JarvisCandidatePool({ cli, now: () => 1, ttlMs: 0 });
    await pool.get("requirement");
    vi.mocked(cli.user).mockResolvedValueOnce(null);
    const result = await pool.get("requirement", { refresh: true });
    expect(result.available).toBe(true);
    expect(result.candidates).toHaveLength(1);
  });

  it("keeps the typed kind set closed", () => {
    const kinds: JarvisKind[] = ["project", "requirement", "task", "bug"];
    const candidates: JarvisCandidate[] = kinds.map((kind) => ({
      kind,
      id: 1,
      title: kind,
    }));
    expect(candidates).toHaveLength(4);
  });
});
