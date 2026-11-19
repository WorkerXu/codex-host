import { describe, expect, it } from "vitest";

import {
  createProjectMirrorProgress,
  projectMirrorProgressPlacement,
  projectMirrorProgressText,
} from "../src/renderer-project-mirror-progress.js";

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  parent: FakeElement | null = null;
  height = 0;
  private readonly attributes = new Map<string, string>();
  private ownText = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

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

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.length = 0;
  }

  getBoundingClientRect(): {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
  } {
    const left = Number.parseFloat(this.style.left ?? "0") || 0;
    const top = Number.parseFloat(this.style.top ?? "0") || 0;
    const width = Number.parseFloat(this.style.width ?? "0") || 0;
    return {
      left,
      right: left + width,
      top,
      bottom: top + this.height,
      width,
      height: this.height,
    };
  }
}

function createHarness(options: {
  anchor: { left: number; top: number; width: number; height: number };
  viewport?: { width: number; height: number };
}) {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const body = new FakeElement("body");
  const document = {
    body,
    documentElement: body,
    createElement: (tagName: string) => {
      const element = new FakeElement(tagName);
      element.height = 56;
      return element;
    },
    defaultView: {
      innerWidth: options.viewport?.width ?? 1_200,
      innerHeight: options.viewport?.height ?? 800,
      setTimeout: (run: () => void) => {
        const id = nextTimer++;
        timers.set(id, run);
        return id;
      },
      clearTimeout: (id: number) => {
        timers.delete(id);
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  };
  const anchor = new FakeElement("div");
  anchor.height = options.anchor.height;
  anchor.style.left = `${options.anchor.left}px`;
  anchor.style.top = `${options.anchor.top}px`;
  anchor.style.width = `${options.anchor.width}px`;
  return {
    document: document as unknown as Document,
    anchor: anchor as unknown as Element,
    body,
    runTimers: () => {
      for (const [id, run] of [...timers]) {
        timers.delete(id);
        run();
      }
    },
  };
}

describe("project mirror progress copy", () => {
  it("names the machine and keeps every step in Chinese", () => {
    expect(projectMirrorProgressText({ machineLabel: "甲骨文新加坡", local: false })).toEqual({
      create: "正在 甲骨文新加坡 上创建项目…",
      section: "加入分区…",
      open: "打开新对话…",
      done: "已在新对话中打开",
      trustHint: "接下来 Desktop 会请你确认信任这个文件夹",
    });
  });

  it("uses 本机 and no trust hint for a local target", () => {
    const text = projectMirrorProgressText({ machineLabel: "此计算机", local: true });
    expect(text.create).toBe("正在本机创建项目…");
    expect(text.trustHint).toBeNull();
  });
});

describe("project mirror progress card", () => {
  it("is visible on the first step and advances without waiting", () => {
    const harness = createHarness({ anchor: { left: 300, top: 700, width: 600, height: 100 } });
    const card = createProjectMirrorProgress({
      document: harness.document,
      anchor: harness.anchor,
      text: projectMirrorProgressText({ machineLabel: "甲骨文新加坡", local: false }),
    });

    expect(harness.body.children).toHaveLength(1);
    expect(card.element.textContent).toContain("正在 甲骨文新加坡 上创建项目…");
    expect(card.element.textContent).toContain("接下来 Desktop 会请你确认信任这个文件夹");
    expect(card.element.style.top).toBe("636px");

    card.step("section");
    expect(card.element.textContent).toContain("加入分区…");
    expect(card.element.textContent).not.toContain("信任这个文件夹");
    card.step("open");
    expect(card.element.textContent).toContain("打开新对话…");
  });

  it("confirms success briefly and then removes itself", () => {
    const harness = createHarness({ anchor: { left: 300, top: 700, width: 600, height: 100 } });
    const card = createProjectMirrorProgress({
      document: harness.document,
      anchor: harness.anchor,
      text: projectMirrorProgressText({ machineLabel: "甲骨文新加坡", local: false }),
      successMs: 40,
    });
    card.done();
    expect(card.element.textContent).toContain("已在新对话中打开");
    expect(card.element.textContent).not.toContain("信任这个文件夹");
    expect(harness.body.children).toHaveLength(1);
    harness.runTimers();
    expect(harness.body.children).toHaveLength(0);
  });

  it("shows a Chinese failure in place of the steps", () => {
    const harness = createHarness({ anchor: { left: 300, top: 700, width: 600, height: 100 } });
    const card = createProjectMirrorProgress({
      document: harness.document,
      anchor: harness.anchor,
      text: projectMirrorProgressText({ machineLabel: "此计算机", local: true }),
    });
    card.fail("项目已创建，但侧栏尚未显示，请稍后手动打开");
    expect(card.element.textContent).toContain("项目已创建，但侧栏尚未显示，请稍后手动打开");
    expect(card.element.textContent).not.toContain("正在本机创建项目");
    expect(card.element.style.pointerEvents).toBe("none");
  });
});

describe("project mirror progress placement", () => {
  const anchor = { left: 300, right: 900, top: 700, bottom: 800, width: 600 };

  it("sits above the Composer aligned with its left edge", () => {
    expect(
      projectMirrorProgressPlacement({
        anchor,
        viewport: { width: 1_200, height: 900 },
        card: { width: 300, height: 56 },
      }),
    ).toEqual({ left: 300, top: 636, above: true });
  });

  it("flips below when the top would leave the viewport", () => {
    expect(
      projectMirrorProgressPlacement({
        anchor: { ...anchor, top: 20, bottom: 120 },
        viewport: { width: 1_200, height: 900 },
        card: { width: 300, height: 56 },
      }),
    ).toEqual({ left: 300, top: 128, above: false });
  });

  it("clamps a narrow composer to the viewport edges", () => {
    expect(
      projectMirrorProgressPlacement({
        anchor: { left: 4, right: 84, top: 400, bottom: 460, width: 80 },
        viewport: { width: 200, height: 600 },
        card: { width: 184, height: 56 },
      }),
    ).toEqual({ left: 8, top: 336, above: true });
  });
});
