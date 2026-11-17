import { describe, expect, it } from "vitest";

import {
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
