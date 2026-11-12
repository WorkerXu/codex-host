import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LayoutGroup = { id: string; collapsed: boolean; projectIds: readonly string[] };
type HeaderItem = {
  id: string;
  name: string;
  machineSummary: string;
  machineSummaryTitle: string;
  projectIds: readonly string[];
};
type HeaderOptions = {
  collapsedGroups: ReadonlySet<string>;
  placeholders: ReadonlyMap<string, number>;
};

const mocks = vi.hoisted(() => {
  const group = {
    id: "5e5f0a4d-24bd-4af8-9e8e-2e7f2f8d4a1b",
    name: "Cross-host",
    order: 0,
    collapsed: false,
    members: [
      {
        projectKind: "local" as const,
        projectId: "local-alpha",
        rootPaths: ["/tmp/alpha"],
        label: "alpha",
      },
      {
        projectKind: "remote" as const,
        projectId: "project-beta",
        hostId: "remote-ssh-discovered:beta",
        remotePath: "/srv/beta",
        label: "beta",
      },
    ],
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
  };
  const catalog = {
    localProjects: {
      "local-alpha": { id: "local-alpha", name: "alpha", rootPaths: ["/tmp/alpha"] },
    },
    remoteProjects: [
      {
        id: "project-beta",
        hostId: "remote-ssh-discovered:beta",
        remotePath: "/srv/beta",
        label: "beta",
      },
    ],
    threadProjectAssignments: {},
    codexManagedRemoteConnections: [],
    projectOrder: ["local-alpha", "project-beta"],
    readAt: "2026-11-11T10:00:00.000Z",
  };
  const snapshot = {
    projectId: "local-alpha",
    label: "alpha",
    kind: "local" as const,
    hostLabel: null,
    hasNewChatButton: true,
  };
  const contract = {
    ok: true,
    missing: [] as string[],
    hasHasSelector: true,
    projectCount: 1,
    missingNewChatCount: 0,
  };
  return {
    group,
    catalog,
    snapshot,
    contract,
    warning: null as null | { kind: "quarantined"; backupName: string },
    showMore: false,
    rowOutside: false,
    calls: {
      layoutApply: [] as LayoutGroup[][],
      layoutClear: 0,
      layoutDispose: 0,
      headerRender: [] as Array<{ items: readonly HeaderItem[]; options: HeaderOptions }>,
      headerDispose: 0,
      headers: [] as unknown[],
    },
  };
});

vi.mock("../src/renderer-project-groups-bootstrap.js", () => ({
  readBootstrapCatalog: () => mocks.catalog,
}));

vi.mock("../src/renderer-project-groups-dom.js", () => ({
  PROJECT_COLLAPSED_ATTRIBUTE: "data-app-action-sidebar-project-collapsed",
  SECTION_COLLAPSED_ATTRIBUTE: "data-app-action-sidebar-section-collapsed",
  findProjectsSection: () => ({}),
  findProjectsShowMoreButton: () => (mocks.showMore ? {} : null),
  newChatButton: () => null,
  probeProjectGroupsContract: () => mocks.contract,
  projectRowForUnit: () => ({}),
  projectRowOutsideSection: () => (mocks.rowOutside ? {} : null),
  projectUnitForId: () => ({}),
  readNativeProjectSnapshots: () => [mocks.snapshot],
  statusIconState: () => "connected",
}));

vi.mock("../src/renderer-project-groups-layout.js", () => ({
  ProjectGroupLayoutStyle: class {
    apply(groups: LayoutGroup[]): void {
      mocks.calls.layoutApply.push(groups);
    }

    clear(): void {
      mocks.calls.layoutClear += 1;
    }

    dispose(): void {
      mocks.calls.layoutDispose += 1;
    }
  },
}));

vi.mock("../src/renderer-project-groups-header.js", () => ({
  ProjectGroupHeaders: class {
    readonly handlers: Record<string, (...args: unknown[]) => void>;

    constructor(_document: unknown, handlers: Record<string, (...args: unknown[]) => void>) {
      this.handlers = handlers;
      mocks.calls.headers.push(this);
    }

    render(items: readonly HeaderItem[], options: HeaderOptions): void {
      mocks.calls.headerRender.push({ items, options });
    }

    dispose(): void {
      mocks.calls.headerDispose += 1;
    }
  },
}));

vi.mock("../src/renderer-project-groups-dialog.js", () => ({
  ProjectGroupsDialog: class {
    open(): void {}
    close(): void {}
  },
}));

vi.mock("../src/renderer-project-groups-new-chat.js", () => ({
  ProjectGroupNewChatPicker: class {
    open(): void {}
    close(): void {}
    dispose(): void {}
  },
}));

vi.mock("../src/renderer-project-groups-rpc.js", () => ({
  createProjectGroupsRpc: () => ({
    list: async () => ({
      revision: 1,
      groups: [mocks.group],
      ...(mocks.warning ? { warning: mocks.warning } : {}),
    }),
    replace: async () => ({ revision: 2, groups: [mocks.group] }),
    readDesktopCatalog: async () => mocks.catalog,
  }),
  localProjectGroupsManager: () => ({ sendRequest: async () => ({}) }),
}));

