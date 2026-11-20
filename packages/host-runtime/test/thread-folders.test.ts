import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { THREAD_FOLDERS_PARAM } from "@codexhost/shared-contracts";
import type { JsonRpcRequest } from "@codexhost/protocol-core";
import {
  ThreadFolders,
  rewriteFolderStart,
  rewriteFolderTurn,
  threadEnvironmentId,
} from "../src/thread-folders.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const request = (method: string, params: unknown, id = 1) =>
  ({ id, method, params }) as JsonRpcRequest;
async function service() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thread-folders-"));
  temporary.push(directory);
  return { directory, folders: new ThreadFolders({ CODEXHOST_DATA_DIR: directory }) };
}
const roots = [path.resolve("/one"), path.resolve("/two")];

describe("per-thread working folders", () => {
  it("rewrites new thread roots and cwd while preserving project and permissions", () => {
    const params = {
      cwd: "/project",
      projectId: "p",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      [THREAD_FOLDERS_PARAM]: roots,
    };
    expect(rewriteFolderStart(request("thread/start", params)).request.params).toEqual({
      cwd: roots[0],
      projectId: "p",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      runtimeWorkspaceRoots: roots,
    });
    expect(params.cwd).toBe("/project");
    expect(() =>
      rewriteFolderStart(request("thread/start", { [THREAD_FOLDERS_PARAM]: ["relative"] })),
    ).toThrow();
  });
  it("changes the current environment and preserves the others and input attachments", () => {
    const input = [{ type: "localImage", path: "/attachment.png" }];
    const rewritten = rewriteFolderTurn(
      request("turn/start", {
        threadId: "t",
        projectId: "p",
        runtimeWorkspaceRoots: ["/stale-project"],
        input,
        environments: [
          { environmentId: "secondary", cwd: "/keep" },
          { environmentId: "main", other: 1 },
        ],
      }),
      roots,
      "main",
      true,
    );
    expect(rewritten.params).toMatchObject({
      projectId: "p",
      cwd: roots[0],
      runtimeWorkspaceRoots: roots,
      environments: [
        { environmentId: "main", cwd: roots[0], runtimeWorkspaceRoots: roots, other: 1 },
        { environmentId: "secondary", cwd: "/keep" },
      ],
    });
    expect((rewritten.params as { input: unknown[] }).input[0]).toEqual(input[0]);
    expect((rewritten.params as { input: unknown[] }).input).toHaveLength(2);
    expect(
      threadEnvironmentId({ result: { thread: { environments: [{ environmentId: "live" }] } } }),
    ).toBe("live");
  });
  it("persists across reloads and execution Hosts remain isolated", async () => {
    const a = await service();
    const b = await service();
    await a.folders.select("same", roots);
    const reloaded = new ThreadFolders({ CODEXHOST_DATA_DIR: a.directory });
    expect((await reloaded.store.get("same"))?.folders).toEqual(roots);
    expect(await reloaded.store.recent()).toEqual(roots);
    expect(await b.folders.store.get("same")).toBeNull();
  });
  it("keeps Desktop's Codex home out of recently used folders", async () => {
    const { directory } = await service();
    const codexHome = path.join(directory, "codex-home");
    const folders = new ThreadFolders({
      CODEXHOST_DATA_DIR: directory,
      CODEX_HOME: codexHome,
    });
    await folders.select("worktree", [
      path.join(codexHome, "worktrees", "6c05", "service.stock.java"),
    ]);
    await folders.select("visualization", [
      path.join(codexHome, "visualizations", "2026", "11", "04", "thread"),
    ]);
    await folders.select("real", roots);
    await folders.select("lookalike", [`${codexHome}-other`]);
    expect(await folders.store.recent()).toHaveLength(5);
    const recent = await folders.recent();
    expect([...recent].sort()).toEqual([...roots, `${codexHome}-other`].sort());
  });
  it("treats a missing CODEX_HOME as ~/.codex", async () => {
    const { folders } = await service();
    await folders.select("worktree", [
      path.join(os.homedir(), ".codex", "worktrees", "6c05", "service.stock.java"),
    ]);
    await folders.select("visualization", [
      path.join(os.homedir(), ".codex", "visualizations", "2026", "11", "04", "thread"),
    ]);
    expect(await folders.recent()).toEqual([]);
  });
  it("retains the change note after an error and consumes it only after acceptance", async () => {
    const { folders } = await service();
    await folders.select("t", roots);
    const next = request("turn/start", { threadId: "t", input: [{ type: "text", text: "hello" }] });
    const prepare = (id: number) =>
      folders.prepare({ ...next, id } as JsonRpcRequest, async () => "e");
    expect((await prepare(1)).params).toHaveProperty(
      "input",
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("工作文件夹已改为") }),
      ]),
    );
    await folders.observe({ id: 1, error: { message: "failed" } });
    await prepare(2);
    await folders.observe({ id: 2, result: { turn: { id: "turn" } } });
    expect((await prepare(3)).params).toHaveProperty("input", [{ type: "text", text: "hello" }]);
    await expect(folders.prepare(next, async () => null)).rejects.toThrow("environmentId");
  });
  it("persists new native Desktop roots only after a successful start", async () => {
    const { folders } = await service();
    await folders.prepare(
      request("thread/start", {
        cwd: roots[0],
        runtimeWorkspaceRoots: roots,
        projectId: "project",
      }),
      async () => null,
    );
    await folders.observe({ id: 1, result: { thread: { id: "created" } } });
    expect(await folders.store.get("created")).toMatchObject({
      folders: roots,
      appliedFolders: roots,
      notes: [],
    });
  });
});

it("preserves a newer selection when an older turn is accepted by another Host session", async () => {
  const { directory, folders } = await service();
  await folders.select("shared", roots);
  await folders.prepare(
    request("turn/start", { threadId: "shared", input: [{ type: "text", text: "old" }] }),
    async () => "env",
  );
  const other = new ThreadFolders({ CODEXHOST_DATA_DIR: directory });
  await Promise.all([
    other.select("shared", [path.resolve("/new")]),
    folders.observe({ id: 1, result: { turn: { id: "accepted" } } }),
  ]);
  expect(await other.store.get("shared")).toMatchObject({
    folders: [path.resolve("/new")],
    appliedFolders: roots,
  });
});
