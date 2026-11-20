import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@codexhost/protocol-core";

import {
  ThreadAgentSwitcher,
  ThreadAgentSwitchError,
  type ThreadAgentSwitchSource,
} from "../src/thread-agent-switch-runner.js";
import {
  HANDOFF_BUDGET_BYTES,
  claudeSessionJsonl,
  handoffBlock,
  handoffBudgetBytes,
  handoffItemsFromTurns,
  handoffSnapshotTurns,
  selectHandoffItems,
  stripHandoffBlock,
  withoutHandoffBlock,
  type HandoffItem,
} from "../src/thread-handoff-content.js";
import { ThreadHandoffStore, type ThreadHandoffRecord } from "../src/thread-handoff-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-handoff-"));
  temporaryDirectories.push(directory);
  return directory;
}

const HANDOFF =
  '<codexhost_handoff from="claude-code" thread="t1" source="s1" items="1" omitted="0">\n[历史用户 · 消息 · 第1轮 · h1.1]\n旧请求\n</codexhost_handoff>';

function user(id: string, text: string): JsonObject {
  return { id, type: "userMessage", content: [{ type: "text", text, text_elements: [] }] };
}

function agent(id: string, text: string): JsonObject {
  return { id, type: "agentMessage", text, phase: null };
}

function turn(id: string, items: JsonObject[], extra: JsonObject = {}): JsonObject {
  return { id, status: "completed", items, startedAt: 100, completedAt: 160, ...extra };
}

function item(id: string, kind: HandoffItem["kind"], text: string, turnNumber = 1): HandoffItem {
  return {
    id,
    turn: turnNumber,
    kind,
    role: kind === "user" ? "user" : "assistant",
    status: null,
    text,
    createdAtMs: null,
  };
}

const conversation = [
  turn("a", [
    user("a-u", `${HANDOFF}\n\n先看预算表`),
    { id: "a-r", type: "reasoning", summary: ["想一想"], content: [] },
    {
      id: "a-c",
      type: "commandExecution",
      command: "ls budget",
      aggregatedOutput: "v1.xlsx\nv2.xlsx\n",
      exitCode: 0,
      status: "completed",
    },
    {
      id: "a-f",
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "budget/v3.xlsx", kind: { type: "add" }, diff: "binary" },
        { path: "budget/notes.md", kind: { type: "update", move_path: null }, diff: "@@" },
      ],
    },
    agent("a-a", "看完了，做了第三版"),
  ]),
  turn(
    "b",
    [
      user("b-u", "再跑一次测试"),
      { id: "b-p", type: "plan", text: "1. 跑测试\n2. 修失败" },
      {
        id: "b-t",
        type: "mcpToolCall",
        server: "github",
        tool: "search",
        status: "failed",
        error: { message: "限流" },
      },
      { id: "b-w", type: "webSearch", query: "xlsx 公式" },
    ],
    { status: "failed", error: { message: "模型超时" } },
  ),
  turn("c", [user("c-u", "停一下"), agent("c-a", "<EXTERNAL SESSION IMPORTED>")], {
    status: "interrupted",
  }),
];

describe("handoff items", () => {
  it("numbers the messages and the activity around them, Turn by Turn", () => {
    const items = handoffItemsFromTurns(conversation);
    expect(items.map(({ id, kind, status }) => [id, kind, status])).toEqual([
      ["h1.1", "user", null],
      ["h1.2", "command", null],
      ["h1.3", "fileChange", null],
      ["h1.4", "assistant", null],
      ["h2.1", "user", null],
      ["h2.2", "plan", null],
      ["h2.3", "tool", "failed"],
      ["h2.4", "search", null],
      ["h2.5", "error", "failed"],
      ["h3.1", "user", null],
      ["h3.2", "interrupted", "interrupted"],
    ]);
    // An earlier handoff block is not carried a second time.
    expect(items[0]?.text).toBe("先看预算表");
    expect(items[1]?.text).toBe("$ ls budget\n退出码：0\nv1.xlsx\nv2.xlsx");
    expect(items[2]?.text).toBe("- budget/v3.xlsx（新增）\n- budget/notes.md（修改）");
    expect(items[6]?.text).toBe("github.search\n错误：限流");
    expect(items[8]?.text).toBe("模型超时");
    expect(items[0]?.createdAtMs).toBe(100_000);
    expect(items[3]?.createdAtMs).toBe(160_000);
  });
});

