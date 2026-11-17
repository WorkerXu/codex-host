import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultDingTalkAgentDispatch,
  type CodexAgentRecord,
  type DingTalkDispatchSettings,
} from "@codexhost/shared-contracts";
import { createDingTalkCli, parseDwsEventLine, type DwsEventRecord } from "../src/dingtalk-cli.js";
import { DingTalkDispatcher, type DingTalkDispatchService } from "../src/dingtalk-dispatcher.js";
import { DingTalkDispatchSettingsStore } from "../src/dingtalk-dispatch-settings.js";
import { DingTalkDispatchStateStore } from "../src/dingtalk-dispatch-state.js";
import type { DingTalkDispatchThreadInput } from "../src/dingtalk-dispatch-types.js";

const directories: string[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
  disposers.splice(0).forEach((dispose) => dispose());
  await Promise.all(
    directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })),
  );
});
const agent = (fileName: string): CodexAgentRecord => ({
  fileName,
  name: fileName.replace(".toml", ""),
  description: "查询技术知识库回答问题",
  developerInstructions: "查询本地知识库",
  model: "gpt-test",
  reasoningEffort: "high",
  revision: "1",
});
const event = (overrides: Partial<DwsEventRecord> = {}): DwsEventRecord => ({
  messageId: "m1",
  conversationId: "group-1",
  senderName: "林晓",
  senderId: "open-sender",
  text: "@我 接口如何实现？",
  createdAt: 2000,
  kind: "group",
  atMe: true,
  atAll: false,
  ...overrides,
});

