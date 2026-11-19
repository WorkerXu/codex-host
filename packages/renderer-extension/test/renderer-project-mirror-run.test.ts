import { describe, expect, it, vi } from "vitest";

import type {
  DesktopProjectsCatalog,
  ProjectMirrorRecord,
  ProjectMirrorUpsertParams,
  ProjectMirrorUpsertResult,
} from "@codexhost/shared-contracts";

import type { CrossHostAgentSelection } from "../src/renderer-cross-host-agent-section.js";
import type { ProjectMirrorRpc } from "../src/renderer-project-mirror-rpc.js";
import { runProjectMirror } from "../src/renderer-project-mirror-run.js";

const remoteHostId = "remote-ssh-discovered:oracle-main";
const parent = "/Users/test/Documents/ChatGPT";

function catalog(overrides: Partial<DesktopProjectsCatalog> = {}): DesktopProjectsCatalog {
  return {
    localProjects: {},
    remoteProjects: [],
    threadProjectAssignments: {},
    codexManagedRemoteConnections: [],
    projectOrder: [],
    selectedProject: null,
    homeDirectory: "/Users/test",
    defaultProjectParent: parent,
    readAt: "2026-11-19T03:00:00.000Z",
    ...overrides,
  };
}

function remoteSelection(hostId = remoteHostId, label = "甲骨文新加坡"): CrossHostAgentSelection {
  return {
    machine: { hostId, label, state: "ready", harnesses: [] },
    harness: { id: "claude-code", label: "Claude Code" },
  };
}

function localSelection(): CrossHostAgentSelection {
  return {
    machine: { hostId: "local", label: "此计算机", state: "ready", harnesses: [] },
    harness: { id: "codex", label: "Codex" },
  };
}

function fakeDocument(): Document {
  class FakeElement {
    readonly children: FakeElement[] = [];
    readonly style: Record<string, string> = {};
    parent: FakeElement | null = null;
    textContent = "";
    private readonly attributes = new Map<string, string>();
    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }
    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null;
    }
    append(...nodes: FakeElement[]): void {
      for (const node of nodes) {
        node.parent = this;
        this.children.push(node);
      }
    }
    remove(): void {
      if (!this.parent) return;
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = null;
    }
  }
  const body = new FakeElement();
  const document = {
    body,
    documentElement: body,
    createElement: () => new FakeElement(),
    querySelector: () => null,
    defaultView: { setTimeout: () => 0, clearTimeout: () => undefined },
  };
  return document as unknown as Document;
}

function remoteRoute(input: {
  projectRows?: Array<{ id: string; name: string; roots: Array<{ path: string }> }>;
  folder?: { exists: boolean; created?: boolean };
}) {
  const state = { exists: input.folder?.exists ?? false };
  const sendRequest = vi.fn(async (method: string) => {
    if (method === "project/list")
      return { data: input.projectRows ?? [], nextCursor: null, state };
    if (method === "fs/getMetadata") {
      if (!state.exists) throw new Error("No such file or directory (os error 2)");
      return { isDirectory: true };
    }
    return {};
  });
  return { route: { manager: { sendRequest } }, sendRequest, state };
}

function services(input: {
  remoteId?: string;
  localId?: string;
  localPath?: string;
  onDirectory?: () => void;
  createRemoteError?: unknown;
}) {
  return {
    projects: {
      createRemote: vi.fn(async () => {
        if (input.createRemoteError) throw input.createRemoteError;
        return {
          id: input.remoteId ?? "remote-project",
          hostId: remoteHostId,
          remotePath: `/home/oracle/Documents/ChatGPT/alpha`,
          label: "alpha",
        };
      }),
      createLocal: vi.fn(async () => ({
        projectId: input.localId ?? "local-project",
        rootPaths: [input.localPath ?? `${parent}/alpha`],
      })),
    },
    workspaceFiles: {
      createDirectory: vi.fn(async () => {
        input.onDirectory?.();
        return undefined;
      }),
    },
    executionPaths: {
      readHomeDirectory: vi.fn(async () => ({ homeDirectory: "/home/oracle" })),
    },
  };
}

function rpc(input: { upsert?: ProjectMirrorRpc["upsert"] } = {}): ProjectMirrorRpc {
  const upsert =
    input.upsert ??
    (async (params: ProjectMirrorUpsertParams): Promise<ProjectMirrorUpsertResult> => ({
      revision: params.revision + 1,
      projects: {} as Record<string, ProjectMirrorRecord>,
    }));
  return {
    list: vi.fn(async () => ({ revision: 0, projects: {} as Record<string, ProjectMirrorRecord> })),
    upsert: vi.fn(upsert),
  };
}

