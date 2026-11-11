import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProjectGroupProjectView,
  ProjectGroupView as ProjectGroupModelView,
} from "../src/renderer-project-groups-model.js";

const section = {} as HTMLElement;
let list: FakeElement;

vi.mock("../src/renderer-project-groups-dom.js", () => ({
  findProjectsSection: () => section,
  findProjectList: () => list as unknown as HTMLElement,
}));

class FakeStyle {
  readonly #values = new Map<string, string>();
  [key: string]: unknown;

  setProperty(name: string, value: string): void {
    this.#values.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.#values.get(name) ?? "";
  }
}

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  readonly #attributes = new Map<string, string>();
  parentElement: FakeElement | null = null;
  textContent = "";
  title = "";
  type = "";

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get offsetParent(): FakeElement | null {
    let parent = this.parentElement;
    while (parent) {
      const position = parent.style.getPropertyValue("position") || parent.style.position;
      if (position && position !== "static") return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  get nextElementSibling(): FakeElement | null {
    const siblings = this.parentElement?.children ?? [];
    const index = siblings.indexOf(this);
    return index >= 0 ? (siblings[index + 1] ?? null) : null;
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.#attributes.has(name);
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        this.textContent += node;
        continue;
      }
      if (node.tagName === "#fragment") {
        this.append(...node.children);
        continue;
      }
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }

  insertBefore(node: FakeElement, reference: FakeElement): void {
    node.remove();
    const index = this.children.indexOf(reference);
    node.parentElement = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
  }

  replaceChildren(...nodes: Array<FakeElement | string>): void {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(): void {}

  cloneNode(): FakeElement {
    return new FakeElement(this.tagName);
  }
}

function fakeDocument(): Document {
  const host = new FakeElement("div");
  list = new FakeElement("div");
  host.append(list);
  return {
    createElement: (tagName: string) => new FakeElement(tagName),
    createDocumentFragment: () => new FakeElement("#fragment"),
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
  } as unknown as Document;
}

function findThreadRow(root: FakeElement): FakeElement | null {
  if (root.dataset.codexhostProjectGroupThread !== undefined) return root;
  for (const child of root.children) {
    const found = findThreadRow(child);
    if (found) return found;
  }
  return null;
}

function groupView(): ProjectGroupModelView {
  const project: ProjectGroupProjectView = {
    project: {
      member: {
        projectKind: "local",
        projectId: "local-alpha",
        rootPaths: ["/tmp/alpha"],
        label: "alpha",
      },
      entry: {
        projectId: "local-alpha",
        kind: "local",
        label: "alpha",
        hostId: null,
        hostLabel: null,
        rootPaths: ["/tmp/alpha"],
        remotePath: null,
        native: {
          projectId: "local-alpha",
          label: "alpha",
          kind: "local",
          hostLabel: null,
          collapsed: false,
          hasList: true,
          hasShowAllToggle: false,
          hasNewChatButton: true,
          showAll: false,
        },
      },
      missing: null,
    },
    threads: [
      {
        threadId: "local:thread-1",
        hostId: "local",
        title: "Thread",
        selected: false,
        active: false,
        pinned: false,
      },
    ],
    collapsed: false,
    hasList: true,
    hasShowAllToggle: false,
    newChatAvailable: true,
    showAll: false,
    canShowAll: false,
  };
  return {
    group: {
      id: "5e5f0a4d-24bd-4af8-9e8e-2e7f2f8d4a1b",
      name: "Cross-host",
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
      createdAt: "2026-11-11T10:00:00.000Z",
      updatedAt: "2026-11-11T10:00:00.000Z",
    },
    projects: [project],
    machines: [{ key: "local", label: "本机", state: "connected", projects: [project] }],
    unresolved: [],
  };
}

describe("Project group thread row layout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("anchors the action overlay to the thread row", async () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("Element", FakeElement);
    const { ProjectGroupView } = await import("../src/renderer-project-groups-view.js");
    const document = fakeDocument();
    const host = list.parentElement as FakeElement;
    const view = new ProjectGroupView(document, {
      toggleGroup: () => undefined,
      openThread: () => undefined,
      openThreadMenu: () => undefined,
      toggleThreadPin: () => undefined,
      archiveThread: () => undefined,
      openNewChat: () => undefined,
      openManager: () => undefined,
      expandProject: () => undefined,
      showAll: () => undefined,
      showMoreProjects: () => undefined,
    });
    view.render([groupView()], {
      collapsedGroups: new Set(),
      menuAvailable: true,
      threadActionsAvailable: true,
    });
    const root = host.children[0];
    if (!root) throw new Error("Missing group root");
    const row = findThreadRow(root);
    if (!row) throw new Error("Missing thread row");
    const actions = row.children.find((child) => child.children.length === 3);
    expect(actions?.style.getPropertyValue("position")).toBe("absolute");
    expect(actions?.offsetParent).toBe(row);
  });
});
