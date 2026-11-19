import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexAgentRecord,
  type DingTalkAgentDispatch,
  type DingTalkConversation,
  type DingTalkDispatchSettings,
  type DingTalkMessage,
} from "@codexhost/shared-contracts";
import { createDingTalkCli, parseMessages } from "../src/dingtalk-cli.js";
import { DingTalkDispatcher, type DingTalkDispatchService } from "../src/dingtalk-dispatcher.js";
import { DingTalkDispatchSettingsStore } from "../src/dingtalk-dispatch-settings.js";
import { DingTalkDispatchStateStore } from "../src/dingtalk-dispatch-state.js";

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

const fixtureMessages = (name: string): DingTalkMessage[] =>
  parseMessages(
    JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<
      string,
      unknown
    >,
    null,
  );

const conversation: DingTalkConversation = {
  conversationId: "cid-fixture",
  title: "技术群",
  singleChat: false,
  unreadCount: 0,
  lastMessageAt: null,
  muted: false,
};

function settingsWith(overrides: Record<string, DingTalkAgentDispatch> = {}) {
  return {
    agents: {
      "qa.toml": {
        enabled: true,
        replyScope: "group" as const,
        sectionId: "section-1",
        projectId: "project-1",
        projectPath: "/Users/me/project",
        projectRoots: ["/Users/me/project"],
      },
      "bare.toml": {
        enabled: true,
        replyScope: "group" as const,
        sectionId: null,
        projectId: null,
        projectPath: null,
        projectRoots: [],
      },
      "off.toml": {
        enabled: false,
        replyScope: "group" as const,
        sectionId: "section-1",
        projectId: "project-1",
        projectPath: "/Users/me/project",
        projectRoots: ["/Users/me/project"],
      },
      ...overrides,
    },
  } satisfies DingTalkDispatchSettings;
}

