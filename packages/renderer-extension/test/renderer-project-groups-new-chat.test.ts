import { describe, expect, it } from "vitest";

import type { ProjectGroupProjectView } from "../src/renderer-project-groups-model.js";
import { projectGroupAddMachineTargets } from "../src/renderer-project-groups-model.js";
import { newChatProjectDisabled } from "../src/renderer-project-groups-new-chat.js";

function project(
  missing: "missing" | "not-mounted" | null,
  newChatAvailable = true,
): ProjectGroupProjectView {
  return {
    project: {
      member: {
        projectKind: "local",
        projectId: "local-alpha",
        rootPaths: ["/tmp/a"],
        label: "alpha",
      },
      entry: {
        projectId: "local-alpha",
        kind: "local",
        label: "alpha",
        hostId: null,
        hostLabel: null,
        rootPaths: ["/tmp/a"],
        remotePath: null,
        native:
          missing === null
            ? {
                projectId: "local-alpha",
                label: "alpha",
                kind: "local",
                hostLabel: null,
                hasNewChatButton: newChatAvailable,
              }
            : null,
      },
      missing,
    },
    mounted: missing === null,
    newChatAvailable,
  };
}

describe("Project group new chat selection", () => {
  it("disables missing and offline projects but allows connecting clouds", () => {
    expect(newChatProjectDisabled(project(null), "connected")).toBe(false);
    expect(newChatProjectDisabled(project(null), "connecting")).toBe(false);
    expect(newChatProjectDisabled(project(null), "unknown")).toBe(false);
    expect(newChatProjectDisabled(project(null), "disconnected")).toBe(true);
    expect(newChatProjectDisabled(project(null), "error")).toBe(true);
    expect(newChatProjectDisabled(project("missing"), "connected")).toBe(true);
    expect(newChatProjectDisabled(project("not-mounted"), "connected")).toBe(true);
    expect(newChatProjectDisabled(project(null, false), "connected")).toBe(true);
  });
});

describe("Project group add-machine targets", () => {
  it("lists ready peers that are not in the group, one row per Harness", () => {
    const targets = projectGroupAddMachineTargets(
      {
        machines: [
          {
            hostId: "remote-a",
            label: "tencent",
            state: "ready",
            harnesses: [
              { id: "codex", label: "Codex" },
              { id: "claude", label: "Claude Code" },
            ],
          },
          { hostId: "remote-b", label: "offline", state: "offline", harnesses: [] },
          {
            hostId: "remote-c",
            label: "existing",
            state: "ready",
            harnesses: [{ id: "codex", label: "Codex" }],
          },
        ],
      },
      new Set(["remote-c"]),
    );
    expect(targets).toEqual([
      { hostId: "remote-a", machineLabel: "tencent", harnessId: "codex", harnessLabel: "Codex" },
      {
        hostId: "remote-a",
        machineLabel: "tencent",
        harnessId: "claude",
        harnessLabel: "Claude Code",
      },
    ]);
  });
});
