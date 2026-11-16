import { describe, expect, it } from "vitest";

import { expandJarvisMentions, jarvisMentionContextBlock } from "../src/jarvis-mention-rewrite.js";

const link = "[@Bug #9101 示例：列表页加载失败](jarvis://bug/9001/9101)";

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
          data: { bug: { id: 9101, bugTitle: "示例：列表页加载失败", status: 1 } },
          errorCode: null,
          errorMessage: null,
        };
      },
    });
    expect(calls).toEqual([
      { kind: "bug", id: 9101, projectId: 9001, label: "Bug #9101 示例：列表页加载失败" },
    ]);
    expect(
      result.text.startsWith("修复 @Bug #9101 示例：列表页加载失败\n\n[codexhost Jarvis]"),
    ).toBe(true);
    expect(result.text).toContain("### Bug #9101 示例：列表页加载失败");
    expect(result.text).toContain(
      "链接：https://jarvis.eshetang.com/bugs/form?projectId=9001&bugId=9101",
    );
    expect(result.text).toContain('"bugTitle": "示例：列表页加载失败"');
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
    expect(result.text).toContain("@Bug #9101 示例：列表页加载失败");
    expect(result.text).toContain("Jarvis 详情获取失败：本机未安装或未登录 jarvis CLI");
    expect(result.text).not.toContain("```json");
  });

  it("fetches multiple bugs and truncates oversized details", async () => {
    const two = `${link} [@Bug #9102 通知](jarvis://bug/9001/9102)`;
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

  it("leaves non-bug carriers untouched", async () => {
    const text = "[@任务 #1 开发](jarvis://task/101170) [@项目 #2](jarvis://project/9001)";
    expect(
      await expandJarvisMentions(text, {
        detail: async () => ({ ok: true, data: {}, errorCode: null, errorMessage: null }),
      }),
    ).toEqual({
      text,
      mentions: [],
    });
  });

  it("formats the context block independently of the CLI", () => {
    const block = jarvisMentionContextBlock([
      {
        mention: { kind: "bug", id: 9101, projectId: 9001, label: "Bug #9101 序列号" },
        data: { bugTitle: "示例：列表页加载失败" },
        error: null,
      },
    ]);
    expect(block).toContain("[codexhost Jarvis]");
    expect(block).toContain(
      "链接：https://jarvis.eshetang.com/bugs/form?projectId=9001&bugId=9101",
    );
    expect(block).toContain("类型：Bug，ID：9101，项目：9001");
  });
});
