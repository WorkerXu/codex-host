import { describe, expect, it } from "vitest";

import { formatJarvisMentionLink, jarvisMentionPath, stripJarvisMentions } from "../src/jarvis.js";

describe("Jarvis mention carrier", () => {
  it("formats every kind with its stable path", () => {
    expect(jarvisMentionPath({ kind: "bug", id: 928, projectId: 4029 })).toBe(
      "jarvis://bug/4029/928",
    );
    expect(jarvisMentionPath({ kind: "requirement", id: 2530 })).toBe("jarvis://requirement/2530");
    expect(jarvisMentionPath({ kind: "task", id: 101170 })).toBe("jarvis://task/101170");
    expect(jarvisMentionPath({ kind: "project", id: 4029 })).toBe("jarvis://project/4029");
  });

  it("rejects ids that are not positive safe integers", () => {
    expect(() => jarvisMentionPath({ kind: "project", id: 0 })).toThrow(/Invalid Jarvis/u);
    expect(() => jarvisMentionPath({ kind: "bug", id: 1 })).toThrow(/project id/u);
  });

  it("formats a Markdown link with a sanitized label", () => {
    expect(
      formatJarvisMentionLink({
        kind: "bug",
        id: 928,
        projectId: 4029,
        label: "Bug #928 填写已查码的序列号…",
      }),
    ).toBe("[@Bug #928 填写已查码的序列号…](jarvis://bug/4029/928)");
    expect(formatJarvisMentionLink({ kind: "task", id: 3, label: "a [b](c)\n" })).toBe(
      "[@a b c](jarvis://task/3)",
    );
  });

  it("strips links, restores readable labels and deduplicates mentions", () => {
    const bug = formatJarvisMentionLink({
      kind: "bug",
      id: 928,
      projectId: 4029,
      label: "Bug #928 填写序列号",
    });
    const requirement = formatJarvisMentionLink({
      kind: "requirement",
      id: 2530,
      label: "需求 #2530 用户通知",
    });
    const result = stripJarvisMentions(`修复 ${bug} 和 ${requirement}，再看 ${bug}`);
    expect(result.text).toBe(
      "修复 @Bug #928 填写序列号 和 @需求 #2530 用户通知，再看 @Bug #928 填写序列号",
    );
    expect(result.mentions).toEqual([
      { kind: "bug", id: 928, projectId: 4029, label: "Bug #928 填写序列号" },
      { kind: "requirement", id: 2530, label: "需求 #2530 用户通知" },
    ]);
  });

  it("leaves unrelated links and malformed bug paths untouched", () => {
    const text = "[@x](subagent://codexhost.claude-code) [@y](jarvis://bug/4029)";
    expect(stripJarvisMentions(text)).toEqual({ text, mentions: [] });
  });

  it("accepts the angle-bracket form Desktop may serialize", () => {
    const result = stripJarvisMentions("[@Bug](<jarvis://bug/1/2>)");
    expect(result.mentions).toEqual([{ kind: "bug", id: 2, projectId: 1, label: "Bug" }]);
  });
});
