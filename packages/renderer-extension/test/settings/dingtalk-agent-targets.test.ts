import { describe, expect, it } from "vitest";

import {
  dingTalkSectionsOf,
  resolveDingTalkAgentTarget,
} from "../../src/settings/dingtalk-agent-targets.js";

describe("DingTalk agent section and project discovery", () => {
  it("lists only Mac-local projects in their native section order", () => {
    const sections = dingTalkSectionsOf(
      [
        {
          id: "section-1",
          name: "AI工作台",
          itemKeys: [
            "codex:project:local-a",
            "codex:thread:local:thread-1",
            "codex:project:remote-project",
            "codex:project:local-a",
          ],
        },
        { id: "section-2", name: "验收3", itemKeys: ["codex:project:local-b"] },
        { id: "section-3", name: "空分区", itemKeys: ["codex:thread:local:thread-2"] },
      ],
      [
        { id: "local-a", label: "AI工作台", cwd: "/Users/me/AI工作台" },
        { id: "local-b", label: "验收3", cwd: "/Users/me/验收3" },
      ],
    );
    expect(sections).toEqual([
      {
        id: "section-1",
        name: "AI工作台",
        projects: [{ id: "local-a", name: "AI工作台", path: "/Users/me/AI工作台" }],
      },
      {
        id: "section-2",
        name: "验收3",
        projects: [{ id: "local-b", name: "验收3", path: "/Users/me/验收3" }],
      },
      { id: "section-3", name: "空分区", projects: [] },
    ]);
  });

  it("resolves the stored section and project, or nothing when they disappeared", () => {
    const targets = {
      available: true,
      sections: [
        {
          id: "section-1",
          name: "AI工作台",
          projects: [{ id: "local-a", name: "AI工作台", path: "/Users/me/AI工作台" }],
        },
      ],
    };
    expect(resolveDingTalkAgentTarget(targets, "section-1", "local-a")).toEqual({
      section: targets.sections[0],
      project: targets.sections[0]?.projects[0],
    });
    expect(resolveDingTalkAgentTarget(targets, "section-1", "gone")).toEqual({
      section: targets.sections[0],
      project: null,
    });
    expect(resolveDingTalkAgentTarget(targets, "gone", "local-a")).toEqual({
      section: null,
      project: null,
    });
  });
});
