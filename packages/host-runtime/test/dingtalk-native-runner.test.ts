import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { DingTalkProgressEvent } from "../src/dingtalk-dispatch-types.js";
import { DingTalkNativeRunner } from "../src/dingtalk-native-runner.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(
  options: {
    fast?: boolean;
    approval?: boolean;
    missingConfig?: boolean;
    wrongProject?: boolean;
    onProgress?: (event: DingTalkProgressEvent) => void;
  } = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-native-dispatch-"));
  directories.push(cwd);
  const request = vi.fn<(method: string, params: JsonObject) => Promise<JsonObject>>(
    async (method) => {
      if (method === "config/read")
        return options.missingConfig
          ? { error: { message: "failed" } }
          : { result: { config: { mcp_servers: { dingtalk: { url: "never-used" } } } } };
      if (method === "thread/start")
        return {
          result: {
            thread: {
              id: "native-thread",
              projectId: options.wrongProject ? "other" : "project-1",
            },
          },
        };
      if (method === "turn/start") {
        if (options.fast)
          runner.observe({
            method: "turn/completed",
            params: {
              threadId: "native-thread",
              turn: {
                id: "native-turn",
                status: "completed",
                items: [{ type: "agentMessage", phase: "final_answer", text: "快速答案" }],
              },
            },
          });
        return { result: { turn: { id: "native-turn" } } };
      }
      return { result: {} };
    },
  );
  const runner = new DingTalkNativeRunner(request);
  const run = () =>
    runner.start({
      cwd,
      projectId: "project-1",
      projectRoots: [cwd],
      title: "知识库 · 技术群 · 接口问题",
      developerInstructions: "查询知识库",
      model: "gpt-test",
      reasoningEffort: "high",
      prompt: "接口如何实现？",
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.approval ? { readOnlySummary: true } : {}),
    });
  return { runner, request, run };
}

describe("native DingTalk Threads", () => {
  it("does not start a Turn when native project assignment was not confirmed", async () => {
    const f = await fixture({ wrongProject: true });
    await expect(f.run()).rejects.toThrow("工作项目归属未确认");
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    f.runner.dispose();
  });
  it("starts in the selected project with configured model/instructions and collects only final answers", async () => {
    const f = await fixture();
    const run = await f.run();
    expect(f.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        projectId: "project-1",
        cwd: expect.any(String),
        runtimeWorkspaceRoots: [expect.any(String)],
        developerInstructions: "查询知识库",
        sandbox: "read-only",
        approvalPolicy: "never",
        model: "gpt-test",
        ephemeral: false,
        config: {
          "shell_environment_policy.set.CODEXHOST_DINGTALK_DISPATCH": "1",
        },
      }),
    );
    expect(f.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "native-thread",
        effort: "high",
        model: "gpt-test",
        sandboxPolicy: { type: "readOnly", networkAccess: true },
      }),
    );
    f.runner.observe({
      method: "item/completed",
      params: {
        threadId: "native-thread",
        item: { type: "agentMessage", id: "comment", phase: "commentary", text: "正在查询" },
      },
    });
    f.runner.observe({
      method: "item/completed",
      params: { threadId: "other-thread", item: { type: "agentMessage", text: "错的答案" } },
    });
    f.runner.observe({
      method: "item/completed",
      params: {
        threadId: "native-thread",
        item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "最终答案" },
      },
    });
    f.runner.observe({
      method: "turn/completed",
      params: {
        threadId: "native-thread",
        turn: { id: "native-turn", status: "completed", items: [] },
      },
    });
    expect(await run.completed).toEqual({
      answer: "最终答案",
      status: "completed",
      errorMessage: null,
    });
    f.runner.dispose();
  });
  it("does not lose completion delivered before turn/start responds", async () => {
    const f = await fixture({ fast: true });
    expect(await (await f.run()).completed).toMatchObject({
      answer: "快速答案",
      status: "completed",
    });
    f.runner.dispose();
  });
  it("disables shell, subagents, plugins, apps and every MCP server for approvals", async () => {
    const f = await fixture({ fast: true, approval: true });
    await f.run();
    expect(f.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        config: expect.objectContaining({
          "features.shell_tool": false,
          "shell_environment_policy.set.CODEXHOST_DINGTALK_DISPATCH": "1",
          "features.unified_exec": false,
          "features.multi_agent": false,
          "features.plugins": false,
          "features.apps": false,
          "mcp_servers.dingtalk.enabled": false,
          web_search: "disabled",
        }),
      }),
    );
    expect(f.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ sandboxPolicy: { type: "readOnly", networkAccess: false } }),
    );
    expect(f.request.mock.calls.every(([method]) => !method.startsWith("oa/"))).toBe(true);
    f.runner.dispose();
  });
  it("refuses approval execution when tool restrictions cannot be configured", async () => {
    const f = await fixture({ approval: true, missingConfig: true });
    await expect(f.run()).rejects.toThrow("Cannot restrict tools");
    expect(f.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    f.runner.dispose();
  });
  it("settles outstanding runs on shutdown", async () => {
    const f = await fixture();
    const run = await f.run();
    f.runner.dispose();
    expect(await run.completed).toMatchObject({ status: "interrupted" });
  });
});

