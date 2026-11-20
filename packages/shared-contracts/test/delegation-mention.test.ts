import { describe, expect, it } from "vitest";

import {
  delegationMentionPath,
  delegationMentionReferences,
  formatDelegationMentionLink,
  harnessCommandMentionPath,
  restoreHarnessCommandMentions,
  stripDelegationMentions,
} from "../src/index.js";

describe("delegation mention carrier", () => {
  it("formats a Desktop-restorable agent mention link", () => {
    expect(formatDelegationMentionLink({ harnessId: "claude-code", label: "Claude Code" })).toBe(
      "[@Claude Code](subagent://codexhost.claude-code)",
    );
    expect(
      formatDelegationMentionLink({ harnessId: "cursor-cli", label: "Cursor CLI (Experimental)" }),
    ).toBe("[@Cursor CLI Experimental](subagent://codexhost.cursor-cli)");
  });

  it("rejects Harness ids that would break the carrier", () => {
    expect(() => delegationMentionPath("bad id")).toThrow();
    expect(() => delegationMentionPath("../x")).toThrow();
  });

  it("strips carriers into readable mentions without duplicates", () => {
    const result = stripDelegationMentions(
      "[@Claude Code](subagent://codexhost.claude-code) review, then [@Grok](subagent://codexhost.grok) and [@Claude Code](subagent://codexhost.claude-code)",
    );
    expect(result.text).toBe("@Claude Code review, then @Grok and @Claude Code");
    expect(result.mentions).toEqual([
      { harnessId: "claude-code", label: "Claude Code" },
      { harnessId: "grok", label: "Grok" },
    ]);
  });

  it("leaves native custom agent roles and plain text alone", () => {
    const text = "[@reviewer](subagent://reviewer) and #claude";
    expect(stripDelegationMentions(text)).toEqual({ text, mentions: [] });
  });

  it("keeps local and peer targets of the same Harness distinct", () => {
    const peer = { harnessId: "claude-code", label: "Claude Code · Mac", hostId: "remote-ssh:mac" };
    const carrier = formatDelegationMentionLink(peer);
    expect(carrier).toBe(
      "[@Claude Code · Mac](subagent://codexhost.claude-code?host=remote-ssh%3Amac)",
    );
    expect(
      stripDelegationMentions(
        `${carrier} [@Claude Code](subagent://codexhost.claude-code) ${carrier}`,
      ),
    ).toEqual({
      text: "@Claude Code · Mac @Claude Code @Claude Code · Mac",
      mentions: [peer, { harnessId: "claude-code", label: "Claude Code" }],
    });
  });

  it("escapes parentheses and exposes the decoded target at the Web text offsets", () => {
    const mention = { harnessId: "codex", label: "Codex · Mac", hostId: "remote-ssh:mac(work)" };
    const carrier = formatDelegationMentionLink(mention);
    const text = `ask ${carrier} now`;
    expect(carrier).toBe(
      "[@Codex · Mac](subagent://codexhost.codex?host=remote-ssh%3Amac%28work%29)",
    );
    expect(delegationMentionReferences(text)).toEqual([
      { start: 4, end: 4 + carrier.length, text: carrier, mention },
    ]);
    expect(stripDelegationMentions(text)).toEqual({
      text: "ask @Codex · Mac now",
      mentions: [mention],
    });
  });

  it.each(["", "mac;echo", "mac work", "x".repeat(257)])(
    "rejects invalid Host IDs when formatting a carrier (%s)",
    (hostId) => {
      expect(() => delegationMentionPath("codex", hostId)).toThrow(
        "Invalid delegation mention Host ID",
      );
    },
  );

  it.each(["%ZZ", "mac%3Becho", "%20", "mac(work"])(
    "does not dispatch a malformed peer carrier (%s)",
    (host) => {
      const text = `[@Codex](subagent://codexhost.codex?host=${host})`;
      expect(stripDelegationMentions(text)).toEqual({ text, mentions: [] });
    },
  );
});

describe("Harness command carrier", () => {
  const link = (invocation: string) => `[@${invocation}](${harnessCommandMentionPath(invocation)})`;

  it("encodes invocations into a Desktop-restorable path", () => {
    expect(harnessCommandMentionPath("/review")).toBe("subagent://codexhost-command.review");
    expect(harnessCommandMentionPath("/frontend-design:frontend-design")).toBe(
      "subagent://codexhost-command.frontend-design%3Afrontend-design",
    );
    expect(harnessCommandMentionPath("/a(b)")).toBe("subagent://codexhost-command.a%28b%29");
    expect(() => harnessCommandMentionPath("/two words")).toThrow();
  });

  it("restores the chip as a leading command with the remaining text as arguments", () => {
    expect(restoreHarnessCommandMentions(`${link("/review")} PR 42`)).toBe("/review PR 42");
    expect(restoreHarnessCommandMentions(`${link("$build")} check  tests`)).toBe(
      "$build check  tests",
    );
    expect(restoreHarnessCommandMentions(`please ${link("/eli5")}  quantum`)).toBe(
      "/eli5 please quantum",
    );
    expect(restoreHarnessCommandMentions(link("/frontend-design:frontend-design"))).toBe(
      "/frontend-design:frontend-design",
    );
    expect(restoreHarnessCommandMentions(`${link("/a")} x ${link("/b")}`)).toBe("/a x");
  });

  it("preserves internal spaces, tabs and code indentation in command arguments", () => {
    const argumentsText = "Review this:\n    const x =  1;\n\treturn x;\nname\t\tvalue";
    expect(restoreHarnessCommandMentions(`${link("/review")} ${argumentsText}`)).toBe(
      `/review ${argumentsText}`,
    );
    expect(
      restoreHarnessCommandMentions(`keep  these\tcolumns ${link("/review")}  and  these`),
    ).toBe("/review keep  these\tcolumns and  these");
    expect(
      restoreHarnessCommandMentions(
        `${link("/review")} first  block ${link("/other")} next\t\tblock`,
      ),
    ).toBe("/review first  block next\t\tblock");
  });

  it("leaves text without a command chip unchanged", () => {
    const text = "[@Claude Code](subagent://codexhost.claude-code) /usage";
    expect(restoreHarnessCommandMentions(text)).toBe(text);
    expect(stripDelegationMentions(`${link("/review")}`).mentions).toEqual([]);
  });
});

it("round-trips a peer or Desktop Host ID separately from the display label", () => {
  const mention = {
    harnessId: "claude-code",
    hostId: "remote-ssh-discovered:oracle-main",
    label: "Claude Code",
  };
  expect(stripDelegationMentions(formatDelegationMentionLink(mention))).toEqual({
    text: "@Claude Code",
    mentions: [mention],
  });
});
