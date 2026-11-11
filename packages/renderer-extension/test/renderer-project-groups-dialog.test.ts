import type { DesktopProjectsCatalog } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  projectGroupMemberFromProject,
  projectGroupProjectHost,
  projectGroupProjectLabel,
} from "../src/renderer-project-groups-dialog.js";

const catalog: DesktopProjectsCatalog = {
  localProjects: {
    "local-alpha": { id: "local-alpha", name: "alpha", rootPaths: ["/tmp/alpha"] },
    "local-empty": { id: "local-empty", name: "empty", rootPaths: [] },
  },
  remoteProjects: [
    {
      id: "project-beta",
      hostId: "remote-ssh-discovered:beta",
      remotePath: "/srv/beta",
      label: "beta",
    },
  ],
  threadProjectAssignments: {},
  codexManagedRemoteConnections: [
    {
      hostId: "remote-ssh-discovered:beta",
      displayName: "beta-host",
      source: "discovered",
    },
  ],
  projectOrder: [],
  readAt: "2026-11-11T10:00:00.000Z",
};

describe("Project group management members", () => {
  it("snapshots local and remote project identity for the group file", () => {
    expect(projectGroupMemberFromProject("local-alpha", catalog)).toEqual({
      projectKind: "local",
      projectId: "local-alpha",
      rootPaths: ["/tmp/alpha"],
      label: "alpha",
    });
    expect(projectGroupMemberFromProject("project-beta", catalog)).toEqual({
      projectKind: "remote",
      projectId: "project-beta",
      hostId: "remote-ssh-discovered:beta",
      remotePath: "/srv/beta",
      label: "beta",
    });
    expect(projectGroupMemberFromProject("local-empty", catalog)).toBeNull();
    expect(projectGroupMemberFromProject("missing", catalog)).toBeNull();
  });

  it("labels native projects by host and display name", () => {
    expect(projectGroupProjectLabel("local-alpha", catalog)).toBe("alpha");
    expect(projectGroupProjectHost("local-alpha", catalog)).toBe("本机");
    expect(projectGroupProjectHost("project-beta", catalog)).toBe("beta-host");
  });
});
