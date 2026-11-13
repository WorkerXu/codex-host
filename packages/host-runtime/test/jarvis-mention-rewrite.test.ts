import { describe, expect, it } from "vitest";

import { expandJarvisMentions, jarvisMentionContextBlock } from "../src/jarvis-mention-rewrite.js";

const link = "[@Bug #928 填写序列号](jarvis://bug/4029/928)";

describe("Jarvis mention expansion", () => {
  it("returns text untouched without a Jarvis carrier", async () => {
    const detail = async () => {
      throw new Error("must not run");
    };
    expect(await expandJarvisMentions("hello", { detail })).toEqual({
      text: "hello",
      mentions: [],
    });
  });

  it("replaces the carrier, fetches details and appends a delimited block", async () => {
    const calls: unknown[] = [];
    const result = await expandJarvisMentions(`修复 ${link}`, {
      async detail(mention) {
        calls.push(mention);
        return {
          ok: true,
          data: { bug: { id: 928, bugTitle: "填写序列号", status: 1 } },
          errorCode: null,
          errorMessage: null,
        };
      },
    });
    expect(calls).toEqual([
      { kind: "bug", id: 928, projectId: 4029, label: "Bug #928 填写序列号" },
    ]);
    expect(result.text.startsWith("修复 @Bug #928 填写序列号\n\n[codexhost Jarvis]")).toBe(true);
    expect(result.text).toContain("### Bug #928 填写序列号");
    expect(result.text).toContain(
      "链接：https://jarvis.eshetang.com/bugs/form?projectId=4029&bugId=928",
    );
    expect(result.text).toContain('"bugTitle": "填写序列号"');
    expect(result.text).not.toContain("jarvis://");
  });

  it("keeps the chip text and adds a one-line failure note", async () => {
    const result = await expandJarvisMentions(link, {
      async detail() {
        return {
          ok: false,
          data: null,
          errorCode: "not_installed",
          errorMessage: "jarvis CLI is not installed",
        };
      },
    });
    expect(result.text).toContain("@Bug #928 填写序列号");
    expect(result.text).toContain("Jarvis 详情获取失败：本机未安装或未登录 jarvis CLI");
    expect(result.text).not.toContain("```json");
  });

  it("fetches multiple mentions and truncates oversized details", async () => {
    const two = `${link} [@需求 #2530 通知](jarvis://requirement/2530)`;
    const result = await expandJarvisMentions(two, {
      async detail(mention) {
        return {
          ok: true,
          data: { description: "x".repeat(30_000), id: mention.id },
          errorCode: null,
          errorMessage: null,
        };
      },
    });
    expect(result.mentions).toHaveLength(2);
    expect(result.text.match(/```json/gu)).toHaveLength(2);
    expect(result.text).toContain("详情已截断");
  });

  it("formats the context block independently of the CLI", () => {
    const block = jarvisMentionContextBlock([
      {
        mention: { kind: "task", id: 101170, label: "任务 #101170 开发" },
        data: { taskName: "开发" },
        error: null,
      },
    ]);
    expect(block).toContain("[codexhost Jarvis]");
    expect(block).toContain("链接：https://jarvis.eshetang.com/tasks/form?taskId=101170");
  });
});
