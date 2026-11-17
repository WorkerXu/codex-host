import { describe, expect, it, vi } from "vitest";
import {
  DELEGATION_PROJECTS_METHOD,
  DESKTOP_PROJECTS_CATALOG_METHOD,
  type DelegationProject,
} from "@codexhost/shared-contracts";
import {
  installRendererDelegationProjects,
  type AssignmentServices,
} from "../src/renderer-delegation-projects.js";

function fixture(assignments: DelegationProject[], existing = false) {
  const values = new Map<string, string>();
  const callbacks: (() => void)[] = [];
  const catalog = {
    localProjects: { project: { id: "project", name: "Project", rootPaths: ["/project"] } },
    remoteProjects: [],
    threadProjectAssignments: {
      parent: { projectKind: "local", projectId: "project" },
      ...(existing ? { child: { projectKind: "local", projectId: "manual" } } : {}),
    },
    codexManagedRemoteConnections: [],
    projectOrder: [],
    readAt: new Date().toISOString(),
  };
  const manager = (remote: boolean) => ({
    async sendRequest(method: string) {
      if (method === DESKTOP_PROJECTS_CATALOG_METHOD) return catalog;
      if (method === DELEGATION_PROJECTS_METHOD) return { assignments: remote ? assignments : [] };
      throw new Error(method);
    },
    addNotificationCallback(_methods: unknown, callback: () => void) {
      callbacks.push(callback);
      return () => {};
    },
  });
  const local = { manager: manager(false) };
  const remote = { manager: manager(true) };
  const owner = {
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    __codexhostHostRoutingV1: {
      knownHostIds: () => ["local", "remote"],
      forHost: (hostId: string) => (hostId === "local" ? local : remote),
    },
  } as unknown as Window;
  return { owner, callbacks };
}

describe("Desktop registration of peer delegation projects", () => {
  it("inherits the caller project, accepts explicit none, and persists registration across reloads", async () => {
    const f = fixture([
      { threadId: "child", sourceHostId: "local", sourceThreadId: "parent" },
      { threadId: "none", sourceHostId: "local", sourceThreadId: "parent", projectId: null },
    ]);
    const assign = vi.fn(async () => {});
    const services: AssignmentServices = { threadProjectAssignments: { assign } };
    const api = installRendererDelegationProjects(f.owner, async () => services);
    api.refresh();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    expect(assign).toHaveBeenCalledWith({
      hostId: "remote",
      threadId: "child",
      project: { type: "local", projectId: "project" },
    });
    expect(assign).toHaveBeenCalledWith({ hostId: "remote", threadId: "none", project: null });
    api.dispose();
    const reloaded = installRendererDelegationProjects(f.owner, async () => services);
    reloaded.refresh();
    await vi.waitFor(() => expect(f.callbacks.length).toBeGreaterThan(2));
    expect(assign).toHaveBeenCalledTimes(2);
    reloaded.dispose();
  });
  it("keeps an unavailable binding pending and retries when the Host changes", async () => {
    const f = fixture([{ threadId: "child", sourceHostId: "local", sourceThreadId: "parent" }]);
    const assign = vi.fn(async () => {});
    let ready = false;
    const api = installRendererDelegationProjects(f.owner, async () =>
      ready ? { threadProjectAssignments: { assign } } : null,
    );
    api.refresh();
    await vi.waitFor(() => expect(api.status().pending).toBe(1));
    expect(api.status().lastError).toContain("unavailable");
    ready = true;
    f.callbacks.at(-1)?.();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(api.status().lastError).toBeNull();
    api.dispose();
  });
  it("preserves a user's existing project assignment", async () => {
    const f = fixture(
      [{ threadId: "child", sourceHostId: "local", sourceThreadId: "parent" }],
      true,
    );
    const read = vi.fn(async () => null);
    const api = installRendererDelegationProjects(f.owner, read);
    api.refresh();
    await vi.waitFor(() => expect(f.callbacks).toHaveLength(2));
    expect(read).not.toHaveBeenCalled();
    api.dispose();
  });
});