async function setup(
  options: {
    settings?: DingTalkDispatchSettings;
    missingKey?: boolean;
    cardFails?: boolean;
    updateFails?: boolean;
    runFails?: boolean;
    approvals?: boolean;
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dispatch-"));
  directories.push(directory);
  const settings = new DingTalkDispatchSettingsStore({ homeDirectory: directory });
  const state = new DingTalkDispatchStateStore({ homeDirectory: directory });
  await settings.write(
    options.settings ?? {
      threshold: 0.85,
      agents: { "qa.toml": { ...defaultDingTalkAgentDispatch(), enabled: true } },
    },
  );
  const commands: string[][] = [];
  const cli = createDingTalkCli({
    runImpl: async (args) => {
      commands.push([...args]);
      const error =
        (options.cardFails && args[1] === "+messages-send-card") ||
        (options.updateFails && args[1] === "+messages-update-card");
      return {
        value: { bizId: "card-1" },
        exitCode: error ? 1 : 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        errorCode: error ? "failed" : null,
        errorMessage: null,
      };
    },
  });
  let listener: ((event: DwsEventRecord) => void) | null = null;
  const service: DingTalkDispatchService = {
    status: async () => ({
      installed: true,
      authenticated: true,
      userName: "我",
      userId: "self",
      corpName: null,
      defaultHost: "tencent",
      defaultHostId: null,
      errorCode: null,
    }),
    selfOpenDingTalkId: async () => "open-self",
    messages: vi.fn(async () => ({
      conversation: {
        conversationId: "group-1",
        title: "技术群",
        singleChat: false,
        unreadCount: 0,
        lastMessageAt: null,
        muted: false,
      },
      messages: [],
    })),
    send: (input) => cli.send(input.conversationId, input.text, input),
    sendDirect: cli.sendDirect,
    sendCard: cli.sendCard,
    updateCard: cli.updateCard,
    pendingApprovals: async () => ({
      approvals: options.approvals
        ? [
            {
              taskId: "task-1",
              processInstanceId: "process-1",
              title: "采购申请",
              originatorName: "林晓",
              originatorId: "sender",
              formMessage: "服务器采购",
              createdAt: 2000,
              url: null,
            },
          ]
        : [],
    }),
    subscribeEvents: (callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    startListening: vi.fn(async () => undefined),
    setListeningHold: vi.fn(),
  };
  const matcher = {
    scoreDingTalkCandidates: vi.fn(
      async (_text: string, candidates: readonly { fileName: string }[]) => ({
        available: !options.missingKey,
        scores: Object.fromEntries(
          candidates.map((candidate, index) => [
            candidate.fileName,
            index === 0 ? 0.85 : index === 1 ? 0.95 : 0.84,
          ]),
        ),
        errorCode: options.missingKey ? "missing_key" : null,
      }),
    ),
  };
  const finish = Promise.withResolvers<{
    answer: string;
    status: "completed" | "failed";
    errorMessage: string | null;
  }>();
  const startThread = vi.fn<
    (
      input: DingTalkDispatchThreadInput,
    ) => Promise<{ threadId: string; turnId: string; completed: typeof finish.promise }>
  >(async () => {
    if (options.runFails) throw new Error("无法启动");
    return { threadId: "thread-1", turnId: "turn-1", completed: finish.promise };
  });
  const dispatcher = new DingTalkDispatcher({
    service,
    settings,
    state,
    agents: { read: async (file) => agent(file) },
    matcher,
    startThread,
    projectDirectory: path.join(directory, "钉钉智能体"),
    now: () => 1000,
  });
  disposers.push(() => dispatcher.dispose());
  await dispatcher.start();
  return {
    dispatcher,
    state,
    directory,
    settings,
    service,
    commands,
    matcher,
    startThread,
    emit: (input = event()) => listener?.(input),
    finish: async () => {
      finish.resolve({
        answer: "# 答案\n\n第一步\n第二步",
        status: "completed",
        errorMessage: null,
      });
      await vi.waitFor(async () =>
        expect(
          Object.values(await state.status()).some((value) => value.result === "replied"),
        ).toBe(true),
      );
    },
  };
}

describe("DingTalk dispatch runtime (fake dws only)", () => {
  it("drives a normalized event through one match, native task and in-place card completion", async () => {
    const f = await setup();
    const normalized = parseDwsEventLine(
      JSON.stringify({
        type: "user_im_message_receive_group_all",
        message_id: "m1",
        conversation_id: "group-1",
        sender: "林晓",
        sender_open_dingtalk_id: "open-sender",
        content: "@我 接口如何实现？",
        event_time: 2000,
        at_me: true,
      }),
    );
    if (!normalized) throw new Error("Invalid event fixture");
    f.emit(normalized);
    await vi.waitFor(() => expect(f.startThread).toHaveBeenCalledOnce());
    expect(f.matcher.scoreDingTalkCandidates).toHaveBeenCalledOnce();
    expect(f.startThread.mock.calls[0]?.[0]).toMatchObject({
      title: "qa · 技术群 · @我 接口如何实现？",
      model: "gpt-test",
      reasoningEffort: "high",
    });
    expect(f.startThread.mock.calls[0]?.[0].prompt).toContain("回复位置：原群聊");
    expect(f.commands[0]).toEqual(
      expect.arrayContaining([
        "+messages-send-card",
        "--group",
        "group-1",
        "--at-open-dingtalk-ids",
        "open-sender",
        "--yes",
      ]),
    );
    await f.finish();
    await vi.waitFor(async () =>
      expect((await f.state.status())["qa.toml"]?.result).toBe("replied"),
    );
    const updates = f.commands.filter((args) => args[1] === "+messages-update-card");
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)).toEqual(
      expect.arrayContaining([
        "--biz-id",
        "card-1",
        "--content",
        "# 答案\n\n第一步\n第二步",
        "--flow-status",
        "3",
      ]),
    );
  });

  it.each([
    { kind: "group" as const, scope: "direct" as const },
    { kind: "direct" as const, scope: "group" as const },
  ])("routes $kind/$scope to the exact sender private chat", async ({ kind, scope }) => {
    const f = await setup({
      settings: {
        threshold: 0.85,
        agents: {
          "qa.toml": { ...defaultDingTalkAgentDispatch(), enabled: true, replyScope: scope },
        },
      },
    });
    f.emit(event({ kind, atMe: kind === "group" }));
    await vi.waitFor(() => expect(f.startThread).toHaveBeenCalledOnce());
    expect(f.commands[0]).toContain("--receiver-open-dingtalk-id");
    expect(f.commands[0]).toContain("open-sender");
    expect(f.commands[0]).not.toContain("--group");
    await f.finish();
  });

  it("filters disabled agents/types and dispatches every score >= .85 concurrently", async () => {
    const cfg = defaultDingTalkAgentDispatch();
    const f = await setup({
      settings: {
        threshold: 0.85,
        agents: {
          "a.toml": { ...cfg, enabled: true },
          "b.toml": { ...cfg, enabled: true },
          "low.toml": { ...cfg, enabled: true },
          "off.toml": cfg,
          "wrong.toml": { ...cfg, enabled: true, eventTypes: ["approval_pending"] },
        },
      },
    });
    f.emit();
    await vi.waitFor(() => expect(f.startThread).toHaveBeenCalledTimes(2));
    expect(f.matcher.scoreDingTalkCandidates).toHaveBeenCalledTimes(1);
    expect(f.matcher.scoreDingTalkCandidates.mock.calls[0]?.[1].map((a) => a.fileName)).toEqual([
      "a.toml",
      "b.toml",
      "low.toml",
    ]);
    expect((await f.state.status())["low.toml"]?.detail).toContain("低于阈值");
    await f.finish();
  });

  it("ignores old, self, bot, unaddressed and duplicated messages; persists dedupe", async () => {
    const f = await setup();
    for (const ignored of [
      event({ createdAt: 999 }),
      event({ senderName: "我" }),
      event({ mine: true }),
      event({ bot: true }),
      event({ atMe: false }),
    ])
      f.emit(ignored);
    f.emit();
    f.emit();
    await vi.waitFor(() => expect(f.startThread).toHaveBeenCalledOnce());
    expect(f.matcher.scoreDingTalkCandidates).toHaveBeenCalledOnce();
    expect(
      await new DingTalkDispatchStateStore({ homeDirectory: f.directory }).isProcessed("m1"),
    ).toBe(true);
    await f.finish();
    f.dispatcher.dispose();
    f.emit(event({ messageId: "after-dispose" }));
    expect(f.service.setListeningHold).toHaveBeenLastCalledWith(false);
  });

  it("records a missing key and never sends or runs anything", async () => {
    const f = await setup({ missingKey: true });
    f.emit();
    await vi.waitFor(async () =>
      expect((await f.state.status())["qa.toml"]?.detail).toBe("未配置 Gemini，未派发"),
    );
    expect(f.startThread).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  });

  it.each([{ cardFails: true }, { updateFails: true }])(
    "falls back to markdown if cards fail: %o",
    async (failure) => {
      const f = await setup(failure);
      f.emit();
      await vi.waitFor(() => expect(f.startThread).toHaveBeenCalledOnce());
      await f.finish();
      await vi.waitFor(async () =>
        expect((await f.state.status())["qa.toml"]?.result).toBe("replied"),
      );
      expect(f.commands.at(-1)).toEqual(
        expect.arrayContaining([
          "chat",
          "message",
          "send",
          "--conversation-id",
          "group-1",
          "--yes",
        ]),
      );
      expect(f.commands.at(-1)?.join(" ")).toContain("# 答案\n\n第一步");
    },
  );

  it("puts startup failure in the card", async () => {
    const f = await setup({ runFails: true });
    f.emit();
    await vi.waitFor(async () =>
      expect((await f.state.status())["qa.toml"]?.result).toBe("failed"),
    );
    expect(f.commands.at(-1)).toEqual(
      expect.arrayContaining(["处理失败：无法启动", "--flow-status", "5"]),
    );
  });

  it("summarizes approval data with tools disabled and only a private progress card to self", async () => {
    const f = await setup({ approvals: true });
    await vi.waitFor(() => expect(f.startThread).toHaveBeenCalledOnce());
    expect(f.startThread.mock.calls[0]?.[0].readOnlySummary).toBe(true);
    expect(f.startThread.mock.calls[0]?.[0].prompt).toContain("采购申请");
    expect(f.commands[0]).toContain("open-self");
    await f.finish();
    await vi.waitFor(async () =>
      expect((await f.state.status())["qa.toml"]?.result).toBe("replied"),
    );
    expect(f.commands.every((args) => args[0] === "chat")).toBe(true);
  });

  it("resets listener start on re-enable, keeping persisted processed ids", async () => {
    const f = await setup();
    await f.state.setListeningSince(1);
    f.dispatcher.dispose();
    const next = new DingTalkDispatcher({
      service: f.service,
      settings: f.settings,
      state: new DingTalkDispatchStateStore({ homeDirectory: f.directory }),
      agents: { read: async (file) => agent(file) },
      matcher: f.matcher,
      startThread: f.startThread,
      now: () => 5000,
    });
    disposers.push(() => next.dispose());
    await next.start();
    expect(
      await f.state
        .read()
        .then(() =>
          new DingTalkDispatchStateStore({ homeDirectory: f.directory }).listeningSince(),
        ),
    ).toBe(5000);
  });
});
