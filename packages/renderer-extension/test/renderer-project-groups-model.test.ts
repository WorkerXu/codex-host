import type { DesktopProjectsCatalog, ProjectGroup } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  buildProjectGroupViews,
  buildProjectIndex,
  mergeMachineState,
  projectGroupMachineSummary,
  projectHostKey,
  worseConnectionState,
  type NativeProjectSnapshot,
  type ThreadSnapshot,
} from "../src/renderer-project-groups-model.js";

const catalog: DesktopProjectsCatalog = {
  localProjects: {
    "local-alpha": { id: "local-alpha", name: "alpha", rootPaths: ["/Users/test/alpha"] },
  },
  remoteProjects: [
    {
      id: "project-beta",
      hostId: "remote-ssh-discovered:beta",
      remotePath: "/srv/beta",
      label: "beta",
    },
    {
      id: "project-gamma",
      hostId: "remote-ssh-discovered:beta",
      remotePath: "/srv/gamma",
      label: "gamma",
    },
  ],
  threadProjectAssignments: {},
  codexManagedRemoteConnections: [
    {
      hostId: "remote-ssh-discovered:beta",
      displayName: "beta-host",
      alias: "beta",
      source: "discovered",
    },
  ],
  projectOrder: ["local-alpha", "project-beta", "project-gamma"],
  readAt: "2026-11-11T10:00:00.000Z",
};

function group(): ProjectGroup {
  return {
    id: "5e5f0a4d-24bd-4af8-9e8e-2e7f2f8d4a1b",
    name: "Cross-host",
    order: 0,
    collapsed: false,
    members: [
      {
        projectKind: "local",
        projectId: "local-alpha",
        rootPaths: ["/Users/test/alpha"],
        label: "alpha",
      },
      {
        projectKind: "remote",
        projectId: "project-beta",
        hostId: "remote-ssh-discovered:beta",
        remotePath: "/srv/beta",
        label: "beta",
      },
      {
        projectKind: "remote",
        projectId: "project-gamma",
        hostId: "remote-ssh-discovered:beta",
        remotePath: "/srv/gamma",
        label: "gamma",
      },
    ],
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
  };
}

const snapshots: NativeProjectSnapshot[] = [
  {
    projectId: "local-alpha",
    label: "alpha",
    kind: "local",
    hostLabel: null,
    collapsed: false,
    hasList: true,
    hasShowAllToggle: false,
    showAll: false,
  },
  {
    projectId: "project-beta",
    label: "beta",
    kind: "remote",
    hostLabel: "beta-host",
    collapsed: false,
    hasList: true,
    hasShowAllToggle: false,
    showAll: true,
  },
];

const thread: ThreadSnapshot = {
  threadId: "local:thread-1",
  hostId: "local",
  title: "Thread",
  selected: false,
  active: false,
  pinned: false,
};

describe("Renderer project group model", () => {
  it("merges Desktop catalog entries with native project rows", () => {
    const index = buildProjectIndex(catalog, snapshots);
    expect(index.get("local-alpha")).toMatchObject({ kind: "local", label: "alpha" });
    expect(index.get("project-beta")).toMatchObject({
      kind: "remote",
      hostId: "remote-ssh-discovered:beta",
      hostLabel: "beta-host",
    });
    expect(index.get("project-gamma")?.native).toBeNull();
  });

  it("groups projects by machine and applies the worst connection state", () => {
    const views = buildProjectGroupViews({
      groups: [group()],
      catalog,
      snapshots,
      threadsByProject: new Map([
        ["local-alpha", [thread]],
        ["project-beta", []],
      ]),
      machineState: new Map([
        ["local", "connected"],
        ["remote-ssh-discovered:beta", "error"],
      ]),
    });
    expect(views[0]?.machines).toHaveLength(2);
    expect(views[0]?.machines[0]).toMatchObject({ label: "本机", state: "connected" });
    expect(views[0]?.machines[1]).toMatchObject({ label: "beta-host", state: "error" });
    expect(
      views[0]?.machines[1]?.projects.map((project) => project.project.entry?.projectId),
    ).toEqual(["project-beta", "project-gamma"]);
    expect(views[0]?.unresolved).toEqual([expect.objectContaining({ projectId: "project-gamma" })]);
  });

  it("falls back to rootPaths and hostId/remotePath after a project ID change", () => {
    const moved = {
      ...group(),
      members: [
        {
          projectKind: "local" as const,
          projectId: "local-renamed",
          rootPaths: ["/Users/test/alpha"],
          label: "alpha",
        },
        {
          projectKind: "remote" as const,
          projectId: "project-renamed",
          hostId: "remote-ssh-discovered:beta",
          remotePath: "/srv/beta",
          label: "beta",
        },
      ],
    };
    const views = buildProjectGroupViews({
      groups: [moved],
      catalog,
      snapshots,
      threadsByProject: new Map(),
      machineState: new Map(),
    });
    expect(views[0]?.projects.map((project) => project.project.entry?.projectId)).toEqual([
      "local-alpha",
      "project-beta",
    ]);
  });

  it("only exposes Show all when the native project has a Show all control", () => {
    const local = snapshots[0];
    const without = buildProjectGroupViews({
      groups: [group()],
      catalog,
      snapshots: [{ ...local, showAll: false, hasShowAllToggle: false }],
      threadsByProject: new Map(),
      machineState: new Map(),
    });
    expect(without[0]?.projects[0]?.canShowAll).toBe(false);
    const withToggle = buildProjectGroupViews({
      groups: [group()],
      catalog,
      snapshots: [{ ...local, showAll: false, hasShowAllToggle: true }],
      threadsByProject: new Map(),
      machineState: new Map(),
    });
    expect(withToggle[0]?.projects[0]?.canShowAll).toBe(true);
  });

  it("shortens the group row machine summary while keeping the full title", () => {
    expect(projectGroupMachineSummary([])).toEqual({ text: "", title: "" });
    expect(
      projectGroupMachineSummary([
        { key: "local", label: "本机", state: "connected", projects: [] },
      ]),
    ).toEqual({ text: "本机", title: "本机" });
    expect(
      projectGroupMachineSummary([
        { key: "local", label: "本机", state: "connected", projects: [] },
        { key: "remote", label: "colab", state: "connected", projects: [] },
      ]),
    ).toEqual({ text: "2 台机器", title: "本机 · colab" });
  });

  it("derives stable machine keys and connection ordering", () => {
    const index = buildProjectIndex(catalog, snapshots);
    const local = index.get("local-alpha");
    const remote = index.get("project-beta");
    expect(local ? projectHostKey(local) : null).toBe("local");
    expect(remote ? projectHostKey(remote) : null).toBe("remote-ssh-discovered:beta");
    expect(worseConnectionState("connected", "error")).toBe("error");
    expect(worseConnectionState("disconnected", "connecting")).toBe("disconnected");
    expect(mergeMachineState(undefined, "connected")).toBe("connected");
    expect(mergeMachineState("connected", "unknown")).toBe("connected");
    expect(mergeMachineState("unknown", "error")).toBe("error");
    expect(mergeMachineState("connected", "disconnected")).toBe("disconnected");
    expect(mergeMachineState("disconnected", "error")).toBe("error");
  });
});
