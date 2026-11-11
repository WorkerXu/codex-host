import { describe, expect, it } from "vitest";

import type { ProjectGroupProjectView } from "../src/renderer-project-groups-model.js";
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
        native: {
          projectId: "local-alpha",
          label: "alpha",
          kind: "local",
          hostLabel: null,
          collapsed: false,
          hasList: true,
          hasShowAllToggle: false,
          hasNewChatButton: true,
          showAll: false,
        },
      },
      missing,
    },
    threads: [],
    collapsed: false,
    hasList: true,
    hasShowAllToggle: false,
    newChatAvailable,
    showAll: false,
    canShowAll: false,
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
