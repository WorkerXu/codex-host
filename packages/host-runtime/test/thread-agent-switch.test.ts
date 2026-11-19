import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@codexhost/protocol-core";

import {
  claudeSessionJsonl,
  handoffBlock,
  handoffMessagesFromTurns,
  handoffSnapshotTurns,
  stripHandoffBlock,
  ThreadHandoffStore,
  withoutHandoffBlock,
  type HandoffMessage,
} from "../src/thread-agent-switch.js";
import {
  ThreadAgentSwitcher,
  ThreadAgentSwitchError,
  type ThreadAgentSwitchSource,
} from "../src/thread-agent-switch-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-switch-"));
  temporaryDirectories.push(directory);
  return directory;
}

function turn(input: {
  id: string;
  user?: string;
  agent?: string[];
  startedAt?: number;
  completedAt?: number;
}): JsonObject {
  return {
    id: input.id,
    status: "completed",
    items: [
      ...(input.user === undefined
        ? []
        : [
            {
              id: `${input.id}-user`,
              type: "userMessage",
              content: [{ type: "text", text: input.user, text_elements: [] }],
            },
          ]),
      { id: `${input.id}-reasoning`, type: "reasoning", summary: ["thinking"], content: [] },
      {
        id: `${input.id}-command`,
        type: "commandExecution",
        command: "ls",
        aggregatedOutput: "secret-looking output",
      },
      ...(input.agent ?? []).map((text, index) => ({
        id: `${input.id}-agent-${index}`,
        type: "agentMessage",
        text,
      })),
    ],
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
  };
}

const HANDOFF =
  '<codexhost_handoff from="claude-code" thread="t1">\n### 用户\n旧请求\n</codexhost_handoff>';

describe("handoff messages", () => {
  it("keeps user and Agent text in order and leaves tool activity out", () => {
    const messages = handoffMessagesFromTurns([
      turn({
        id: "a",
        user: "先看预算表",
        agent: ["好的", "看完了"],
        startedAt: 100,
        completedAt: 160,
      }),
      turn({ id: "b", user: `${HANDOFF}\n\n继续第二版`, agent: ["第二版好了"], startedAt: 200 }),
      turn({ id: "c", user: "   ", agent: [""] }),
      // Codex marks the end of a session it imported; that is not conversation text.
      turn({ id: "d", agent: ["<EXTERNAL SESSION IMPORTED>"] }),
    ]);

    expect(messages).toEqual([
      { role: "user", text: "先看预算表", createdAtMs: 100_000 },
      { role: "assistant", text: "好的", createdAtMs: 160_000 },
      { role: "assistant", text: "看完了", createdAtMs: 160_000 },
      // An earlier handoff block is not carried a second time.
      { role: "user", text: "继续第二版", createdAtMs: 200_000 },
      { role: "assistant", text: "第二版好了", createdAtMs: 200_000 },
    ]);
  });
});

