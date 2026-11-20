import { afterEach, describe, expect, it, vi } from "vitest";
import type { DingTalkCardState } from "../src/dingtalk-a2ui.js";
import { createDingTalkCli } from "../src/dingtalk-cli.js";
import { DingTalkProgressCard } from "../src/dingtalk-progress-card.js";

afterEach(() => vi.useRealTimers());

interface Component {
  id: string;
  component: string;
  [key: string]: unknown;
}

const LOADING_LIGHT =
  "https://g.alicdn.com/dingding/card_a2ui/0.1.1/img/loading-circular/loading_circular_light.DlX94S3.gif";

function fixture() {
  const calls: string[][] = [];
  const cli = createDingTalkCli({
    runImpl: async (args) => {
      calls.push([...args]);
      return {
        value: { bizId: "server-biz-id" },
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        errorCode: null,
        errorMessage: null,
      };
    },
  });
  return { calls, card: new DingTalkProgressCard(cli) };
}

interface WireMessage {
  createSurface?: { dataModel: { answer: { displayText: string } } };
  updateComponents?: { components: Component[] };
  updateDataModel?: { value: string };
}

function messages(args: string[]): WireMessage[] {
  return (JSON.parse(args[args.indexOf("--content") + 1] ?? "null") as string[]).map(
    (message) => JSON.parse(message) as WireMessage,
  );
}

function components(args: string[]): Component[] {
  return messages(args).flatMap((message) => message.updateComponents?.components ?? []);
}

function component(args: string[], id: string): Component | undefined {
  return components(args).find((entry) => entry.id === id);
}

function stateOf(update: { state: DingTalkCardState }): DingTalkCardState {
  return update.state;
}