describe("selection and the handoff block", () => {
  it("keeps the latest request and answer and the original request before older items", () => {
    const items = [
      item("h1.1", "user", "原始需求"),
      ...Array.from({ length: 30 }, (_, index) =>
        item(
          `h${index + 2}.1`,
          index % 2 ? "assistant" : "user",
          `中间 ${index} ${"字".repeat(120)}`,
          index + 2,
        ),
      ),
      item("h40.1", "user", "最新请求"),
      item("h40.2", "assistant", "最新回答"),
    ];
    const { selected, omitted } = selectHandoffItems(items, 2_000);
    const ids = selected.map(({ id }) => id);
    expect(ids).toEqual(expect.arrayContaining(["h1.1", "h40.1", "h40.2"]));
    expect(ids).toEqual(
      [...ids].sort(
        (left, right) =>
          items.findIndex((i) => i.id === left) - items.findIndex((i) => i.id === right),
      ),
    );
    expect(omitted.length).toBeGreaterThan(0);
    // Whole items only.
    for (const kept of selected)
      expect(items.find(({ id }) => id === kept.id)?.text).toBe(kept.text);
  });

  it("leaves out an item that does not fit instead of cutting it", () => {
    const items = [item("h1.1", "user", "短"), item("h1.2", "assistant", "长".repeat(5_000))];
    const { selected, omitted } = selectHandoffItems(items, 1_000);
    expect(selected.map(({ id }) => id)).toEqual(["h1.1"]);
    expect(omitted.map(({ id }) => id)).toEqual(["h1.2"]);
  });

  it("stays within its budget and says how to read what it left out", () => {
    const items = handoffItemsFromTurns(conversation);
    const tight = handoffBlock({
      fromAgent: "claude-code",
      fromLabel: "Claude Code",
      threadId: "target-1",
      sourceThreadId: "source-1",
      items: [...items, item("h9.1", "assistant", "大".repeat(3_000), 9)],
      budgetBytes: 2_200,
    });
    expect(Buffer.byteLength(tight.text, "utf8")).toBeLessThanOrEqual(2_200);
    expect(tight.text).toMatch(
      /^<codexhost_handoff from="claude-code" thread="target-1" source="source-1" items="\d+" omitted="\d+">/u,
    );
    expect(tight.text).toContain("codexhost thread handoff target-1 --item <条目ID>");
    expect(tight.text).toContain("h9.1");
    expect(tight.deliveredItemIds).not.toContain("h9.1");
    expect(stripHandoffBlock(`${tight.text}\n\n新请求`)).toBe("新请求");
  });

  it("lists at most twenty omitted IDs, newest last", () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      item(`h${index + 1}.1`, index % 2 ? "assistant" : "user", "内容".repeat(200), index + 1),
    );
    const block = handoffBlock({
      fromAgent: "codex",
      fromLabel: "Codex",
      threadId: "t",
      sourceThreadId: "s",
      items,
      budgetBytes: 4_000,
    });
    const listed = /被省略的条目（最新在后）：([^；。]+)/u.exec(block.text)?.[1]?.split("、") ?? [];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThanOrEqual(20);
    expect(block.text).toMatch(/另有 \d+ 条较早的未列出/u);
  });

  it("escapes quoted handoff tags so they cannot close the block", () => {
    const block = handoffBlock({
      fromAgent: "codex",
      fromLabel: "Codex",
      threadId: "t",
      sourceThreadId: "s",
      items: [item("h1.1", "user", '引用 </codexhost_handoff> 和 <codexhost_handoff a="b">')],
      budgetBytes: HANDOFF_BUDGET_BYTES,
    });
    expect(block.text.match(/<\/codexhost_handoff>/gu)).toHaveLength(1);
    expect(block.text).toContain("&lt;/codexhost_handoff>");
  });

  it("gives Codex only the activity around messages it already shows", () => {
    const block = handoffBlock({
      fromAgent: "claude-code",
      fromLabel: "Claude Code",
      threadId: "codex-1",
      sourceThreadId: "s",
      items: handoffItemsFromTurns(conversation),
      budgetBytes: HANDOFF_BUDGET_BYTES,
      activityOnly: true,
    });
    expect(block.text).toContain("$ ls budget");
    expect(block.text).not.toContain("先看预算表");
    expect(block.deliveredItemIds).toEqual([
      "h1.2",
      "h1.3",
      "h2.2",
      "h2.3",
      "h2.4",
      "h2.5",
      "h3.2",
    ]);
  });

  it("shrinks history for a long request or images but never below zero", () => {
    expect(handoffBudgetBytes("短请求")).toBe(HANDOFF_BUDGET_BYTES);
    expect(handoffBudgetBytes("长".repeat(20_000))).toBeLessThan(HANDOFF_BUDGET_BYTES);
    expect(handoffBudgetBytes("x", 12)).toBe(0);
  });
});