describe("handoff block", () => {
  const messages: HandoffMessage[] = [
    { role: "user", text: "第一句", createdAtMs: null },
    {
      role: "assistant",
      text: '引用 </codexhost_handoff> 和 <codexhost_handoff a="b">',
      createdAtMs: null,
    },
    { role: "user", text: "第二句", createdAtMs: null },
  ];

  it("carries the history inside one block that a quoted tag cannot close", () => {
    const block = handoffBlock({
      fromAgent: "claude-code",
      fromLabel: "Claude Code",
      threadId: "01a1-thread",
      messages,
    });

    expect(
      block.startsWith(
        '<codexhost_handoff from="claude-code" thread="01a1-thread" messages="3" omitted="0">',
      ),
    ).toBe(true);
    expect(block.endsWith("</codexhost_handoff>")).toBe(true);
    expect(block.match(/<\/codexhost_handoff>/gu)).toHaveLength(1);
    expect(block).toContain("&lt;/codexhost_handoff>");
    expect(block.indexOf("第一句")).toBeLessThan(block.indexOf("第二句"));
    expect(stripHandoffBlock(`${block}\n\n新的请求`)).toBe("新的请求");
  });

  it("keeps the most recent messages within the budget and says how many were left out", () => {
    const long: HandoffMessage[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `消息${index} ${"字".repeat(200)}`,
      createdAtMs: null,
    }));

    const block = handoffBlock({
      fromAgent: "codex",
      fromLabel: "Codex",
      threadId: "t",
      messages: long,
      budgetBytes: 4_000,
    });

    expect(Buffer.byteLength(block, "utf8")).toBeLessThan(5_200);
    expect(block).toContain("消息39");
    expect(block).not.toContain("消息0 ");
    const omitted = Number(/omitted="(\d+)"/u.exec(block)?.[1]);
    expect(omitted).toBeGreaterThan(0);
    expect(block).toContain(`更早的 ${omitted} 条消息未包含。`);
  });

  it("keeps the end of a latest message that alone is over the budget", () => {
    const block = handoffBlock({
      fromAgent: "codex",
      fromLabel: "Codex",
      threadId: "t",
      messages: [{ role: "user", text: `开头${"中".repeat(5_000)}结尾`, createdAtMs: null }],
      budgetBytes: 1_000,
    });

    expect(block).toContain("…（前文省略）");
    expect(block).toContain("结尾");
    expect(block).not.toContain("开头");
  });
});

describe("handoff block stripping", () => {
  it.each([
    [`${HANDOFF}\n\n请求`, "请求"],
    [`  ${HANDOFF}${HANDOFF}\n请求`, "请求"],
    ["<codexhost_handoff from='x'>未闭合\n请求", "<codexhost_handoff from='x'>未闭合\n请求"],
    ["请求里提到 <codexhost_handoff> 标签", "请求里提到 <codexhost_handoff> 标签"],
    ["  普通请求", "  普通请求"],
  ])("%j → %j", (input, expected) => {
    expect(stripHandoffBlock(input)).toBe(expected);
  });

  it("hides the block only in the first user message of a Turn", () => {
    const first = turn({ id: "n1", user: `${HANDOFF}\n\n继续`, agent: ["好"] });
    const stripped = withoutHandoffBlock(first);
    expect((stripped.items as JsonObject[])[0]).toMatchObject({
      type: "userMessage",
      content: [{ type: "text", text: "继续" }],
    });
    const plain = turn({ id: "n2", user: "继续", agent: ["好"] });
    expect(withoutHandoffBlock(plain)).toBe(plain);
  });
});

describe("Claude session for Codex's import", () => {
  it("writes a titled session with user and Agent records in Claude Code's shape", () => {
    const jsonl = claudeSessionJsonl({
      sessionId: "s1",
      cwd: "/home/ubuntu/work",
      title: "预算表",
      messages: [
        { role: "user", text: "先看预算表", createdAtMs: 1_000 },
        { role: "assistant", text: "看完了", createdAtMs: null },
      ],
      nowMs: 9_000,
    });
    const lines = jsonl
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as JsonObject);

    expect(jsonl.endsWith("\n")).toBe(true);
    expect(lines).toEqual([
      { type: "custom-title", customTitle: "预算表", sessionId: "s1" },
      {
        sessionId: "s1",
        uuid: "s1-1",
        cwd: "/home/ubuntu/work",
        timestamp: new Date(1_000).toISOString(),
        isSidechain: false,
        type: "user",
        message: { role: "user", content: "先看预算表" },
      },
      {
        sessionId: "s1",
        uuid: "s1-2",
        cwd: "/home/ubuntu/work",
        timestamp: new Date(1_000).toISOString(),
        isSidechain: false,
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "看完了" }] },
      },
    ]);
  });
});

