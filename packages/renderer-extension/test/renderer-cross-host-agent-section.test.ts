import { describe, expect, it, vi } from "vitest";

vi.mock("../src/renderer-agent-icon.js", () => ({
  createRendererAgentIcon: (agent: string, _size: number, ownerDocument: Document) => {
    const span = ownerDocument.createElement("span");
    span.textContent = agent;
    return span;
  },
}));

import { createCrossHostAgentSection } from "../src/renderer-cross-host-agent-section.js";
import type { CrossHostHarnessCatalog } from "../src/renderer-cross-host-harness-catalog.js";

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> & {
    setProperty(property: string, value: string): void;
  };
  disabled = false;
  parent: FakeElement | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();
  private ownText = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.style = {
      setProperty(property, value) {
        this[property] = value;
      },
    } as Record<string, string> & { setProperty(property: string, value: string): void };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click(): void {
    if (this.disabled) return;
    const event = { preventDefault() {} } as Event;
    for (const listener of this.listeners.get("click") ?? []) listener(event);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    this.ownText = "";
  }

  appendChild(node: FakeElement): FakeElement {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.append(...nodes);
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.length = 0;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (selector === "button" && child.tagName === "BUTTON") matches.push(child);
        walk(child);
      }
    };
    walk(this);
    return matches;
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

const document = {
  createElement: (tagName: string): FakeElement => new FakeElement(tagName),
  createElementNS: (_namespace: string, tagName: string): FakeElement => new FakeElement(tagName),
};
Object.defineProperty(globalThis, "document", { configurable: true, value: document });

const catalog: CrossHostHarnessCatalog = {
  loadedPeers: 1,
  machines: [
    {
      hostId: "remote-ssh-codex-managed:one",
      label: "oracle-sg",
      state: "ready",
      harnesses: [
        { id: "codex", label: "Codex" },
        { id: "claude-code", label: "Claude Code" },
      ],
    },
    {
      hostId: "remote-ssh-codex-managed:two",
      label: "colab",
      state: "offline",
      harnesses: [],
    },
    {
      hostId: "remote-ssh-codex-managed:three",
      label: "tencent",
      state: "error",
      harnesses: [{ id: "codex", label: "Codex" }],
    },
  ],
};

function button(root: FakeElement, label: string): FakeElement {
  const match = root
    .querySelectorAll("button")
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}

describe("cross-host Agent section", () => {
  it("asks for first-use confirmation before listing machines", () => {
    const onAcknowledge = vi.fn();
    const section = createCrossHostAgentSection({
      document: document as unknown as Document,
      catalog,
      acknowledged: false,
      onAcknowledge,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    expect(section.element.textContent).toContain("启用跨机对话");
    expect(section.element.textContent).not.toContain("oracle-sg");
    [...section.element.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "启用跨机对话")
      ?.click();
    expect(onAcknowledge).toHaveBeenCalledOnce();
    section.dispose();
  });

  it("lists machines, disables offline peers, and reports Harness selection", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const section = createCrossHostAgentSection({
      document: document as unknown as Document,
      catalog,
      acknowledged: true,
      onAcknowledge: vi.fn(),
      onSelect,
      onClose,
    });
    expect(button(section.element as unknown as FakeElement, "oracle-sg")).toBeDefined();
    expect(button(section.element as unknown as FakeElement, "colab 离线").disabled).toBe(true);

    button(section.element as unknown as FakeElement, "oracle-sg").click();
    button(section.element as unknown as FakeElement, "oracle-sg · Claude Code").click();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith({
      machine: catalog.machines[0],
      harness: catalog.machines[0]?.harnesses[1],
    });

    button(section.element as unknown as FakeElement, "tencent 列表不可用").click();
    expect(section.element.textContent).toContain("Harness 列表不可用");
    expect(button(section.element as unknown as FakeElement, "tencent · Codex")).toBeDefined();
    section.dispose();
  });

  it("shows a single secondary line while loading and when the directory fails", () => {
    const section = createCrossHostAgentSection({
      document: document as unknown as Document,
      catalog: { machines: [], loadedPeers: 0 },
      acknowledged: true,
      loading: true,
      onAcknowledge: vi.fn(),
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    expect(section.element.textContent).toContain("正在加载其他机器…");
    expect(section.element.textContent).not.toContain("oracle-sg");
    section.refresh({ machines: [], loadedPeers: 0 }, true, {
      loading: false,
      error: "其他机器不可用",
    });
    expect(section.element.textContent).toContain("其他机器不可用");
    section.dispose();
  });
});