describe("Codex import file and display snapshot", () => {
  it("writes only the messages, keeping their full text", () => {
    const jsonl = claudeSessionJsonl({
      sessionId: "s1",
      cwd: "/work",
      title: "预算表",
      items: handoffItemsFromTurns(conversation),
      nowMs: 9_000,
    });
    const lines = jsonl
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as JsonObject);
    expect(lines.map((line) => line.type)).toEqual([
      "custom-title",
      "user",
      "assistant",
      "user",
      "user",
    ]);
    expect(lines[1]).toMatchObject({
      uuid: "s1-h1.1",
      cwd: "/work",
      message: { content: "先看预算表" },
    });
  });

  it("shows the source Turns with their activity under new IDs", () => {
    const long = "x".repeat(40 * 1024);
    const turns = handoffSnapshotTurns(
      [
        ...conversation,
        turn("d", [
          user("d-u", "看输出"),
          { id: "d-c", type: "commandExecution", command: "cat log", aggregatedOutput: long },
        ]),
      ],
      "handoff-t",
    );
    expect(turns.map(({ id }) => id)).toEqual([
      "handoff-t-1",
      "handoff-t-2",
      "handoff-t-3",
      "handoff-t-4",
    ]);
    const first = turns[0]?.items as JsonObject[];
    expect(first.map(({ type }) => type)).toEqual([
      "userMessage",
      "commandExecution",
      "fileChange",
      "agentMessage",
    ]);
    expect(first[0]).toMatchObject({ id: "handoff-t-1-a-u", content: [{ text: "先看预算表" }] });
    expect(turns[1]).toMatchObject({ status: "failed", error: { message: "模型超时" } });
    expect((turns[2]?.items as JsonObject[]).map(({ type }) => type)).toEqual(["userMessage"]);
    const output = ((turns[3]?.items as JsonObject[])[1]?.aggregatedOutput as string) ?? "";
    expect(output.length).toBeLessThan(long.length);
    expect(output).toContain("已截断显示");
  });

  it("hides the block in a Thread's first user message only", () => {
    const first = turn("n1", [user("u", `${HANDOFF}\n\n继续`), agent("a", "好")]);
    expect(
      ((withoutHandoffBlock(first).items as JsonObject[])[0]?.content as JsonObject[])[0],
    ).toMatchObject({
      text: "继续",
    });
    const plain = turn("n2", [user("u", "继续")]);
    expect(withoutHandoffBlock(plain)).toBe(plain);
  });
});