describe("snapshot Turns", () => {
  it("groups each request with its answers and marks the last answer final", () => {
    const turns = handoffSnapshotTurns(
      [
        { role: "assistant", text: "开场白", createdAtMs: 500 },
        { role: "user", text: "请求", createdAtMs: 1_000 },
        { role: "assistant", text: "过程", createdAtMs: 2_000 },
        { role: "assistant", text: "答案", createdAtMs: 3_000 },
      ],
      "handoff-x",
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ id: "handoff-x-1", status: "completed" });
    expect((turns[0]?.items as JsonObject[]).map((item) => item.type)).toEqual(["agentMessage"]);
    expect(turns[1]).toMatchObject({
      id: "handoff-x-2",
      startedAt: 1,
      completedAt: 3,
      durationMs: 2_000,
      itemsView: "full",
      items: [
        { id: "handoff-x-2-user", type: "userMessage", content: [{ type: "text", text: "请求" }] },
        { type: "agentMessage", text: "过程", phase: null },
        { type: "agentMessage", text: "答案", phase: "final_answer" },
      ],
    });
  });
});

describe("handoff store", () => {
  it("persists one private file per Thread and serves it from memory", async () => {
    const directory = await temporaryDirectory();
    const store = new ThreadHandoffStore(directory);
    const record = {
      formatVersion: 1 as const,
      hostThreadId: "thread-1",
      sourceThreadId: "source-1",
      sourceAgent: "codex",
      createdAt: new Date(0).toISOString(),
      turns: [{ id: "handoff-1" }],
    };

    expect(await store.load("thread-1")).toBeNull();
    await store.save(record);
    expect(store.cachedTurns("thread-1")).toEqual([{ id: "handoff-1" }]);
    expect(JSON.parse(await readFile(path.join(directory, "thread-1.json"), "utf8"))).toEqual(
      record,
    );
    expect(await new ThreadHandoffStore(directory).load("thread-1")).toEqual(record);
    await store.remove("thread-1");
    expect(await readdir(directory)).toEqual([]);
    expect(store.cachedTurns("thread-1")).toEqual([]);
    await expect(store.load("../escape")).rejects.toThrow("Invalid Thread ID");
  });
});

