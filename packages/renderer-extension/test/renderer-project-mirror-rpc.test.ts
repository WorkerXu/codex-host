import type { ProjectGroup } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  createProjectGroupRpc,
  createProjectMirrorRpc,
  localProjectMirrorManager,
} from "../src/renderer-project-mirror-rpc.js";

const manager = (responses: Record<string, unknown>) => ({
  async sendRequest(method: string, params: unknown) {
    const handler = responses[method];
    if (typeof handler === "function") return (handler as (params: unknown) => unknown)(params);
    if (handler === undefined) throw new Error(`unexpected ${method}`);
    return handler;
  },
});

describe("project mirror RPC client", () => {
  it("parses the mirror registry", async () => {
    const rpc = createProjectMirrorRpc(
      manager({
        "codexhost/project-mirror/list": {
          revision: 3,
          projects: {},
          acknowledged: ["local-alpha"],
        },
      }),
    );
    await expect(rpc.list()).resolves.toEqual({
      revision: 3,
      projects: {},
      acknowledged: ["local-alpha"],
    });
  });

  it("rejects invalid registry responses", async () => {
    const rpc = createProjectMirrorRpc(manager({ "codexhost/project-mirror/list": {} }));
    await expect(rpc.list()).rejects.toThrow();
  });
});

describe("project group RPC client", () => {
  it("parses list and replace responses", async () => {
    const groups: { revision: number; groups: ProjectGroup[] } = {
      revision: 2,
      groups: [
        {
          id: "5e5f0a4d-24bd-4af8-9e8e-2e7f2f8d4a1b",
          name: "alpha",
          order: 0,
          collapsed: false,
          members: [
            {
              projectKind: "local",
              projectId: "local-alpha",
              rootPaths: ["/tmp/alpha"],
              label: "alpha",
            },
          ],
          createdAt: "2026-11-12T03:00:00.000Z",
          updatedAt: "2026-11-12T03:00:00.000Z",
        },
      ],
    };
    const rpc = createProjectGroupRpc(
      manager({
        "codexhost/project-groups/list": groups,
        "codexhost/project-groups/replace": groups,
      }),
    );
    await expect(rpc.list()).resolves.toEqual(groups);
    await expect(rpc.replace({ revision: 2, groups: groups.groups })).resolves.toEqual(groups);
  });
});

describe("local manager lookup", () => {
  it("returns only the local manager", () => {
    const local = manager({});
    expect(
      localProjectMirrorManager({
        forHost: (hostId: string) => (hostId === "local" ? { manager: local } : null),
      }),
    ).toBe(local);
    expect(localProjectMirrorManager({ forHost: () => null })).toBeNull();
    expect(localProjectMirrorManager(undefined)).toBeNull();
  });
});
