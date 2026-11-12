import { describe, expect, it } from "vitest";

import {
  rewriteDelegationMentionInput,
  rewriteDelegationMentionText,
} from "../src/delegation-mention-rewrite.js";

const skill = {
  name: "codexhost-delegation",
  path: "/home/u/.agents/skills/codexhost-delegation/SKILL.md",
};
const link = "[@Claude Code](subagent://codexhost.claude-code)";

describe("delegation mention rewrite", () => {
  it("forwards native input untouched without a carrier", () => {
    expect(rewriteDelegationMentionInput([{ type: "text", text: "hello" }], skill)).toBeNull();
  });

  it("replaces the carrier, adds an explicit instruction and the native Skill item", () => {
    const image = { type: "localImage", path: "/tmp/a.png" };
    const rewritten = rewriteDelegationMentionInput(
      [{ type: "text", text: `${link} review this change` }, image],
      skill,
    );
    expect(rewritten).toHaveLength(3);
    const [text, second, third] = rewritten ?? [];
    expect(second).toEqual(image);
    expect(third).toEqual({ type: "skill", ...skill });
    const body = (text as { text: string }).text;
    expect(body.startsWith("@Claude Code review this change\n\n[codexhost delegation]")).toBe(true);
    expect(body).toContain("Harness `claude-code`");
    expect(body).not.toContain("subagent://");
  });

  it("falls back to the text instruction when the managed Skill is unavailable", () => {
    const rewritten = rewriteDelegationMentionInput([{ type: "text", text: link }], null);
    expect(rewritten).toHaveLength(1);
    expect((rewritten?.[0] as { text: string }).text).toMatch(
      /^@Claude Code\n\n\[codexhost delegation\]/u,
    );
  });

  it("does not attach the Skill twice", () => {
    const rewritten = rewriteDelegationMentionInput(
      [
        { type: "text", text: link },
        { type: "skill", ...skill },
      ],
      skill,
    );
    expect(rewritten?.filter((item) => (item as { type: string }).type === "skill")).toHaveLength(
      1,
    );
  });

  it("rewrites External Harness text", () => {
    const text = rewriteDelegationMentionText(`${link} fix the test`);
    expect(text).toContain("@Claude Code fix the test");
    expect(text).toContain(
      'codexhost delegate start --harness claude-code --task-name "<short-name>" --task "<task>" --watch true --format compact',
    );
    expect(text).toContain("do not run `--help` or `peer list` first");
    expect(text).toContain("Keep `--watch true`");
    expect(text).not.toContain("--host");
    expect(rewriteDelegationMentionText("plain")).toBe("plain");
  });

  it("includes the machine and a complete --host command for a remote mention", () => {
    const remote =
      "[@Grok](subagent://codexhost.grok?host=oracle-sg) and [@Claude Code](subagent://codexhost.claude-code)";
    const text = rewriteDelegationMentionText(remote);
    expect(text).toContain("@Grok on machine `oracle-sg`");
    expect(text).toContain("Harness `grok`, pass `--host oracle-sg`");
    expect(text).toContain("@Claude Code (Harness `claude-code`)");
    expect(text).toContain(
      'codexhost delegate start --harness grok --host oracle-sg --task-name "<short-name>" --task "<task>" --watch true --format compact',
    );
    expect(text).toContain(
      'codexhost delegate start --harness claude-code --task-name "<short-name>" --task "<task>" --watch true --format compact',
    );
  });
});
