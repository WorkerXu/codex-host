import { describe, expect, it } from "vitest";

import {
  delegationMentionPathForTarget,
  delegationUnavailableReason,
  filterDelegationCommands,
  filterDelegationTargets,
  findDelegationTrigger,
  groupDelegationTargets,
  harnessCommandDisplayName,
} from "../src/renderer-delegation-mention.js";

describe("delegation mention trigger", () => {
  it("detects # at a word start before the caret", () => {
    expect(findDelegationTrigger("#")).toEqual({ query: "", start: 0 });
    expect(findDelegationTrigger("please #cla")).toEqual({ query: "cla", start: 7 });
  });

  it("ignores # inside words, issue numbers and finished tokens", () => {
    expect(findDelegationTrigger("a#cla")).toBeNull();
    expect(findDelegationTrigger("fix #123")).toBeNull();
    expect(findDelegationTrigger("#claude ")).toBeNull();
  });
});

describe("delegation target filtering", () => {
  const targets = [
    { agent: "codex", label: "Codex" },
    { agent: "claude-code", label: "Claude Code" },
    { agent: "omp", label: "Oh My Pi" },
  ] as const;

  it("prefers prefix matches over substring matches", () => {
    expect(filterDelegationTargets(targets, "c").map(({ agent }) => agent)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(filterDelegationTargets(targets, "pi").map(({ agent }) => agent)).toEqual(["omp"]);
    expect(filterDelegationTargets(targets, "")).toHaveLength(3);
    expect(filterDelegationTargets(targets, "zzz")).toEqual([]);
  });

  it("matches a machine name and keeps its Harnesses together", () => {
    const remote = [
      { agent: "grok", label: "Grok", hostId: "oracle-sg", hostLabel: "oracle-sg" },
      {
        agent: "claude-code",
        label: "Claude Code",
        hostId: "colab",
        hostLabel: "colab",
        disabledReason: "Machine is unreachable",
      },
    ];
    expect(filterDelegationTargets(remote, "oracle").map(({ agent }) => agent)).toEqual(["grok"]);
    expect(filterDelegationTargets(remote, "colab").map(({ agent }) => agent)).toEqual([
      "claude-code",
    ]);
    expect(groupDelegationTargets([...targets, ...remote])).toMatchObject([
      { targets: [{ agent: "codex" }, { agent: "claude-code" }, { agent: "omp" }] },
      { label: "oracle-sg", targets: [{ agent: "grok" }] },
      { label: "colab", targets: [{ agent: "claude-code" }] },
    ]);
  });

  it("generates a host-qualified path for a remote target", () => {
    expect(
      delegationMentionPathForTarget({
        agent: "grok",
        label: "Grok",
        hostId: "oracle-sg",
      }),
    ).toBe("subagent://codexhost.grok?host=oracle-sg");
    expect(delegationMentionPathForTarget({ agent: "grok", label: "Grok" })).toBe(
      "subagent://codexhost.grok",
    );
  });

  it("hides raw English errors behind a short localized reason", () => {
    expect(delegationUnavailableReason("Peer 'colab' timed out", "zh-CN")).toBe("连接超时");
    expect(delegationUnavailableReason("Peer 'colab' command failed", "zh-CN")).toBe("连接失败");
    expect(delegationUnavailableReason(undefined, "en")).toBe("Connection failed");
  });
});

describe("delegation command filtering", () => {
  const commands = [
    { id: "compact", invocation: "/compact", label: "Compact", argumentMode: "text" },
    { id: "init", invocation: "/init", label: "Init", argumentMode: "none" },
    { id: "recap", invocation: "/recap", label: "Session recap", argumentMode: "none" },
  ] as unknown as Parameters<typeof filterDelegationCommands>[0];

  it("matches invocations with or without the slash and labels", () => {
    expect(filterDelegationCommands(commands, "").map(({ id }) => id)).toEqual([
      "compact",
      "init",
      "recap",
    ]);
    expect(filterDelegationCommands(commands, "/in").map(({ id }) => id)).toEqual(["init"]);
    expect(filterDelegationCommands(commands, "session").map(({ id }) => id)).toEqual(["recap"]);
    expect(filterDelegationCommands(commands, "c").map(({ id }) => id)).toEqual([
      "compact",
      "recap",
    ]);
  });
});

describe("Harness command display names", () => {
  it("humanizes slugs and keeps readable labels", () => {
    expect(harnessCommandDisplayName("/skill:writing-for-agents")).toBe("Writing For Agents");
    expect(harnessCommandDisplayName("frontend-design:frontend-design")).toBe("Frontend Design");
    expect(harnessCommandDisplayName("code_review")).toBe("Code Review");
    expect(harnessCommandDisplayName("Initialize CLAUDE.md")).toBe("Initialize CLAUDE.md");
    expect(harnessCommandDisplayName("压缩上下文")).toBe("压缩上下文");
  });
});