async function setup(
  options: {
    settings?: DingTalkDispatchSettings;
    missingKey?: boolean;
    messages?: DingTalkMessage[];
    cardFails?: boolean;
    updateFails?: boolean;
    runFails?: boolean;
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dispatch-"));
  directories.push(directory);
  const settings = new DingTalkDispatchSettingsStore({ homeDirectory: directory });
  const state = new DingTalkDispatchStateStore({ homeDirectory: directory });
  await settings.write(options.settings ?? settingsWith());
  const commands: string[][] = [];
  const cli = createDingTalkCli({
    runImpl: async (args) => {
      commands.push([...args]);
      const error =
        (options.cardFails && args[2] === "send-a2ui-card") ||
        (options.updateFails && args[2] === "update-a2ui-card");
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
  const messages = options.messages ?? [];
  const service: DingTalkDispatchService = {
    status: async () => ({
      installed: true,
      authenticated: true,
      userName: "我",
      userId: "self",
      corpName: null,
      defaultHost: "local",
      defaultHostId: null,
      errorCode: null,
    }),
    message: vi.fn(async (_conversationId: string, messageId: string) => {
      return messages.find((message) => message.messageId === messageId) ?? null;
    }),
    messages: vi.fn(async (input: { conversationId: string; limit: number; before?: number }) => ({
      conversation,
      messages: messages
        .filter((message) => input.before === undefined || message.createdAt < input.before)
        .slice()
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(-input.limit)
        .reverse(),
    })),
    send: (input) => cli.send(input.conversationId, input.text, input),
    sendDirect: cli.sendDirect,
    sendCard: cli.sendCard,
    updateCard: cli.updateCard,
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
  let started = 0;
  const startThread = vi.fn(
    async (input: {
      cwd: string;
      projectId: string | null;
      projectRoots: readonly string[];
      title: string;
      prompt: string;
    }): Promise<{
      threadId: string;
      turnId: string;
      completed: typeof finish.promise;
    }> => {
      void input;
      started += 1;
      if (options.runFails) throw new Error("无法启动");
      return {
        threadId: `thread-${started}`,
        turnId: "turn-1",
        completed: finish.promise,
      };
    },
  );
  const dispatcher = new DingTalkDispatcher({
    service,
    settings,
    state,
    agents: { read: async (file) => agent(file) },
    matcher,
    startThread,
    now: () => 1000,
  });
  disposers.push(() => dispatcher.dispose());
  await dispatcher.start();
  return {
    dispatcher,
    state,
    settings,
    service,
    commands,
    matcher,
    startThread,
    finish: async () => {
      finish.resolve({ answer: "# 答案", status: "completed", errorMessage: null });
      await vi.waitFor(async () =>
        expect(
          Object.values(await state.status()).some((value) => value.result === "replied"),
        ).toBe(true),
      );
    },
  };
}

describe("DingTalk manual dispatch", () => {
  it("scores every enabled agent once from the message text and sorts high to low", async () => {
    const messages = fixtureMessages("dingtalk-message-list-single.json");
    const target = messages[0];
    if (!target) throw new Error("fixture target missing");
    const f = await setup({ messages });
    const result = await f.dispatcher.score(conversation.conversationId, target.messageId);
    expect(f.matcher.scoreDingTalkCandidates).toHaveBeenCalledOnce();
    expect(f.matcher.scoreDingTalkCandidates.mock.calls[0]?.[0]).toBe(target.text);
    expect(f.matcher.scoreDingTalkCandidates.mock.calls[0]?.[1].map((a) => a.fileName)).toEqual([
      "bare.toml",
      "qa.toml",
    ]);
    expect(result.failed).toBe(false);
    expect(result.agents.map(({ agent }) => agent.fileName)).toEqual(["qa.toml", "bare.toml"]);
    expect(result.agents[0]?.score).toBe(0.95);
    expect(result.agents[0]?.agent.ready).toBe(true);
    expect(result.agents[1]?.agent.ready).toBe(false);
  });

  it("returns the list by name with null scores when scoring fails", async () => {
    const messages = fixtureMessages("dingtalk-message-list-single.json");
    const target = messages[0];
    if (!target) throw new Error("fixture target missing");
    const f = await setup({ messages, missingKey: true });
    const result = await f.dispatcher.score(conversation.conversationId, target.messageId);
    expect(result.failed).toBe(true);
    expect(result.agents.map(({ agent }) => agent.name)).toEqual(["bare", "qa"]);
    expect(result.agents.every(({ score }) => score === null)).toBe(true);
  });

  it("runs the unchanged dispatch flow once per checked agent under its project", async () => {
    const messages = fixtureMessages("dingtalk-message-list-context.json");
    const target = messages[0];
    if (!target) throw new Error("fixture target missing");
    const f = await setup({ messages });
    const result = await f.dispatcher.run(conversation.conversationId, target.messageId, [
      "qa.toml",
      "bare.toml",
      "off.toml",
    ]);
    expect(f.startThread).toHaveBeenCalledOnce();
    const input = f.startThread.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      cwd: "/Users/me/project",
      projectId: "project-1",
      projectRoots: ["/Users/me/project"],
    });
    expect(input?.title.startsWith("qa · 技术群 · ")).toBe(true);
    expect(input?.prompt).toContain("触发：手动派发");
    expect(input?.prompt).toContain("最近 30 条上下文");
    expect(input?.prompt).toContain("回复位置：原群聊（@发送人）");
    const byFile = Object.fromEntries(result.results.map((entry) => [entry.fileName, entry]));
    expect(byFile["qa.toml"]?.threadId).toBe("thread-1");
    expect(byFile["bare.toml"]?.error).toBe("需要设置分区和工作项目");
    expect(byFile["off.toml"]?.error).toBe("智能体未启用");
    await f.finish();
    expect((await f.state.status())["qa.toml"]).toMatchObject({
      result: "replied",
      detail: "技术群",
    });
    expect((await f.state.status())["qa.toml"]?.detail).not.toContain("阈值");
    expect(f.commands[0]).toEqual(
      expect.arrayContaining([
        "send-a2ui-card",
        "--conversation-id",
        conversation.conversationId,
        "--yes",
      ]),
    );
  });

  it("does not dispatch anything from the event stream", async () => {
    const messages = fixtureMessages("dingtalk-message-list-single.json");
    const f = await setup({ messages });
    expect(f.service.message).not.toHaveBeenCalled();
    expect(f.startThread).not.toHaveBeenCalled();
    expect(f.service.setListeningHold).toHaveBeenCalledWith(true);
  });

  it("records a card creation failure without starting a Thread", async () => {
    const messages = fixtureMessages("dingtalk-message-list-single.json");
    const target = messages[0];
    if (!target) throw new Error("fixture target missing");
    const f = await setup({ messages, cardFails: true });
    const result = await f.dispatcher.run(conversation.conversationId, target.messageId, [
      "qa.toml",
    ]);
    expect(result.results[0]?.threadId).toBeNull();
    expect(result.results[0]?.error).toContain("进度卡创建未确认");
    expect(f.startThread).not.toHaveBeenCalled();
    expect((await f.state.status())["qa.toml"]?.result).toBe("failed");
  });

  it("reports a start failure in the card and status", async () => {
    const messages = fixtureMessages("dingtalk-message-list-single.json");
    const target = messages[0];
    if (!target) throw new Error("fixture target missing");
    const f = await setup({ messages, runFails: true });
    const result = await f.dispatcher.run(conversation.conversationId, target.messageId, [
      "qa.toml",
    ]);
    expect(result.results[0]?.error).toBe("处理失败：无法启动");
    expect(f.commands.at(-1)).toEqual(expect.arrayContaining(["--flow-status", "FINISH"]));
    expect((await f.state.status())["qa.toml"]?.result).toBe("failed");
  });

  it("returns per-agent errors when the message is no longer available", async () => {
    const f = await setup();
    const result = await f.dispatcher.run("cid-fixture", "missing", ["qa.toml"]);
    expect(result.results[0]?.error).toBe("无法读取这条消息，未派发");
    expect(f.startThread).not.toHaveBeenCalled();
  });
});