function recorder() {
  const steps: string[] = [];
  return {
    steps,
    progress: {
      step: (stage: string) => steps.push(stage),
      done: () => steps.push("done"),
      fail: (message: string) => steps.push(`fail:${message}`),
    },
  };
}

const remoteSource = {
  id: "remote-source",
  name: "alpha",
  rootPaths: ["/home/ubuntu/Documents/ChatGPT/alpha"],
  hostId: remoteHostId,
  kind: "remote" as const,
};

describe("project mirror run", () => {
  it("opens the chat while the section join and registry write are still running", async () => {
    const events: string[] = [];
    const { route, state } = remoteRoute({ folder: { exists: false } });
    const desktop = services({
      onDirectory: () => {
        state.exists = true;
        events.push("createDirectory");
      },
    });
    const registry = rpc({ upsert: () => new Promise<ProjectMirrorUpsertResult>(() => undefined) });
    const { steps, progress } = recorder();
    const joinSection = vi.fn(() => {
      events.push("join");
      return new Promise(() => undefined);
    });
    const openChat = vi.fn(async () => {
      events.push("open");
      return { ok: true as const };
    });

    const result = await runProjectMirror({
      document: fakeDocument(),
      routing: { forHost: () => route },
      context: { catalog: catalog(), source: remoteSource },
      selection: remoteSelection(),
      services: desktop,
      rpc: registry,
      progress,
      inFlight: new Set<string>(),
      pending: new Map(),
      joinSection,
      openChat,
    });

    expect(result).toEqual({ ok: true, message: null });
    expect(steps).toEqual(["create", "section", "open", "done"]);
    expect(joinSection).toHaveBeenCalledOnce();
    expect(openChat).toHaveBeenCalledOnce();
    expect(events.indexOf("join")).toBeLessThan(events.indexOf("open"));
    expect(events).toContain("createDirectory");
    expect(desktop.projects.createRemote).toHaveBeenCalledOnce();
    expect(registry.upsert).toHaveBeenCalledOnce();
  });

  it("reports a section failure after the chat opened instead of blocking it", async () => {
    const { route } = remoteRoute({ folder: { exists: true } });
    const { steps, progress } = recorder();
    const onBackgroundError = vi.fn();
    const document = fakeDocument();
    const openChat = vi.fn(async () => ({ ok: true as const }));

    const result = await runProjectMirror({
      document,
      routing: { forHost: () => route },
      context: { catalog: catalog(), source: remoteSource },
      selection: remoteSelection(),
      services: services({}),
      rpc: rpc(),
      progress,
      inFlight: new Set<string>(),
      pending: new Map(),
      joinSection: async () => {
        throw new Error("section unavailable");
      },
      openChat,
      onBackgroundError,
    });

    expect(result.ok).toBe(true);
    expect(steps).toEqual(["create", "section", "open", "done"]);
    expect(onBackgroundError).toHaveBeenCalledOnce();
    const notice = (
      document.body as unknown as { children: Array<{ getAttribute(name: string): string | null }> }
    ).children.at(0);
    expect(notice?.getAttribute("data-codexhost-project-mirror-notice")).toBe("error");
  });

  it("reports project creation failures in Chinese without opening a chat", async () => {
    const { route } = remoteRoute({ folder: { exists: true } });
    const { steps, progress } = recorder();
    const openChat = vi.fn(async () => ({ ok: true as const }));

    const result = await runProjectMirror({
      document: fakeDocument(),
      routing: { forHost: () => route },
      context: { catalog: catalog(), source: remoteSource },
      selection: remoteSelection(),
      services: services({ createRemoteError: new Error("boom") }),
      rpc: rpc(),
      progress,
      inFlight: new Set<string>(),
      pending: new Map(),
      joinSection: async () => undefined,
      openChat,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("添加机器失败，请稍后重试。");
    expect(steps.at(-1)).toBe("fail:添加机器失败，请稍后重试。");
    expect(openChat).not.toHaveBeenCalled();
  });

  it("uses Desktop's local project creation for this Mac and keeps the chat unblocked", async () => {
    const desktop = services({ localId: "local-alpha" });
    const { steps, progress } = recorder();
    const openChat = vi.fn(async () => ({ ok: true as const }));

    const result = await runProjectMirror({
      document: fakeDocument(),
      routing: { forHost: () => ({ manager: { sendRequest: async () => ({}) } }) },
      context: {
        catalog: catalog({
          localProjects: {
            "local-alpha": { id: "local-alpha", name: "alpha", rootPaths: [`${parent}/alpha`] },
          },
        }),
        source: remoteSource,
      },
      selection: localSelection(),
      services: desktop,
      rpc: rpc(),
      progress,
      inFlight: new Set<string>(),
      pending: new Map(),
      joinSection: async () => undefined,
      openChat,
    });

    expect(result.ok).toBe(true);
    expect(steps).toEqual(["create", "section", "open", "done"]);
    expect(desktop.projects.createLocal).not.toHaveBeenCalled();
    expect(desktop.projects.createRemote).not.toHaveBeenCalled();
    expect(desktop.executionPaths.readHomeDirectory).not.toHaveBeenCalled();
    expect(openChat).toHaveBeenCalledOnce();
  });

  it("creates the local project when no same-name project exists", async () => {
    const desktop = services({ localId: "local-alpha" });
    const { progress } = recorder();

    const result = await runProjectMirror({
      document: fakeDocument(),
      routing: { forHost: () => ({ manager: { sendRequest: async () => ({}) } }) },
      context: { catalog: catalog(), source: remoteSource },
      selection: localSelection(),
      services: desktop,
      rpc: rpc(),
      progress,
      inFlight: new Set<string>(),
      pending: new Map(),
      joinSection: async () => undefined,
      openChat: async () => ({ ok: true }),
    });

    expect(result.ok).toBe(true);
    expect(desktop.projects.createLocal).toHaveBeenCalledWith({
      appearance: null,
      initializeDefaultWorkspaceGitRepository: false,
      name: "alpha",
      setActive: false,
      sources: [],
    });
  });

  it("fails fast with Chinese copy when the machine has no route", async () => {
    const { steps, progress } = recorder();
    const result = await runProjectMirror({
      document: fakeDocument(),
      routing: { forHost: () => null },
      context: { catalog: catalog(), source: remoteSource },
      selection: remoteSelection(),
      services: services({}),
      rpc: rpc(),
      progress,
      inFlight: new Set<string>(),
      pending: new Map(),
      openChat: async () => ({ ok: true }),
    });

    expect(result).toEqual({ ok: false, message: "甲骨文新加坡 当前离线" });
    expect(steps).toEqual(["fail:甲骨文新加坡 当前离线"]);
  });

  it("explains a missing sidebar row or an unavailable project", async () => {
    const missing = recorder();
    const first = await runProjectMirror({
      document: fakeDocument(),
      routing: { forHost: () => remoteRoute({ folder: { exists: true } }).route },
      context: { catalog: catalog(), source: remoteSource },
      selection: remoteSelection(),
      services: services({}),
      rpc: rpc(),
      progress: missing.progress,
      inFlight: new Set<string>(),
      pending: new Map(),
      joinSection: async () => undefined,
      openChat: async () => ({ ok: false, reason: "missing-row" }),
    });
    expect(first.message).toBe("项目已创建，但侧栏尚未显示，请稍后手动打开");
    expect(missing.steps.at(-1)).toBe("fail:项目已创建，但侧栏尚未显示，请稍后手动打开");

    const unavailable = recorder();
    const second = await runProjectMirror({
      document: fakeDocument(),
      routing: { forHost: () => remoteRoute({ folder: { exists: true } }).route },
      context: { catalog: catalog(), source: remoteSource },
      selection: remoteSelection(),
      services: services({}),
      rpc: rpc(),
      progress: unavailable.progress,
      inFlight: new Set<string>(),
      pending: new Map(),
      joinSection: async () => undefined,
      openChat: async () => ({ ok: false, reason: "unavailable" }),
    });
    expect(second.message).toBe("该项目当前不可用，可能已离线");
  });

  it("refuses a second run for the same source project", async () => {
    const inFlight = new Set(["remote-source"]);
    const { steps, progress } = recorder();
    const result = await runProjectMirror({
      document: fakeDocument(),
      routing: { forHost: () => remoteRoute({ folder: { exists: true } }).route },
      context: { catalog: catalog(), source: remoteSource },
      selection: remoteSelection(),
      services: services({}),
      rpc: rpc(),
      progress,
      inFlight,
      pending: new Map(),
    });

    expect(result.message).toBe("正在添加这台机器，请稍候。");
    expect(steps).toEqual(["fail:正在添加这台机器，请稍候。"]);
    expect(inFlight.has("remote-source")).toBe(true);
  });
});