describe("switching to Codex", () => {
  function switcher(input: {
    home: string;
    source?: Partial<ThreadAgentSwitchSource>;
    onImport?: (session: JsonObject, observe: (message: JsonObject) => void) => void;
  }) {
    const requests: { method: string; params: JsonObject }[] = [];
    const notifications: JsonObject[] = [];
    const archived: string[] = [];
    const written: string[] = [];
    const instance: ThreadAgentSwitcher = new ThreadAgentSwitcher({
      adapters: new Map(),
      repository: {} as never,
      externalRuntime: {} as never,
      handoffs: {} as never,
      environment: { HOME: input.home },
      agentLabel: (agent) => (agent === "claude-code" ? "Claude Code" : agent),
      readSource: async (threadId) => ({
        threadId,
        agent: "claude-code",
        title: "预算表",
        cwd: "/home/ubuntu/work",
        projectId: "project-1",
        turns: [turn({ id: "a", user: "先看预算表", agent: ["看完了"], startedAt: 100 })],
        ...input.source,
      }),
      requestOfficial: async (method, params): Promise<JsonObject> => {
        requests.push({ method, params });
        if (method === "externalAgentConfig/import") {
          const session = (
            ((params.migrationItems as JsonObject[])[0]?.details as JsonObject)
              .sessions as JsonObject[]
          )[0] as JsonObject;
          written.push(await readFile(session.path as string, "utf8"));
          input.onImport?.(session, (message) => instance.observe(message));
          return { id: 1, result: { importId: "import-1" } };
        }
        if (method === "thread/read") {
          return {
            id: 2,
            result: { thread: { id: params.threadId as string, cwd: "/home/ubuntu/work" } },
          };
        }
        return { id: 3, result: {} };
      },
      registerExternalThread: () => {
        throw new Error("not used");
      },
      startExternalTurn: async () => undefined,
      notifyExternalThreadStarted: async () => undefined,
      notifyDesktop: async (message) => {
        notifications.push(message);
      },
      archiveSource: async (source) => {
        archived.push(source.threadId);
      },
      diagnose: () => undefined,
      importTimeoutMs: 1_000,
    });
    return { instance, requests, notifications, archived, written };
  }

  it("imports the history as a Codex session, keeps the project and archives the source", async () => {
    const home = await temporaryDirectory();
    const fixture = switcher({
      home,
      onImport: (session, observe) =>
        queueMicrotask(() =>
          observe({
            method: "externalAgentConfig/import/progress",
            params: {
              importId: "import-1",
              itemTypeResults: [
                {
                  itemType: "SESSIONS",
                  successes: [
                    {
                      source: session.path as string,
                      target: "codex-thread-1",
                      itemType: "SESSIONS",
                    },
                  ],
                  failures: [],
                },
              ],
            },
          }),
        ),
    });

    await expect(
      fixture.instance.switch({ threadId: "source-1", agent: "codex" }),
    ).resolves.toEqual({
      threadId: "codex-thread-1",
    });

    expect(fixture.requests.map(({ method }) => method)).toEqual([
      "externalAgentConfig/import",
      "thread/metadata/update",
      "thread/read",
    ]);
    expect(fixture.requests[1]?.params).toEqual({
      threadId: "codex-thread-1",
      projectId: "project-1",
    });
    const importParams = fixture.requests[0]?.params as JsonObject;
    const session = (
      ((importParams.migrationItems as JsonObject[])[0]?.details as JsonObject)
        .sessions as JsonObject[]
    )[0] as JsonObject;
    expect(session).toMatchObject({ cwd: "/home/ubuntu/work", title: "预算表" });
    expect(String(session.path)).toContain(
      `${path.sep}projects${path.sep}codexhost-handoff${path.sep}`,
    );
    expect(fixture.written[0]).toContain('"customTitle":"预算表"');
    expect(fixture.written[0]).toContain("先看预算表");
    // The handed-over file is gone once Codex has its own copy.
    expect(await readdir(path.join(home, ".claude", "projects", "codexhost-handoff"))).toEqual([]);
    expect(fixture.notifications).toEqual([
      expect.objectContaining({
        method: "thread/started",
        params: { thread: { id: "codex-thread-1", cwd: "/home/ubuntu/work", turns: [] } },
      }),
    ]);
    expect(fixture.archived).toEqual(["source-1"]);
  });

  it("reports a failed import and keeps the source", async () => {
    const home = await temporaryDirectory();
    const fixture = switcher({
      home,
      onImport: (session, observe) =>
        queueMicrotask(() =>
          observe({
            method: "externalAgentConfig/import/progress",
            params: {
              importId: "import-1",
              itemTypeResults: [
                {
                  itemType: "SESSIONS",
                  successes: [],
                  failures: [{ source: session.path as string, message: "failed" }],
                },
              ],
            },
          }),
        ),
    });

    await expect(fixture.instance.switch({ threadId: "source-1", agent: "codex" })).rejects.toEqual(
      new ThreadAgentSwitchError(-32076, "Codex 没能导入这段对话的历史，请稍后重试"),
    );
    expect(fixture.archived).toEqual([]);
    expect(await readdir(path.join(home, ".claude", "projects", "codexhost-handoff"))).toEqual([]);
  });

  it("refuses to switch to the Agent it already uses, or with nothing to carry", async () => {
    const home = await temporaryDirectory();
    await expect(
      switcher({ home }).instance.switch({ threadId: "source-1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      switcher({ home, source: { turns: [] } }).instance.switch({
        threadId: "source-1",
        agent: "codex",
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("needs a message to start an external Harness that is installed", async () => {
    const home = await temporaryDirectory();
    await expect(
      switcher({ home, source: { agent: "codex" } }).instance.switch({
        threadId: "source-1",
        agent: "grok",
      }),
    ).rejects.toMatchObject({ code: -32070 });
  });
});
