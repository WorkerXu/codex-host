import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { DingTalkNativeRunner } from "../src/dingtalk-native-runner.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(
  options: { fast?: boolean; approval?: boolean; missingConfig?: boolean } = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-native-dispatch-"));
  directories.push(cwd);
  const request = vi.fn<(method: string, params: JsonObject) => Promise<JsonObject>>(
    async (method) => {
      if (method === "config/read")
        return options.missingConfig
          ? { error: { message: "failed" } }
          : { result: { config: { mcp_servers: { dingtalk: { url: "never-used" } } } } };
      if (method === "thread/start") return { result: { thread: { id: "native-thread" } } };
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
  const notify = vi.fn(async (message: JsonObject) => {
    const params = message.params as JsonObject;
    runner.projectReady({ requestId: params.requestId, error: null });
  });
  const runner = new DingTalkNativeRunner(request, notify);
  const run = () =>
    runner.start({
      cwd,
      title: "知识库 · 技术群 · 接口问题",
      developerInstructions: "查询知识库",
      model: "gpt-test",
      reasoningEffort: "high",
      prompt: "接口如何实现？",
      ...(options.approval ? { readOnlySummary: true } : {}),
    });
  return { runner, request, notify, run };
}

describe("native DingTalk Threads", () => {
  it("starts in the native project with configured model/instructions and collects only final answers", async () => {
    const f = await fixture();
    const run = await f.run();
    expect(f.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        developerInstructions: "查询知识库",
        sandbox: "read-only",
        approvalPolicy: "never",
        model: "gpt-test",
        ephemeral: false,
      }),
    );
    expect(f.notify).toHaveBeenCalledOnce();
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

it("interrupts a timed out native Turn and ignores completions for a different Turn", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const active = await f.run();
  f.runner.observe({
    method: "turn/completed",
    params: {
      threadId: "native-thread",
      turn: { id: "other-turn", status: "completed", items: [] },
    },
  });
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(await active.completed).toMatchObject({
    status: "failed",
    errorMessage: "Codex Turn timed out",
  });
  expect(f.request).toHaveBeenCalledWith("turn/interrupt", {
    threadId: "native-thread",
    turnId: "native-turn",
  });
  f.runner.dispose();
});
