import { describe, expect, it } from "vitest";

import {
  JARVIS_KINDS,
  formatJarvisMentionLink,
  jarvisMentionPath,
  stripJarvisMentions,
} from "../src/jarvis.js";

describe("Jarvis mention carrier", () => {
  it("keeps the carrier kind set closed to bugs", () => {
    expect(JARVIS_KINDS).toEqual(["bug"]);
  });

  it("formats the bug path", () => {
    expect(jarvisMentionPath({ kind: "bug", id: 9101, projectId: 9001 })).toBe(
      "jarvis://bug/9001/9101",
    );
  });

  it("rejects ids that are not positive safe integers", () => {
    expect(() => jarvisMentionPath({ kind: "bug", id: 0, projectId: 9001 })).toThrow(
      /Invalid Jarvis/u,
    );
    expect(() => jarvisMentionPath({ kind: "bug", id: 1 })).toThrow(/project id/u);
  });

  it("formats a Markdown link with a sanitized label", () => {
    expect(
      formatJarvisMentionLink({
        kind: "bug",
        id: 9101,
        projectId: 9001,
        label: "Bug #9101 示例：列表页加载失败…",
      }),
    ).toBe("[@Bug #9101 示例：列表页加载失败…](jarvis://bug/9001/9101)");
    expect(formatJarvisMentionLink({ kind: "bug", id: 3, projectId: 1, label: "a [b](c)\n" })).toBe(
      "[@a b c](jarvis://bug/1/3)",
    );
  });

  it("strips bug links, restores readable labels and deduplicates mentions", () => {
    const bug = formatJarvisMentionLink({
      kind: "bug",
      id: 9101,
      projectId: 9001,
      label: "Bug #9101 示例：列表页加载失败",
    });
    const other = formatJarvisMentionLink({
      kind: "bug",
      id: 9102,
      projectId: 9001,
      label: "Bug #9102 示例：日志页异常",
    });
    const result = stripJarvisMentions(`修复 ${bug} 和 ${other}，再看 ${bug}`);
    expect(result.text).toBe(
      "修复 @Bug #9101 示例：列表页加载失败 和 @Bug #9102 示例：日志页异常，再看 @Bug #9101 示例：列表页加载失败",
    );
    expect(result.mentions).toEqual([
      { kind: "bug", id: 9101, projectId: 9001, label: "Bug #9101 示例：列表页加载失败" },
      { kind: "bug", id: 9102, projectId: 9001, label: "Bug #9102 示例：日志页异常" },
    ]);
  });

  it("leaves non-bug and malformed links untouched", () => {
    const text = [
      "[@x](subagent://codexhost.claude-code)",
      "[@y](jarvis://bug/9001)",
      "[@z](jarvis://task/101170)",
      "[@p](jarvis://project/9001)",
      "[@r](jarvis://requirement/2530)",
    ].join(" ");
    expect(stripJarvisMentions(text)).toEqual({ text, mentions: [] });
  });

  it("accepts the angle-bracket form Desktop may serialize", () => {
    const result = stripJarvisMentions("[@Bug](<jarvis://bug/1/2>)");
    expect(result.mentions).toEqual([{ kind: "bug", id: 2, projectId: 1, label: "Bug" }]);
  });
});
