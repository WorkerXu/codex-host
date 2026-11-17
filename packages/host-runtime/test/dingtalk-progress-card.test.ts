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
