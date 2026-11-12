import { describe, expect, it } from "vitest";

import {
  desktopProjectsCatalogSchema,
  projectMirrorRecordSchema,
  projectMirrorsFileSchema,
  projectMirrorUpsertParamsSchema,
} from "../src/index.js";

const record = {
  hostId: "remote-ssh-discovered:colab",
  remoteProjectId: "0b0d55f6-9b60-4a5b-8ac8-86d3f0bd1a8c",
  remotePath: "/root/Documents/ChatGPT/demo",
  label: "demo",
  createdAt: "2026-11-12T03:00:00.000Z",
  updatedAt: "2026-11-12T03:00:00.000Z",
};

describe("Project mirror contracts", () => {
  it("accepts a revisioned registry with one acknowledged source", () => {
    expect(
      projectMirrorsFileSchema.parse({
        formatVersion: 1,
        revision: 2,
        projects: { "local-alpha": record },
        acknowledged: { "local-alpha": true },
      }),
    ).toMatchObject({ revision: 2, acknowledged: { "local-alpha": true } });
  });

  it("rejects incomplete mirror records", () => {
    expect(projectMirrorRecordSchema.safeParse({ ...record, remotePath: "" }).success).toBe(false);
    expect(projectMirrorRecordSchema.safeParse({ ...record, extra: true }).success).toBe(false);
  });

  it("allows acknowledge-only and removal updates", () => {
    expect(
      projectMirrorUpsertParamsSchema.parse({ revision: 0, sourceProjectId: "local-alpha" }),
    ).toEqual({ revision: 0, sourceProjectId: "local-alpha" });
    expect(
      projectMirrorUpsertParamsSchema.parse({
        revision: 1,
        sourceProjectId: "local-alpha",
        acknowledge: true,
        record: null,
      }),
    ).toMatchObject({ acknowledge: true, record: null });
  });

  it("keeps catalog fields optional for older Hosts", () => {
    const catalog = desktopProjectsCatalogSchema.parse({
      localProjects: {},
      remoteProjects: [],
      threadProjectAssignments: {},
      codexManagedRemoteConnections: [],
      projectOrder: [],
      readAt: "2026-11-12T03:00:00.000Z",
    });
    expect(catalog.selectedProject).toBeUndefined();
    expect(catalog.defaultProjectParent).toBeUndefined();
  });

  it("accepts the local host shape used by the companion", () => {
    const catalog = desktopProjectsCatalogSchema.parse({
      localProjects: {
        "local-alpha": { id: "local-alpha", name: "alpha", rootPaths: ["/Users/test/alpha"] },
      },
      remoteProjects: [],
      threadProjectAssignments: {},
      codexManagedRemoteConnections: [],
      projectOrder: ["local-alpha"],
      selectedProject: { type: "local", projectId: "local-alpha" },
      homeDirectory: "/Users/test",
      defaultProjectParent: "/Users/test/Documents/ChatGPT",
      readAt: "2026-11-12T03:00:00.000Z",
    });
    expect(catalog.selectedProject).toEqual({ type: "local", projectId: "local-alpha" });
  });
});