describe("official A2UI lifecycle with fake dws", () => {
  it("starts expanded with the context step, throttles real steps and reveals the answer outside", async () => {
    vi.useFakeTimers();
    const { calls, card } = fixture();
    expect(
      await card.create(
        {
          target: { group: "group" },
          atOpenDingTalkIds: ["open-member"],
          atNames: { "open-member": "徐涛" },
        },
        {
          id: "context",
          kind: "context",
          title: "读取会话上下文",
          detail: "最多 30 条更早消息",
          status: "running",
        },
      ),
    ).toBe(true);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "send-a2ui-card",
        "--conversation-id",
        "group",
        "--summary",
        "任务进度与结果",
        "--at-open-dingtalk-ids",
        "open-member",
      ]),
    );
    expect(messages(calls[0] ?? [])[0]?.createSurface?.dataModel.answer.displayText).toBe("");
    expect(component(calls[0] ?? [], "mentions")?.content).toContain(
      '<a atId="open-member">徐涛</a>',
    );
    expect(component(calls[0] ?? [], "executionPanel")).toMatchObject({
      title: "[AIGenerating]正在读取上下文…",
      textEffect: "shimmer",
      defaultExpanded: true,
      children: ["executionTimeline"],
    });
    expect(component(calls[0] ?? [], "step_1")).toMatchObject({
      icon: LOADING_LIGHT,
      title: "读取会话上下文",
    });
    expect(component(calls[0] ?? [], "root")?.children).toEqual(["mentions", "executionPanel"]);

    // The Host really reads the context before the Turn starts.
    card.contextRead(3);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(component(calls[1] ?? [], "step_1")).toMatchObject({ icon: "Check_L_outlined" });
    expect(component(calls[1] ?? [], "step_1_detail")?.text).toBe("已读取 3 条更早消息");
    expect(component(calls[1] ?? [], "executionPanel")?.title).toBe(
      "[AIGenerating]正在启动智能体…",
    );
    expect(component(calls[1] ?? [], "executionPanel")?.defaultExpanded).toBeUndefined();

    // A burst of tool steps coalesces into one write per five seconds.
    card.progress({
      type: "step",
      step: {
        id: "item:cmd-1",
        kind: "command",
        title: "执行命令",
        detail: "dws chat message list --limit 5",
        status: "running",
      },
    });
    card.progress({
      type: "step",
      step: {
        id: "item:tool-1",
        kind: "tool",
        title: "调用工具",
        detail: "dws · chat_message_list",
        status: "running",
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(3);
    expect(component(calls[2] ?? [], "executionTimeline")?.children).toEqual([
      "step_1",
      "step_2",
      "step_3",
    ]);
    expect(component(calls[2] ?? [], "step_2")).toMatchObject({ icon: LOADING_LIGHT });

    card.progress({
      type: "step",
      step: {
        id: "item:cmd-1",
        kind: "command",
        title: "执行命令",
        detail: "dws chat message list --limit 5",
        status: "failed",
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(component(calls[3] ?? [], "step_2")).toMatchObject({ icon: "Error_L_outlined" });

    expect(await card.finish("completed", "完整最终答案")).toBe(true);
    for (const update of calls.slice(1)) {
      expect(update).toContain("server-biz-id");
      expect(update).not.toContain("--at-open-dingtalk-ids");
      expect(JSON.stringify(messages(update))).not.toContain("createSurface");
    }
    const final = calls.at(-1) ?? [];
    expect(final).toContain("FINISH");
    expect(final).toContain("--a2ui-annotations");
    expect(component(final, "executionPanel")).toMatchObject({ title: "已完成 · 3 步" });
    expect(component(final, "executionPanel")?.textEffect).toBeUndefined();
    expect(component(final, "root")?.children).toEqual(["mentions", "executionPanel", "answer"]);
    expect(component(final, "answer")).toMatchObject({
      component: "Markdown",
      content: { path: "/answer/displayText" },
    });
    expect(messages(final)[1]?.updateDataModel?.value).toBe("完整最终答案");
    // The failed command keeps its error marker; running steps end with a check.
    expect(component(final, "step_2")?.icon).toBe("Error_L_outlined");
    expect(component(final, "step_3")?.icon).toBe("Check_L_outlined");
    card.dispose();
  });

  it("sends a failed run with a Chinese reason outside the panel", async () => {
    const { calls, card } = fixture();
    await card.create(
      { target: { openDingTalkId: "sender" } },
      {
        id: "context",
        kind: "context",
        title: "读取会话上下文",
        detail: "最多 30 条更早消息",
        status: "running",
      },
    );
    expect(await card.finish("failed", "处理失败：智能体处理失败，请在 Desktop 查看对话")).toBe(
      true,
    );
    const final = calls.at(-1) ?? [];
    expect(component(final, "executionPanel")).toMatchObject({ title: "处理失败" });
    expect(component(final, "executionPanel")?.textEffect).toBeUndefined();
    expect(component(final, "step_1")?.icon).toBeUndefined();
    expect(component(final, "root")?.children).toEqual(["executionPanel", "answer"]);
    expect(messages(final)[1]?.updateDataModel?.value).toBe(
      "处理失败：智能体处理失败，请在 Desktop 查看对话",
    );
    expect(JSON.stringify(messages(final))).not.toContain("shimmer");
  });

  it("sends a cancelled run with its own title and no success checks", async () => {
    const { calls, card } = fixture();
    await card.create(
      { target: { group: "group" } },
      {
        id: "context",
        kind: "context",
        title: "读取会话上下文",
        detail: "最多 30 条更早消息",
        status: "running",
      },
    );
    card.contextRead(0);
    await card.finish("cancelled", "处理已中断，可重新派发");
    const final = calls.at(-1) ?? [];
    expect(component(final, "executionPanel")?.title).toBe("已取消");
    expect(component(final, "root")?.children).toEqual(["executionPanel", "answer"]);
    expect(component(final, "step_1")?.icon).toBe("Check_L_outlined");
    expect(messages(final)[1]?.updateDataModel?.value).toBe("处理已中断，可重新派发");
  });
});

it.each(["missing-id", "timeout", "rejected"])("stops after unknown creation: %s", async (mode) => {
  const sendCard = vi.fn(async () => {
    if (mode === "rejected") throw new Error("response lost");
    return { ok: mode === "missing-id", bizId: null, errorCode: mode };
  });
  const updateCard = vi.fn();
  const card = new DingTalkProgressCard({ sendCard, updateCard });
  expect(
    await card.create(
      { target: { openDingTalkId: "sender" } },
      {
        id: "context",
        kind: "context",
        title: "读取会话上下文",
        detail: "最多 30 条更早消息",
        status: "running",
      },
    ),
  ).toBe(false);
  card.progress({
    type: "step",
    step: { id: "item:1", kind: "command", title: "执行命令", detail: "ls", status: "running" },
  });
  expect(await card.finish("completed", "完成")).toBe(false);
  expect(sendCard).toHaveBeenCalledOnce();
  expect(updateCard).not.toHaveBeenCalled();
});

it("waits for each update and stops writes after a response is lost", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<{ ok: boolean }>();
  const updateCard = vi.fn(() => pending.promise);
  const card = new DingTalkProgressCard({
    sendCard: async () => ({ ok: true, bizId: "real-id", errorCode: null }),
    updateCard,
  });
  await card.create(
    { target: { group: "group" } },
    {
      id: "context",
      kind: "context",
      title: "读取会话上下文",
      detail: "最多 30 条更早消息",
      status: "running",
    },
  );
  card.progress({
    type: "step",
    step: { id: "item:1", kind: "command", title: "执行命令", detail: "ls", status: "running" },
  });
  await vi.advanceTimersByTimeAsync(5_000);
  card.progress({
    type: "step",
    step: { id: "item:2", kind: "command", title: "执行命令", detail: "pwd", status: "running" },
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(updateCard).toHaveBeenCalledOnce();
  const finished = card.finish("completed", "最终答案");
  pending.reject(new Error("unknown update result"));
  expect(await finished).toBe(false);
  expect(updateCard).toHaveBeenCalledOnce();
});

it("keeps at least five seconds between progress writes even after a slow response", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<{ ok: boolean }>();
  const updateCard = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue({ ok: true });
  const card = new DingTalkProgressCard({
    sendCard: async () => ({ ok: true, bizId: "real-id", errorCode: null }),
    updateCard,
  });
  await card.create(
    { target: { group: "group" } },
    {
      id: "context",
      kind: "context",
      title: "读取会话上下文",
      detail: "最多 30 条更早消息",
      status: "running",
    },
  );
  card.progress({
    type: "step",
    step: { id: "item:1", kind: "command", title: "执行命令", detail: "ls", status: "running" },
  });
  await vi.advanceTimersByTimeAsync(5_000);
  card.progress({
    type: "step",
    step: { id: "item:2", kind: "command", title: "执行命令", detail: "pwd", status: "running" },
  });
  await vi.advanceTimersByTimeAsync(10_000);
  pending.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(updateCard).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(updateCard).toHaveBeenCalledTimes(2);
  await card.finish("failed", "处理失败：无法启动");
  expect(stateOf(updateCard.mock.calls.at(-1)?.[0])).toMatchObject({
    phase: "failed",
    answer: "处理失败：无法启动",
  });
  expect(updateCard.mock.calls.at(-1)?.[0].flowStatus).toBe("FINISH");
});