describe("handoff store", () => {
  function record(hostThreadId: string, sourceThreadId: string): ThreadHandoffRecord {
    return {
      formatVersion: 2,
      hostThreadId,
      sourceThreadId,
      sourceAgent: "claude-code",
      sourceTitle: "预算表",
      targetAgent: "grok",
      createdAt: new Date(0).toISOString(),
      items: handoffItemsFromTurns(conversation),
      turns: [{ id: "handoff-1" }],
      deliveredItemIds: ["h1.1"],
    };
  }

  it("finds a handoff from either end and reads items in pages and slices", async () => {
    const directory = await temporaryDirectory();
    const store = new ThreadHandoffStore(directory);
    await store.save(record("target-1", "source-1"));

    const fresh = new ThreadHandoffStore(directory);
    expect((await fresh.findBySource("source-1"))?.hostThreadId).toBe("target-1");
    const listed = await fresh.read({ threadId: "source-1", limit: 4 });
    expect(listed).toMatchObject({ threadId: "target-1", total: 11, nextCursor: "4" });
    expect((listed.items as JsonObject[])[0]).toMatchObject({
      id: "h1.1",
      kind: "user",
      delivered: true,
      preview: "先看预算表",
    });
    const next = await fresh.read({ threadId: "target-1", cursor: "8" });
    expect((next.items as JsonObject[]).map(({ id }) => id)).toEqual(["h2.5", "h3.1", "h3.2"]);
    expect(next.nextCursor).toBeNull();

    const slice = await fresh.read({ threadId: "target-1", item: "h1.2", offset: 2, maxChars: 5 });
    expect(slice).toMatchObject({ text: "ls bu", offset: 2, nextOffset: 7 });
    expect((slice.item as JsonObject).delivered).toBe(false);
    const end = await fresh.read({ threadId: "target-1", item: "h1.2", offset: 30 });
    expect(end.nextOffset).toBeNull();

    await expect(fresh.read({ threadId: "target-1", item: "h99.1" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(fresh.read({ threadId: "nobody" })).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
    });
    await fresh.remove("target-1");
    expect(await fresh.findBySource("source-1")).toBeNull();
    expect(await readdir(directory)).toEqual(["sources.json"]);
  });

  it("reads the display-only records written before items were kept", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "old-1.json"),
      JSON.stringify({
        formatVersion: 1,
        hostThreadId: "old-1",
        sourceThreadId: "s",
        sourceAgent: "pi",
        createdAt: new Date(0).toISOString(),
        turns: [turn("x", [user("u", "旧问题"), agent("a", "旧回答")])],
      }),
    );
    const store = new ThreadHandoffStore(directory);
    const upgraded = await store.load("old-1");
    expect(upgraded?.items.map(({ text }) => text)).toEqual(["旧问题", "旧回答"]);
    expect(store.cachedTurns("old-1")).toHaveLength(1);
  });
});