it("keeps long Turns running, reports elapsed progress and stops card tracking at sixty minutes", async () => {
  const onProgress = vi.fn();
  const f = await fixture({ onProgress });
  vi.useFakeTimers();
  const active = await f.run();
  const complete = vi.fn();
  void active.completed.then(complete);
  f.runner.observe({
    method: "turn/completed",
    params: {
      threadId: "native-thread",
      turn: { id: "other-turn", status: "completed", items: [] },
    },
  });
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(complete).not.toHaveBeenCalled();
  expect(onProgress).toHaveBeenLastCalledWith({
    type: "status",
    text: "仍在处理，已用时 10 分钟",
  });
  await vi.advanceTimersByTimeAsync(40 * 60_000);
  expect(onProgress).toHaveBeenLastCalledWith({
    type: "status",
    text: "仍在处理，已用时 50 分钟",
  });
  expect(complete).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(await active.completed).toMatchObject({
    status: "failed",
    errorMessage: "处理时间过长，已停止",
  });
  expect(f.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  f.runner.dispose();
});

it("cleans elapsed reminders after completion", async () => {
  const onProgress = vi.fn();
  const f = await fixture({ fast: true, onProgress });
  vi.useFakeTimers();
  const active = await f.run();
  await active.completed;
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(onProgress).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.runner.dispose();
});

it("maps public tool items to sanitized steps and never exposes reasoning or output", async () => {
  const onProgress = vi.fn<(event: DingTalkProgressEvent) => void>();
  const f = await fixture({ onProgress });
  await f.run();
  const observe = (method: string, item: JsonObject) =>
    f.runner.observe({
      method,
      params: { threadId: "native-thread", turnId: "native-turn", item },
    });
  observe("item/completed", { type: "reasoning", id: "r1", text: "内部推理" });
  observe("item/started", {
    type: "commandExecution",
    id: "cmd-1",
    command: "dws chat message list --limit 5",
    status: "inProgress",
  });
  observe("item/completed", {
    type: "commandExecution",
    id: "cmd-1",
    command: "dws chat message list --limit 5",
    status: "failed",
    exitCode: 1,
    aggregatedOutput: "RAW TOOL OUTPUT",
  });
  observe("item/completed", { type: "mcpToolCall", id: "tool-1", server: "dws", tool: "chat" });
  observe("item/completed", {
    type: "fileChange",
    id: "file-1",
    changes: [{ path: "docs/a.md" }, { path: "docs/b.md" }],
  });
  observe("item/completed", { type: "webSearch", id: "search-1", query: "钉钉 审批" });
  observe("item/completed", {
    type: "agentMessage",
    id: "answer-1",
    phase: "final_answer",
    text: "最终答案",
  });
  observe("item/completed", {
    type: "agentMessage",
    id: "note-1",
    phase: "commentary",
    text: "正在核对资料",
  });
  const calls = onProgress.mock.calls.map(([event]) => event);
  expect(calls).toEqual([
    {
      type: "step",
      step: {
        id: "item:cmd-1",
        kind: "command",
        title: "执行命令",
        detail: "dws chat message list --limit 5",
        status: "running",
      },
    },
    {
      type: "step",
      step: {
        id: "item:cmd-1",
        kind: "command",
        title: "执行命令",
        detail: "dws chat message list --limit 5",
        status: "failed",
      },
    },
    {
      type: "step",
      step: {
        id: "item:tool-1",
        kind: "tool",
        title: "调用工具",
        detail: "dws · chat",
        status: "done",
      },
    },
    {
      type: "step",
      step: {
        id: "item:file-1",
        kind: "file",
        title: "修改文件",
        detail: "docs/a.md、docs/b.md",
        status: "done",
      },
    },
    {
      type: "step",
      step: {
        id: "item:search-1",
        kind: "search",
        title: "搜索资料",
        detail: "钉钉 审批",
        status: "done",
      },
    },
    {
      type: "step",
      step: {
        id: "item:answer-1",
        kind: "answer",
        title: "撰写回答",
        detail: "整理最终回答",
        status: "done",
      },
    },
    { type: "status", text: "正在核对资料" },
  ]);
  expect(JSON.stringify(calls)).not.toContain("内部推理");
  expect(JSON.stringify(calls)).not.toContain("RAW TOOL OUTPUT");
  onProgress.mockClear();
  f.runner.observe({
    method: "turn/plan/updated",
    params: {
      threadId: "native-thread",
      turnId: "native-turn",
      plan: [{ step: "整理可公开的结论", status: "in_progress" }],
    },
  });
  expect(onProgress).toHaveBeenCalledWith({ type: "status", text: "整理可公开的结论" });
  f.runner.dispose();
});
