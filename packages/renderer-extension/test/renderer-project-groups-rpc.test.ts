import { describe, expect, it, vi } from "vitest";

import { readBootstrapCatalog } from "../src/renderer-project-groups-bootstrap.js";
import { createProjectGroupsRpc } from "../src/renderer-project-groups-rpc.js";

function fakeWindow(entries: Array<{ key: string; value: unknown }>): Window {
  return {
    electronBridge: {
      getInitialSidebarBootstrap: () => ({ globalStateEntries: entries }),
    },
  } as unknown as Window;
}

describe("Renderer project group bootstrap", () => {
  it("builds a catalog from the initial sidebar snapshot", () => {
    const catalog = readBootstrapCatalog(
      fakeWindow([
        {
          key: "local-projects",
          value: { "local-alpha": { id: "local-alpha", name: "alpha", rootPaths: ["/tmp/a"] } },
        },
        {
          key: "remote-projects",
          value: [
            {
              id: "project-beta",
              hostId: "remote-ssh-discovered:beta",
              remotePath: "/srv/beta",
              label: "beta",
            },
          ],
        },
        {
          key: "thread-project-assignments",
          value: { "thread-1": { projectKind: "remote", projectId: "project-beta" } },
        },
        { key: "project-order", value: ["local-alpha", "project-beta"] },
      ]),
      () => new Date("2026-11-11T10:00:00.000Z"),
    );
    expect(catalog).toMatchObject({
      projectOrder: ["local-alpha", "project-beta"],
      readAt: "2026-11-11T10:00:00.000Z",
    });
    expect(catalog?.remoteProjects[0]?.id).toBe("project-beta");
  });

  it("returns null when the preload bridge is unavailable", () => {
    expect(readBootstrapCatalog({} as Window)).toBeNull();
  });
});

describe("Renderer project group RPC", () => {
  it("sends the fixed local methods and validates replies", async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === "codexhost/project-groups/list") return { revision: 2, groups: [group()] };
      if (method === "codexhost/project-groups/replace") return { revision: 3, groups: [group()] };
      return {
        localProjects: {},
        remoteProjects: [],
        threadProjectAssignments: {},
        codexManagedRemoteConnections: [],
        projectOrder: [],
        readAt: "2026-11-11T10:00:00.000Z",
      };
    });
    const rpc = createProjectGroupsRpc({ sendRequest });
    await expect(rpc.list()).resolves.toMatchObject({ revision: 2 });
    await expect(rpc.replace({ revision: 2, groups: [group()] })).resolves.toMatchObject({
      revision: 3,
    });
    await expect(rpc.readDesktopCatalog()).resolves.toMatchObject({ projectOrder: [] });
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      "codexhost/project-groups/list",
      "codexhost/project-groups/replace",
      "codexhost/desktop-projects/catalog",
    ]);
  });
});

function group() {
  return {
    id: "5e5f0a4d-24bd-4af8-9e8e-2e7f2f8d4a1b",
    name: "Cross-host",
    order: 0,
    collapsed: false,
    members: [
      {
        projectKind: "local" as const,
        projectId: "local-alpha",
        rootPaths: ["/tmp/a"],
        label: "alpha",
      },
    ],
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
  };
}