import { installRendererProjectGroups } from "../src/renderer-project-groups.js";

interface FakeHandlers {
  toggleGroup(groupId: string): void;
  openNewChat(groupId: string, anchor: unknown): void;
  openManager(groupId?: string): void;
  showMoreProjects(): void;
}

function fakeDocument(): Document {
  return {
    body: { append: () => undefined },
    documentElement: { dataset: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({
      style: { setProperty: () => undefined },
      setAttribute: () => undefined,
      textContent: "",
      remove: () => undefined,
    }),
  } as unknown as Document;
}

function fakeWindow(): Window {
  return {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  } as unknown as Window;
}

function install() {
  return installRendererProjectGroups({
    document: fakeDocument(),
    window: fakeWindow(),
    routing: () => ({ forHost: () => ({ manager: { sendRequest: async () => ({}) } }) }),
  });
}

function lastHandlers(): FakeHandlers {
  return (mocks.calls.headers.at(-1) as { handlers: FakeHandlers }).handlers;
}

describe("project group controller", () => {
  beforeEach(() => {
    mocks.warning = null;
    mocks.showMore = false;
    mocks.rowOutside = false;
    mocks.contract.ok = true;
    mocks.contract.missing = [];
    mocks.calls.layoutApply.length = 0;
    mocks.calls.layoutClear = 0;
    mocks.calls.layoutDispose = 0;
    mocks.calls.headerRender.length = 0;
    mocks.calls.headerDispose = 0;
    mocks.calls.headers.length = 0;
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders native member order and group headers", async () => {
    const handle = install();
    await vi.waitFor(() => expect(handle.status().state).toBe("active"));
    expect(handle.status()).toMatchObject({
      state: "active",
      groupCount: 1,
      projectCount: 2,
      missingMembers: 0,
    });
    expect(mocks.calls.layoutApply.at(-1)).toEqual([
      { id: mocks.group.id, collapsed: false, projectIds: ["local-alpha"] },
    ]);
    const render = mocks.calls.headerRender.at(-1);
    expect(render?.items).toEqual([
      {
        id: mocks.group.id,
        name: "Cross-host",
        machineSummary: "2 台",
        machineSummaryTitle: "本机 · remote-ssh-discovered:beta",
        projectIds: ["local-alpha"],
      },
    ]);
    expect(render?.options.collapsedGroups.size).toBe(0);
    expect(render?.options.placeholders.size).toBe(0);
    handle.dispose();
  });

  it("toggles collapse through the header handlers", async () => {
    const handle = install();
    await vi.waitFor(() => expect(handle.status().state).toBe("active"));
    lastHandlers().toggleGroup(mocks.group.id);
    expect(mocks.calls.layoutApply.at(-1)?.[0]?.collapsed).toBe(true);
    expect([...(mocks.calls.headerRender.at(-1)?.options.collapsedGroups ?? [])]).toEqual([
      mocks.group.id,
    ]);
    lastHandlers().toggleGroup(mocks.group.id);
    expect(mocks.calls.layoutApply.at(-1)?.[0]?.collapsed).toBe(false);
    handle.dispose();
  });

  it("adds a placeholder for members missing from a compacted list", async () => {
    mocks.showMore = true;
    const handle = install();
    await vi.waitFor(() => expect(handle.status().state).toBe("active"));
    expect([...(mocks.calls.headerRender.at(-1)?.options.placeholders ?? [])]).toEqual([
      [mocks.group.id, 1],
    ]);
    handle.dispose();
  });

  it("skips the placeholder when the member is shown natively elsewhere", async () => {
    mocks.showMore = true;
    mocks.rowOutside = true;
    const handle = install();
    await vi.waitFor(() => expect(handle.status().state).toBe("active"));
    expect(mocks.calls.headerRender.at(-1)?.options.placeholders.size).toBe(0);
    handle.dispose();
  });

  it("fails open when the native contract breaks", async () => {
    mocks.contract.ok = false;
    mocks.contract.missing = ["projects-list"];
    const handle = install();
    await vi.waitFor(() => expect(handle.status().state).toBe("disabled"));
    expect(handle.status().reason).toBe("contract-missing:projects-list");
    expect(mocks.calls.layoutDispose).toBeGreaterThan(0);
    expect(mocks.calls.headerDispose).toBeGreaterThan(0);
    handle.dispose();
  });

  it("shows a one-time warning when the Host quarantined the config", async () => {
    mocks.warning = { kind: "quarantined", backupName: "groups.json.1.invalid" };
    const handle = install();
    await vi.waitFor(() => expect(handle.status().state).toBe("active"));
    expect(handle.status().lastError).toContain("groups.json.1.invalid");
    handle.dispose();
  });
});
