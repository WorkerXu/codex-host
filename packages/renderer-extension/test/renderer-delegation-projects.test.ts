import { describe, expect, it, vi } from "vitest";
import {
  DELEGATION_PROJECTS_METHOD,
  DESKTOP_PROJECTS_CATALOG_METHOD,
  type DelegationProject,
  type DesktopRemoteProject,
  type ThreadProjectAssignment,
} from "@codexhost/shared-contracts";
import {
  installRendererDelegationProjects,
  isAssignmentServices,
  type AssignmentServices,
} from "../src/renderer-delegation-projects.js";

function fixture(assignments: DelegationProject[], existing = false) {
  const values = new Map<string, string>();
  const callbacks: (() => void)[] = [];
  const catalog = {
    localProjects: { project: { id: "project", name: "Project", rootPaths: ["/project"] } },
    remoteProjects: [] as DesktopRemoteProject[],
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
  const memberships = {
    assignments: catalog.threadProjectAssignments as Record<string, ThreadProjectAssignment>,
    projectlessThreadIds: [] as string[],
  };
  const setMembership = vi.fn<AssignmentServices["threadProjectAssignments"]["setMembership"]>(
    async () => {},
  );
  const services: AssignmentServices = {
    threadProjectAssignments: {
      readMemberships: async () => structuredClone(memberships),
      setMembership,
    },
  };
  return { owner, callbacks, catalog, memberships, services, setMembership, values };
}

it("recognizes Desktop's callable RPC proxy as the membership service", () => {
  const threadProjectAssignments = Object.assign(() => {}, {
    readMemberships: vi.fn(),
    setMembership: vi.fn(),
  });
  expect(isAssignmentServices({ threadProjectAssignments })).toBe(true);
  const genericRpc = new Proxy(() => {}, { get: () => threadProjectAssignments });
  expect(isAssignmentServices(genericRpc)).toBe(false);
  expect(isAssignmentServices({ threadProjectAssignments: {} })).toBe(false);
  expect(isAssignmentServices(null)).toBe(false);
});

describe("Desktop registration of delegation projects", () => {
  it("inherits the caller project, accepts explicit none, and persists registration across reloads", async () => {
    const f = fixture([
      { threadId: "child", sourceHostId: "local", sourceThreadId: "parent" },
      { threadId: "none", sourceHostId: "local", sourceThreadId: "parent", projectId: null },
    ]);
    const { services, setMembership: assign } = f;
    const api = installRendererDelegationProjects(f.owner, async () => services);
    api.refresh();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    expect(assign).toHaveBeenCalledWith({
      hostId: "remote",
      threadId: "child",
      assignment: { projectKind: "local", projectId: "project" },
      projectless: false,
    });
    expect(assign).toHaveBeenCalledWith({
      hostId: "remote",
      threadId: "none",
      assignment: null,
      projectless: true,
    });
    api.dispose();
    const reloaded = installRendererDelegationProjects(f.owner, async () => services);
    reloaded.refresh();
    await vi.waitFor(() => expect(f.callbacks.length).toBeGreaterThan(2));
    expect(assign).toHaveBeenCalledTimes(2);
    reloaded.dispose();
  });
  it("keeps an unavailable binding pending and retries when the Host changes", async () => {
    const f = fixture([{ threadId: "child", sourceHostId: "local", sourceThreadId: "parent" }]);
    const { setMembership: assign } = f;
    let ready = false;
    const api = installRendererDelegationProjects(f.owner, async () => (ready ? f.services : null));
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
    const read = vi.fn(async () => f.services);
    const api = installRendererDelegationProjects(f.owner, read);
    api.refresh();
    await vi.waitFor(() => expect(f.callbacks).toHaveLength(2));
    expect(f.setMembership).not.toHaveBeenCalled();
    api.dispose();
  });
});

it("inherits all remote membership fields from the live Desktop rather than the Host catalog", async () => {
  const f = fixture([{ threadId: "child", sourceThreadId: "parent" }]);
  const parent = {
    projectKind: "remote" as const,
    projectId: "oracle-project",
    hostId: "remote-ssh-discovered:oracle-main",
  };
  f.memberships.assignments = { parent };
  const api = installRendererDelegationProjects(f.owner, async () => f.services);
  api.refresh();
  await vi.waitFor(() =>
    expect(f.setMembership).toHaveBeenCalledWith({
      hostId: "remote",
      threadId: "child",
      assignment: parent,
      projectless: false,
    }),
  );
  api.dispose();
});

it("retries a missing parent instead of marking the child as projectless, ignoring obsolete v1 acknowledgments", async () => {
  const f = fixture([{ threadId: "child", sourceThreadId: "parent" }]);
  f.values.set("codexhost.delegation-projects.applied.v1", JSON.stringify(["remote\0child"]));
  delete f.memberships.assignments.parent;
  const api = installRendererDelegationProjects(f.owner, async () => f.services);
  api.refresh();
  await vi.waitFor(() => expect(api.status().pending).toBe(1));
  expect(f.setMembership).not.toHaveBeenCalled();
  f.memberships.assignments.parent = {
    projectKind: "local",
    projectId: "project",
    projectOrigin: "chatgpt",
  };
  f.callbacks.at(-1)?.();
  await vi.waitFor(() =>
    expect(f.setMembership).toHaveBeenCalledWith({
      hostId: "remote",
      threadId: "child",
      assignment: f.memberships.assignments.parent,
      projectless: false,
    }),
  );
  api.dispose();
});

it("registers explicit overrides with the remote project's host and honors a projectless parent", async () => {
  const f = fixture([
    { threadId: "override", sourceThreadId: "parent", projectId: "remote-project" },
    { threadId: "none", sourceThreadId: "projectless-parent" },
  ]);
  f.catalog.remoteProjects.push({
    id: "remote-project",
    hostId: "oracle",
    remotePath: "/work",
    label: "Work",
  });
  f.memberships.projectlessThreadIds.push("projectless-parent");
  const api = installRendererDelegationProjects(f.owner, async () => f.services);
  api.refresh();
  await vi.waitFor(() => expect(f.setMembership).toHaveBeenCalledTimes(2));
  expect(f.setMembership).toHaveBeenCalledWith({
    hostId: "remote",
    threadId: "override",
    assignment: { projectKind: "remote", projectId: "remote-project", hostId: "oracle" },
    projectless: false,
  });
  expect(f.setMembership).toHaveBeenCalledWith({
    hostId: "remote",
    threadId: "none",
    assignment: null,
    projectless: true,
  });
  api.dispose();
});

it("preserves an existing projectless choice and retries failed native writes", async () => {
  const f = fixture([
    { threadId: "child", sourceThreadId: "parent" },
    { threadId: "manual-none", sourceThreadId: "parent" },
  ]);
  f.memberships.projectlessThreadIds.push("manual-none");
  f.setMembership.mockRejectedValueOnce(new Error("native write failed"));
  const api = installRendererDelegationProjects(f.owner, async () => f.services);
  api.refresh();
  await vi.waitFor(() => expect(api.status().lastError).toBe("native write failed"));
  f.callbacks.at(-1)?.();
  await vi.waitFor(() => expect(f.setMembership).toHaveBeenCalledTimes(2));
  expect(f.setMembership.mock.calls.every(([input]) => input.threadId === "child")).toBe(true);
  api.dispose();
});

it("rechecks a notification received while reading the previous snapshot", async () => {
  const assignments: DelegationProject[] = [];
  const f = fixture(assignments);
  let finish: (() => void) | undefined;
  const read = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return f.services;
  });
  assignments.push({ threadId: "first", sourceThreadId: "parent" });
  const api = installRendererDelegationProjects(f.owner, read);
  api.refresh();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  assignments.push({ threadId: "second", sourceThreadId: "parent" });
  f.callbacks.at(-1)?.();
  read.mockImplementation(async () => f.services);
  finish?.();
  await vi.waitFor(() => expect(f.setMembership).toHaveBeenCalledTimes(2));
  api.dispose();
});
