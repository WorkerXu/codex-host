import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    ],
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
  };
  const catalog = {
    localProjects: {
      "local-alpha": { id: "local-alpha", name: "alpha", rootPaths: ["/tmp/alpha"] },
    },
    remoteProjects: [],
    threadProjectAssignments: {},
    codexManagedRemoteConnections: [],
    projectOrder: ["local-alpha"],
    readAt: "2026-11-11T10:00:00.000Z",
  };
  const thread = {
    threadId: "local:thread-1",
    hostId: "local",
    title: "Thread",
    selected: false,
    active: false,
    pinned: false,
  };
  const snapshot = {
    projectId: "local-alpha",
    label: "alpha",
    kind: "local" as const,
    hostLabel: null,
    collapsed: false,
    hasList: true,
    hasShowAllToggle: false,
    showAll: false,
  };
  const contract = {
    ok: true,
    missing: [] as string[],
    hasHasSelector: true,
    projectCount: 1,
    threadRowCount: 1,
    missingNewChatCount: 0,
    hasContextMenu: true,
    hasThreadActions: true,
  };
  return {
    group,
    catalog,
    thread,
    snapshot,
    contract,
    calls: {
      menuOpen: 0,
      pinClicks: 0,
      archiveClicks: 0,
    },
  };
});

vi.mock("../src/renderer-project-groups-bootstrap.js", () => ({
  readBootstrapCatalog: () => mocks.catalog,
}));

vi.mock("../src/renderer-project-groups-dom.js", () => ({
  findNativeThreadRow: () => ({ click: () => undefined }),
  findProjectList: () => null,
  findProjectsSection: () => ({}),
  findProjectsShowMoreButton: () => null,
  hasNativeContextMenu: () => true,
  nativeThreadActionButton: (_row: unknown, action: "pin" | "archive") => ({
    click: () => {
      if (action === "pin") mocks.calls.pinClicks += 1;
      else mocks.calls.archiveClicks += 1;
    },
  }),
  newChatButton: () => null,
  probeProjectGroupsContract: () => mocks.contract,
  projectListForUnit: () => ({}),
  projectRowForUnit: () => ({}),
  projectUnitForId: () => ({}),
  projectUnits: () => [],
  readNativeProjectSnapshots: () => [mocks.snapshot],
  readThreadSnapshots: () => [mocks.thread],
  restoreSidebarScrollAfterThreadClick: () => () => undefined,
  sectionCollapsed: () => false,
  showAllToggle: () => null,
  sidebarScrollContainer: () => null,
  statusIconState: () => "connected",
}));

vi.mock("../src/renderer-project-groups-hide.js", () => ({
  ProjectGroupHider: class {
    apply(): void {}
    clear(): void {}
    dispose(): void {}
  },
}));

vi.mock("../src/renderer-project-groups-menu.js", () => ({
  ProjectGroupMenuProxy: class {
    state(): string {
      return "unknown";
    }

    isOpen(): boolean {
      return false;
    }

    isAvailable(): boolean {
      return true;
    }

    async open(): Promise<boolean> {
      mocks.calls.menuOpen += 1;
      return true;
    }

    reprobe(): void {}
    dispose(): void {}
  },
}));

vi.mock("../src/renderer-project-groups-view.js", () => {
  class FakeView {
    static last: FakeView | null = null;
    readonly handlers: Record<string, (...args: unknown[]) => void>;

    constructor(_document: unknown, handlers: Record<string, (...args: unknown[]) => void>) {
      this.handlers = handlers;
      FakeView.last = this;
    }

    render(): void {}
    dispose(): void {}
  }
  return { ProjectGroupView: FakeView };
});

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
    list: async () => ({ revision: 1, groups: [mocks.group] }),
    replace: async () => ({ revision: 2, groups: [mocks.group] }),
    readDesktopCatalog: async () => mocks.catalog,
  }),
  localProjectGroupsManager: () => ({ sendRequest: async () => ({}) }),
}));

import { installRendererProjectGroups } from "../src/renderer-project-groups.js";
import { ProjectGroupView } from "../src/renderer-project-groups-view.js";

interface ViewHandlers {
  openThreadMenu(thread: typeof mocks.thread, anchor: unknown): void | Promise<void>;
  toggleThreadPin(thread: typeof mocks.thread): void;
  archiveThread(thread: typeof mocks.thread): void;
}

function fakeDocument(): Document {
  return {
    body: { append: () => undefined },
    documentElement: { dataset: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({ style: { setProperty: () => undefined } }),
  } as unknown as Document;
}

function fakeWindow(): Window {
  return {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (callback: () => void) => setTimeout(callback, 0),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  } as unknown as Window;
}

describe("project group controller menu wiring", () => {
  beforeEach(() => {
    mocks.calls.menuOpen = 0;
    mocks.calls.pinClicks = 0;
    mocks.calls.archiveClicks = 0;
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

  it("reports native menu and thread actions and forwards both to the native row", async () => {
    const handle = installRendererProjectGroups({
      document: fakeDocument(),
      window: fakeWindow(),
      routing: () => ({ forHost: () => ({ manager: { sendRequest: async () => ({}) } }) }),
    });
    await vi.waitFor(() => expect(handle.status().state).toBe("active"));
    expect(handle.status()).toMatchObject({
      state: "active",
      menu: "native",
      threadActions: "native",
    });
    const view = (ProjectGroupView as unknown as { last: { handlers: ViewHandlers } }).last;
    expect(view).toBeDefined();
    await view.handlers.openThreadMenu(mocks.thread, {});
    expect(mocks.calls.menuOpen).toBe(1);
    view.handlers.toggleThreadPin(mocks.thread);
    expect(mocks.calls.pinClicks).toBe(1);
    view.handlers.archiveThread(mocks.thread);
    expect(mocks.calls.archiveClicks).toBe(1);
    handle.dispose();
  });
});
