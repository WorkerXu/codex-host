import { describe, expect, it } from "vitest";

import {
  desktopProjectsCatalogSchema,
  projectGroupsFileSchema,
  projectGroupsReplaceParamsSchema,
} from "../src/project-groups.js";

const localMember = {
  projectKind: "local" as const,
  projectId: "local-alpha",
  rootPaths: ["/Users/test/alpha"],
  label: "alpha",
};

const remoteMember = {
  projectKind: "remote" as const,
  projectId: "project-beta",
  hostId: "remote-ssh-discovered:beta",
  remotePath: "/srv/beta",
  label: "beta",
};

const group = {
  id: "5e5f0a4d-24bd-4af8-9e8e-2e7f2f8d4a1b",
  name: "Cross-host",
  order: 0,
  collapsed: false,
  members: [localMember, remoteMember],
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
};

describe("project group contracts", () => {
  it("accepts a group file and replacement payload", () => {
    const file = { formatVersion: 1 as const, revision: 2, groups: [group] };
    expect(projectGroupsFileSchema.parse(file)).toEqual(file);
    expect(projectGroupsReplaceParamsSchema.parse({ revision: 2, groups: [group] })).toEqual({
      revision: 2,
      groups: [group],
    });
  });

  it("rejects a project that belongs to more than one group", () => {
    const second = {
      ...group,
      id: "7f2e0d9b-1f20-4d4c-9d1f-8e6a4c3b2a10",
      name: "Second",
      order: 1,
    };
    expect(() =>
      projectGroupsReplaceParamsSchema.parse({ revision: 0, groups: [group, second] }),
    ).toThrow(/only one group/);
  });

  it("rejects duplicate group IDs", () => {
    expect(() =>
      projectGroupsReplaceParamsSchema.parse({
        revision: 0,
        groups: [group, { ...group, name: "Duplicate", order: 1 }],
      }),
    ).toThrow(/unique/);
  });

  it("projects only the Desktop fields used by the companion", () => {
    const catalog = desktopProjectsCatalogSchema.parse({
      localProjects: {
        alpha: { id: "local-alpha", name: "alpha", rootPaths: ["/Users/test/alpha"] },
      },
      remoteProjects: [
        {
          id: "project-beta",
          hostId: "remote-ssh-discovered:beta",
          remotePath: "/srv/beta",
          label: "beta",
        },
      ],
      threadProjectAssignments: {
        "thread-1": { projectKind: "remote", projectId: "project-beta" },
      },
      codexManagedRemoteConnections: [
        { hostId: "remote-ssh-discovered:beta", displayName: "beta", source: "discovered" },
      ],
      projectOrder: ["local-alpha", "project-beta"],
      readAt: "2026-11-11T10:00:00.000Z",
    });
    expect(catalog.remoteProjects[0]?.hostId).toBe("remote-ssh-discovered:beta");
  });
});
