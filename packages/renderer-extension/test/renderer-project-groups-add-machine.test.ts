import { describe, expect, it, vi } from "vitest";

import type { ProjectGroupView } from "../src/renderer-project-groups-model.js";
import { ProjectGroupNewChatPicker } from "../src/renderer-project-groups-new-chat.js";

class FakeStyle {
  readonly values = new Map<string, string>();
  [key: string]: unknown;

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }
}

class FakeElement {
  readonly style = new FakeStyle();
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  className = "";
  textContent = "";
  disabled = false;
  type = "";
  hidden = false;
  title = "";

  constructor(readonly ownerDocument: FakeDocument) {}

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  replaceWith(node: FakeElement): void {
    const parent = parentElementOf(this, this.ownerDocument.body.children);
    const list = parent ? parent.children : this.ownerDocument.body.children;
    const index = list.indexOf(this);
    if (index >= 0) list.splice(index, 1, node);
  }

  get lastElementChild(): FakeElement | null {
    return this.children.at(-1) ?? null;
  }

  get isConnected(): boolean {
    return true;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(): void {
    // The picker never removes element listeners itself.
  }

  animate(): void {
    // Spinner animation is irrelevant to the DOM contract under test.
  }

  getBoundingClientRect(): {
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } {
    return { top: 10, left: 10, right: 290, bottom: 40, width: 280, height: 30 };
  }

  contains(node: FakeElement): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  querySelectorAll(selector: string): FakeElement[] {
    const attribute = /^\[([^\]=]+)\]$/u.exec(selector)?.[1];
    const matches: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      if (attribute && node.attributes.has(attribute)) matches.push(node);
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }

  remove(): void {
    const parent = this.ownerDocument.body.children;
    const index = parent.indexOf(this);
    if (index >= 0) parent.splice(index, 1);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener({});
  }
}

interface FakeBody {
  children: FakeElement[];
  append(element: FakeElement): void;
}

class FakeDocument {
  readonly body: FakeBody;
  #listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor() {
    const children: FakeElement[] = [];
    this.body = { children, append: (element) => children.push(element) };
  }

  createElement(): FakeElement {
    return new FakeElement(this);
  }

  createElementNS(): FakeElement {
    return new FakeElement(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  removeEventListener(): void {
    // Listener cleanup is covered by the shell lifecycle, not this section.
  }
}

const view: ProjectGroupView = {
  group: {
    id: "group-1",
    name: "alpha",
    order: 0,
    collapsed: false,
    members: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  projects: [],
  machines: [],
  unresolved: [],
};

function windowStub(): Window {
  return { setTimeout, clearTimeout, innerWidth: 1200, innerHeight: 900 } as unknown as Window;
}

function walk(element: FakeElement, visit: (node: FakeElement) => void): void {
  visit(element);
  for (const child of element.children) walk(child, visit);
}

function parentElementOf(target: FakeElement, roots: readonly FakeElement[]): FakeElement | null {
  for (const root of roots) {
    if (root.children.includes(target)) return root;
    const found = parentElementOf(target, root.children);
    if (found) return found;
  }
  return null;
}

function find(document: FakeDocument, attribute: string): FakeElement | null {
  let result: FakeElement | null = null;
  for (const element of document.body.children) {
    walk(element, (node) => {
      if (!result && node.attributes.has(attribute)) result = node;
    });
  }
  return result;
}

function labels(document: FakeDocument): string[] {
  const values: string[] = [];
  for (const element of document.body.children) {
    walk(element, (node) => {
      if (node.textContent) values.push(node.textContent);
    });
  }
  return values;
}

describe("Project group add-machine menu", () => {
  it("opens a machine submenu and calls the mirror flow once", async () => {
    const document = new FakeDocument();
    const onAddMachine = vi.fn(async () => ({ ok: true, message: null }));
    const loadAddTargets = vi.fn(async () => [
      {
        hostId: "host-a",
        machineLabel: "tencent",
        state: "ready" as const,
        harnessId: "codex",
        harnessLabel: "Codex",
      },
      {
        hostId: "host-b",
        machineLabel: "mac",
        state: "offline" as const,
        harnessId: "claude",
        harnessLabel: "Claude Code",
      },
    ]);
    const picker = new ProjectGroupNewChatPicker({
      document: document as unknown as Document,
      window: windowStub(),
      onSelect: () => undefined,
      loadAddTargets,
      onAddMachine,
    });
    picker.open(view, document.createElement() as unknown as HTMLElement);
    find(document, "data-codexhost-add-machine-row")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadAddTargets).toHaveBeenCalledWith("group-1");
    expect(labels(document)).toContain("添加机器");
    expect(labels(document)).toContain("tencent");
    expect(labels(document)).toContain("mac");

    find(document, "data-codexhost-add-machine-host")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAddMachine).toHaveBeenCalledWith("group-1", {
      hostId: "host-a",
      machineLabel: "tencent",
      state: "ready",
      harnessId: "codex",
      harnessLabel: "Codex",
    });
    picker.dispose();
  });

  it("shows an empty state when every ready machine is already in the group", async () => {
    const document = new FakeDocument();
    const picker = new ProjectGroupNewChatPicker({
      document: document as unknown as Document,
      window: windowStub(),
      onSelect: () => undefined,
      loadAddTargets: async () => [],
      onAddMachine: () => undefined,
    });
    picker.open(view, document.createElement() as unknown as HTMLElement);
    find(document, "data-codexhost-add-machine-row")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(labels(document)).toContain("没有可添加的机器");
    picker.dispose();
  });

  it("keeps the row open and shows a Chinese reason when adding fails", async () => {
    const document = new FakeDocument();
    const picker = new ProjectGroupNewChatPicker({
      document: document as unknown as Document,
      window: windowStub(),
      onSelect: () => undefined,
      loadAddTargets: async () => [
        {
          hostId: "host-a",
          machineLabel: "tencent",
          state: "ready",
          harnessId: "codex",
          harnessLabel: "Codex",
        },
      ],
      onAddMachine: async () => ({ ok: false, message: "该机器当前离线。" }),
    });
    picker.open(view, document.createElement() as unknown as HTMLElement);
    find(document, "data-codexhost-add-machine-row")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    find(document, "data-codexhost-add-machine-host")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(labels(document)).toContain("该机器当前离线。");
    picker.dispose();
  });
});
