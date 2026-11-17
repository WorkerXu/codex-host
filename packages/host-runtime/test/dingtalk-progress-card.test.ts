import { afterEach, describe, expect, it, vi } from "vitest";
import { createDingTalkCli } from "../src/dingtalk-cli.js";
import { DingTalkProgressCard } from "../src/dingtalk-progress-card.js";

afterEach(() => vi.useRealTimers());
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
const content = (args: string[]) =>
  (JSON.parse(args[args.indexOf("--content") + 1]!) as string[]).map((message) =>
    JSON.parse(message),
  );

describe("official A2UI lifecycle with fake dws", () => {
  it("creates before work, throttles cumulative public progress, and finishes the same card with an artifact", async () => {
    vi.useFakeTimers();
    const { calls, card } = fixture();
    expect(
      await card.create({ target: { group: "group" }, atOpenDingTalkIds: ["open-member"] }),
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
    const created = content(calls[0]!);
    expect(created[0].createSurface.dataModel.answer.displayText).toBe("思考中…");
    expect(created[0].createSurface.catalogId).toBe(
      "https://dingtalk.com/card/a2ui/catalogs/public/catalog.json",
    );
    expect(
      created[1].updateComponents.components.find((c: { id: string }) => c.id === "mentions")
        .content,
    ).toContain('<a atId="open-member">');
    card.progress("已读取资料");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(content(calls[1]!)[0].updateDataModel.value).toBe("已读取资料");
    card.progress("已整理结果");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(content(calls[2]!)[0].updateDataModel.value).toBe("已读取资料\n\n已整理结果");
    expect(await card.finish("完整最终答案", true)).toBe(true);
    for (const update of calls.slice(1)) {
      expect(update).toContain("server-biz-id");
      expect(update).not.toContain("--at-open-dingtalk-ids");
      expect(JSON.stringify(content(update))).not.toContain("createSurface");
    }
    const final = calls.at(-1)!;
    expect(final).toContain("FINISH");
    expect(final).toContain("--a2ui-annotations");
    expect(content(final).at(-1).updateDataModel.value).toBe("完整最终答案");
    expect(JSON.stringify(content(final))).not.toContain("shimmer");
    card.dispose();
  });
});

it.each(["missing-id", "timeout", "rejected"])("stops after unknown creation: %s", async (mode) => {
  const sendCard = vi.fn(async () => {
    if (mode === "rejected") throw new Error("response lost");
    return { ok: mode === "missing-id", bizId: null, errorCode: mode };
  });
  const updateCard = vi.fn();
  const card = new DingTalkProgressCard({ sendCard, updateCard });
  expect(await card.create({ target: { openDingTalkId: "sender" } })).toBe(false);
  card.progress("正在读取");
  expect(await card.finish("完成", true)).toBe(false);
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
  await card.create({ target: { group: "group" } });
  card.progress("第一阶段");
  await vi.advanceTimersByTimeAsync(5_000);
  card.progress("第二阶段");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(updateCard).toHaveBeenCalledOnce();
  const finished = card.finish("最终答案", true);
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
  await card.create({ target: { group: "group" } });
  card.progress("第一阶段");
  await vi.advanceTimersByTimeAsync(5_000);
  card.progress("第二阶段");
  await vi.advanceTimersByTimeAsync(10_000);
  pending.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(updateCard).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(updateCard).toHaveBeenCalledTimes(2);
  await card.finish("处理失败：无法启动", false);
  expect(updateCard.mock.calls.at(-1)?.[0]).toMatchObject({
    flowStatus: "FINISH",
    content: "第一阶段\n\n第二阶段\n\n处理失败：无法启动",
  });
});
