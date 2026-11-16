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
    expect(jarvisMentionPath({ kind: "bug", id: 928, projectId: 4029 })).toBe(
      "jarvis://bug/4029/928",
    );
  });

  it("rejects ids that are not positive safe integers", () => {
    expect(() => jarvisMentionPath({ kind: "bug", id: 0, projectId: 4029 })).toThrow(
      /Invalid Jarvis/u,
    );
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
    expect(formatJarvisMentionLink({ kind: "bug", id: 3, projectId: 1, label: "a [b](c)\n" })).toBe(
      "[@a b c](jarvis://bug/1/3)",
    );
  });

  it("strips bug links, restores readable labels and deduplicates mentions", () => {
    const bug = formatJarvisMentionLink({
      kind: "bug",
      id: 928,
      projectId: 4029,
      label: "Bug #928 填写序列号",
    });
    const other = formatJarvisMentionLink({
      kind: "bug",
      id: 929,
      projectId: 4029,
      label: "Bug #929 查码日志",
    });
    const result = stripJarvisMentions(`修复 ${bug} 和 ${other}，再看 ${bug}`);
    expect(result.text).toBe(
      "修复 @Bug #928 填写序列号 和 @Bug #929 查码日志，再看 @Bug #928 填写序列号",
    );
    expect(result.mentions).toEqual([
      { kind: "bug", id: 928, projectId: 4029, label: "Bug #928 填写序列号" },
      { kind: "bug", id: 929, projectId: 4029, label: "Bug #929 查码日志" },
    ]);
  });

  it("leaves non-bug and malformed links untouched", () => {
    const text = [
      "[@x](subagent://codexhost.claude-code)",
      "[@y](jarvis://bug/4029)",
      "[@z](jarvis://task/101170)",
      "[@p](jarvis://project/4029)",
      "[@r](jarvis://requirement/2530)",
    ].join(" ");
    expect(stripJarvisMentions(text)).toEqual({ text, mentions: [] });
  });

  it("accepts the angle-bracket form Desktop may serialize", () => {
    const result = stripJarvisMentions("[@Bug](<jarvis://bug/1/2>)");
    expect(result.mentions).toEqual([{ kind: "bug", id: 2, projectId: 1, label: "Bug" }]);
  });
});
