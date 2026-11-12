import type { DesktopProjectsCatalog, ProjectGroup } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  buildProjectGroupViews,
  buildProjectIndex,
  mergeMachineState,
  projectGroupMachineSummary,
  projectHostKey,
  resolveGroupProject,
  worseConnectionState,
  type NativeProjectSnapshot,
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
    hasNewChatButton: true,
  },
  {
    projectId: "project-beta",
    label: "beta",
    kind: "remote",
    hostLabel: "beta-host",
    hasNewChatButton: false,
  },
];

describe("Project group model", () => {
  it("resolves native snapshots and marks unmounted members", () => {
    const index = buildProjectIndex(catalog, snapshots);
    expect(index.get("local-alpha")?.native?.projectId).toBe("local-alpha");
    expect(index.get("project-beta")?.hostId).toBe("remote-ssh-discovered:beta");
    expect(index.get("project-gamma")?.native).toBeNull();

    const gamma = group().members[2];
    if (!gamma) throw new Error("Missing member fixture");
    const resolved = resolveGroupProject(gamma, index);
    expect(resolved.missing).toBe("not-mounted");
    expect(resolved.entry?.label).toBe("gamma");
  });

  it("falls back to rootPaths when a local project id changed", () => {
    const index = buildProjectIndex(catalog, []);
    const resolved = resolveGroupProject(
      {
        projectKind: "local",
        projectId: "stale-id",
        rootPaths: ["/Users/test/alpha"],
        label: "alpha",
      },
      index,
    );
    expect(resolved.missing).toBe("not-mounted");
    expect(resolved.entry?.projectId).toBe("local-alpha");
  });

  it("reports missing members that are not in the catalog", () => {
    const resolved = resolveGroupProject(
      {
        projectKind: "remote",
        projectId: "gone",
        hostId: "host",
        remotePath: "/gone",
        label: "gone",
      },
      buildProjectIndex(catalog, snapshots),
    );
    expect(resolved.missing).toBe("missing");
    expect(resolved.entry).toBeNull();
  });

  it("builds machine sections in catalog host order", () => {
    const views = buildProjectGroupViews({
      groups: [group()],
      catalog,
      snapshots,
      machineState: new Map([
        ["local", "connected"],
        ["remote-ssh-discovered:beta", "error"],
      ]),
    });
    expect(views).toHaveLength(1);
    expect(views[0]?.machines.map((machine) => machine.label)).toEqual(["本机", "beta-host"]);
    expect(views[0]?.machines[1]?.state).toBe("error");
    expect(views[0]?.machines[1]?.projects.map((project) => project.mounted)).toEqual([
      true,
      false,
    ]);
    expect(views[0]?.projects[1]?.newChatAvailable).toBe(false);
    expect(views[0]?.unresolved.map((member) => member.projectId)).toEqual(["project-gamma"]);
  });

  it("sorts groups by order and keeps configured member order", () => {
    const second = { ...group(), id: "second", name: "Second", order: 1 };
    const first = { ...group(), id: "first", name: "First", order: -1 };
    const views = buildProjectGroupViews({
      groups: [second, first],
      catalog,
      snapshots,
      machineState: new Map(),
    });
    expect(views.map((view) => view.group.name)).toEqual(["First", "Second"]);
    expect(views[0]?.projects.map((project) => project.project.member.projectId)).toEqual([
      "local-alpha",
      "project-beta",
      "project-gamma",
    ]);
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
    ).toEqual({ text: "2 台", title: "本机 · colab" });
  });
});
