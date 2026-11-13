import { describe, expect, it, vi } from "vitest";

import type { ProjectGroupView } from "../src/renderer-project-groups-model.js";
import { ProjectGroupNewChatPicker } from "../src/renderer-project-groups-new-chat.js";

class FakeStyle {
  readonly values = new Map<string, string>();
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

  constructor(readonly ownerDocument: FakeDocument) {}

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(): void {
    // The picker never removes element listeners itself.
  }

  getBoundingClientRect(): {
    top: number;
    left: number;
    bottom: number;
    width: number;
    height: number;
  } {
    return { top: 10, left: 10, bottom: 40, width: 280, height: 30 };
  }

  contains(node: FakeElement): boolean {
    return node === this || this.children.some((child) => child.contains(node));
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

function walk(element: FakeElement, visit: (node: FakeElement) => void): void {
  visit(element);
  for (const child of element.children) walk(child, visit);
}

describe("Project group add-machine section", () => {
  it("renders ready targets and calls the mirror flow on click", async () => {
    const document = new FakeDocument();
    const onAddMachine = vi.fn();
    const loadAddTargets = vi.fn(async () => [
      { hostId: "host-a", machineLabel: "tencent", harnessId: "codex", harnessLabel: "Codex" },
      { hostId: "host-b", machineLabel: "mac", harnessId: "claude", harnessLabel: "Claude Code" },
    ]);
    const picker = new ProjectGroupNewChatPicker({
      document: document as unknown as Document,
      window: { setTimeout, clearTimeout, innerWidth: 1200, innerHeight: 900 } as unknown as Window,
      onSelect: () => undefined,
      loadAddTargets,
      onAddMachine,
    });
    picker.open(view, document.createElement() as unknown as HTMLElement);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadAddTargets).toHaveBeenCalledWith("group-1");
    const labels: string[] = [];
    for (const element of document.body.children) {
      walk(element, (node) => {
        if (node.textContent) labels.push(node.textContent);
      });
    }
    expect(labels).toContain("添加其他机器");
    expect(labels).toContain("tencent · Codex");
    expect(labels).toContain("mac · Claude Code");

    let row: FakeElement | null = null;
    for (const element of document.body.children) {
      walk(element, (node) => {
        if (node.textContent === "tencent · Codex") row = node;
      });
    }
    expect(row).not.toBeNull();
    (row as FakeElement | null)?.click();
    expect(onAddMachine).toHaveBeenCalledWith("group-1", {
      hostId: "host-a",
      machineLabel: "tencent",
      harnessId: "codex",
      harnessLabel: "Codex",
    });
    picker.dispose();
  });

  it("shows an empty state when every ready machine is already in the group", async () => {
    const document = new FakeDocument();
    const picker = new ProjectGroupNewChatPicker({
      document: document as unknown as Document,
      window: { setTimeout, clearTimeout, innerWidth: 1200, innerHeight: 900 } as unknown as Window,
      onSelect: () => undefined,
      loadAddTargets: async () => [],
      onAddMachine: () => undefined,
    });
    picker.open(view, document.createElement() as unknown as HTMLElement);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const labels: string[] = [];
    for (const element of document.body.children) {
      walk(element, (node) => {
        if (node.textContent) labels.push(node.textContent);
      });
    }
    expect(labels).toContain("没有可添加的机器");
    picker.dispose();
  });
});