describe("switching to Codex", () => {
  const source: ThreadAgentSwitchSource = {
    threadId: "source-1",
    agent: "claude-code",
    title: "预算表",
    cwd: "/work",
    projectId: "project-1",
    turns: conversation,
  };

  async function fixture(options: { notify?: boolean; threadExists?: boolean } = {}) {
    const home = await temporaryDirectory();
    const handoffs = new ThreadHandoffStore(path.join(home, "handoffs"));
    const requests: { method: string; params: JsonObject }[] = [];
    const notifications: JsonObject[] = [];
    const archived: string[] = [];
    let reads = 0;
    const switcher: ThreadAgentSwitcher = new ThreadAgentSwitcher({
      adapters: new Map(),
      repository: {} as never,
      externalRuntime: {} as never,
      handoffs,
      environment: { HOME: home },
      agentLabel: (id) => (id === "claude-code" ? "Claude Code" : id),
      readSource: async () => {
        reads += 1;
        return source;
      },
      threadExists: async () => options.threadExists ?? true,
      requestOfficial: async (method, params): Promise<JsonObject> => {
        requests.push({ method, params });
        if (method === "externalAgentConfig/import") {
          const session = (
            ((params.migrationItems as JsonObject[])[0]?.details as JsonObject)
              .sessions as JsonObject[]
          )[0] as JsonObject;
          if (options.notify !== false) {
            queueMicrotask(() =>
              switcher.observe({
                method: "externalAgentConfig/import/progress",
                params: {
                  importId: "import-1",
                  itemTypeResults: [
                    {
                      itemType: "SESSIONS",
                      successes: [{ source: session.path as string, target: "codex-1" }],
                      failures: [],
                    },
                  ],
                },
              }),
            );
          }
          return { id: 1, result: { importId: "import-1" } };
        }
        if (method === "thread/list") {
          return {
            id: 2,
            result: {
              data: [
                { id: "other", cwd: "/work", name: "预算表", createdAt: 1 },
                {
                  id: "codex-1",
                  cwd: "/work",
                  name: "预算表",
                  createdAt: Math.floor(Date.now() / 1000),
                },
              ],
            },
          };
        }
        if (method === "thread/read") {
          return { id: 3, result: { thread: { id: params.threadId as string, cwd: "/work" } } };
        }
        return { id: 4, result: {} };
      },
      registerExternalThread: () => {
        throw new Error("not used");
      },
      startExternalTurn: async () => undefined,
      notifyExternalThreadStarted: async () => undefined,
      notifyDesktop: async (message) => {
        notifications.push(message);
      },
      archiveSource: async (archivedSource) => {
        archived.push(archivedSource.threadId);
      },
      diagnose: () => undefined,
      importTimeoutMs: 2_000,
      importPollAfterMs: 10,
    });
    return { switcher, requests, notifications, archived, handoffs, home, reads: () => reads };
  }

  it("imports the messages, gives Codex the activity and keeps the whole history readable", async () => {
    const run = await fixture();
    await expect(run.switcher.switch({ threadId: "source-1", agent: "codex" })).resolves.toEqual({
      threadId: "codex-1",
    });
    expect(run.requests.map(({ method }) => method)).toEqual([
      "externalAgentConfig/import",
      "thread/metadata/update",
      "thread/resume",
      "thread/inject_items",
      "thread/read",
    ]);
    const injected = (
      ((run.requests[3]?.params.items as JsonObject[])[0]?.content as JsonObject[])[0] as JsonObject
    ).text as string;
    expect(injected).toMatch(
      /^<codexhost_handoff from="claude-code" thread="codex-1" source="source-1"/u,
    );
    expect(injected).toContain("$ ls budget");
    expect(injected).not.toContain("先看预算表");
    const saved = await run.handoffs.findBySource("source-1");
    expect(saved).toMatchObject({ hostThreadId: "codex-1", targetAgent: "codex", turns: [] });
    expect(saved?.items).toHaveLength(11);
    expect(run.notifications).toEqual([expect.objectContaining({ method: "thread/started" })]);
    expect(run.archived).toEqual(["source-1"]);
    expect(await readdir(path.join(run.home, ".claude", "projects", "codexhost-handoff"))).toEqual(
      [],
    );
  });

  it("finds the imported Thread itself when Codex's notification never arrives", async () => {
    const run = await fixture({ notify: false });
    await expect(run.switcher.switch({ threadId: "source-1", agent: "codex" })).resolves.toEqual({
      threadId: "codex-1",
    });
    expect(run.requests.some(({ method }) => method === "thread/list")).toBe(true);
  });

  it("answers a retry with the Thread the first switch made", async () => {
    const run = await fixture();
    await run.switcher.switch({ threadId: "source-1", agent: "codex" });
    const imports = () =>
      run.requests.filter(({ method }) => method === "externalAgentConfig/import");
    await expect(run.switcher.switch({ threadId: "source-1", agent: "codex" })).resolves.toEqual({
      threadId: "codex-1",
    });
    expect(imports()).toHaveLength(1);
  });

  it("switches again when the Thread from the earlier switch is gone", async () => {
    const run = await fixture({ threadExists: false });
    await run.switcher.switch({ threadId: "source-1", agent: "codex" });
    await run.switcher.switch({ threadId: "source-1", agent: "codex" });
    expect(run.reads()).toBe(2);
  });

  it("shares one switch between concurrent identical requests and refuses a different Agent", async () => {
    const run = await fixture();
    const first = run.switcher.switch({ threadId: "source-1", agent: "codex" });
    const second = run.switcher.switch({ threadId: "source-1", agent: "codex" });
    await expect(run.switcher.switch({ threadId: "source-1", agent: "grok" })).rejects.toEqual(
      new ThreadAgentSwitchError(-32072, "这段对话正在切换，请稍候"),
    );
    expect(await second).toEqual(await first);
    expect(run.reads()).toBe(1);
  });

  it("refuses the Agent it already uses, or a conversation with no request", async () => {
    const run = await fixture();
    await expect(
      run.switcher.switch({ threadId: "source-1", agent: "claude-code" }),
    ).rejects.toMatchObject({
      code: -32602,
    });
    const stored = await readFile(path.join(run.home, "handoffs", "sources.json"), "utf8").catch(
      () => "",
    );
    expect(stored).toBe("");
  });
});
