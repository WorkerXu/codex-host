import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_GROUP_NON_MEMBER_ORDER,
  ProjectGroupLayoutStyle,
  projectGroupCreateOrder,
  projectGroupHeaderOrder,
  projectGroupLayoutCss,
  projectGroupMemberOrder,
  projectGroupPlaceholderOrder,
  projectGroupSubtitleCss,
  projectsListSelector,
  type ProjectGroupLayoutGroup,
  type ProjectGroupLayoutMember,
} from "../src/renderer-project-groups-layout.js";

class FakeElement {
  readonly #attributes = new Map<string, string>();
  children: FakeElement[] = [];
  textContent = "";
  parentElement: FakeElement | null = null;

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
}

function fakeDocument(): { document: Document; head: FakeElement } {
  const head = new FakeElement();
  const document = {
    head,
    documentElement: new FakeElement(),
    createElement: () => new FakeElement(),
  } as unknown as Document;
  return { document, head };
}

function member(
  projectId: string,
  label: string,
  machineName: string,
  kind: "local" | "remote" = "remote",
): ProjectGroupLayoutMember {
  return { projectId, label, machineName, kind };
}

function soleMember(target: ProjectGroupLayoutGroup): ProjectGroupLayoutMember {
  const first = target.members[0];
  if (!first) throw new Error("Missing member fixture");
  return first;
}

function group(overrides: Partial<ProjectGroupLayoutGroup> = {}): ProjectGroupLayoutGroup {
  return {
    id: "g1",
    name: "Group",
    collapsed: false,
    members: [
      member("local-alpha", "alpha", "本机", "local"),
      member("project-beta", "beta", "colab"),
    ],
    ...overrides,
  };
}

describe("Project group layout CSS", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps native items below group orders and indents members", () => {
    const css = projectGroupLayoutCss([group()]);
    expect(css).toContain(`> div[role="listitem"] { order: ${PROJECT_GROUP_NON_MEMBER_ORDER}; }`);
    expect(css).toContain(
      `:has([data-app-action-sidebar-project-row][data-app-action-sidebar-project-id="local-alpha"]) { order: ${projectGroupMemberOrder(
        0,
        0,
      )}; margin-left: 12px; }`,
    );
    expect(css).toContain(`order: ${projectGroupMemberOrder(0, 1)}`);
    expect(css.match(/margin-left: 12px/g)).toHaveLength(2);
  });

  it("hides members of a collapsed group", () => {
    const css = projectGroupLayoutCss([group({ collapsed: true })]);
    expect(css).toContain("display: none !important");
  });

  it("orders multiple groups in sequence and de-duplicates shared members", () => {
    const css = projectGroupLayoutCss([
      group({ members: [member("local-alpha", "alpha", "本机", "local")] }),
      group({
        id: "g2",
        name: "Second",
        members: [
          member("project-beta", "beta", "colab"),
          member("local-alpha", "alpha", "本机", "local"),
        ],
      }),
    ]);
    expect(css).toContain(
      `:has([data-app-action-sidebar-project-row][data-app-action-sidebar-project-id="project-beta"]) { order: ${projectGroupMemberOrder(
        1,
        0,
      )}`,
    );
    expect(css.match(/local-alpha"\]\)\s*\{\s*order:/g)).toHaveLength(1);
  });

  it("escapes project ids for attribute selectors", () => {
    vi.stubGlobal("CSS", { escape: (value: string) => `escaped-${value}` });
    const css = projectGroupLayoutCss([
      group({ members: [member("1234", "alpha", "本机", "local")] }),
    ]);
    expect(css).toContain('data-app-action-sidebar-project-id="escaped-1234"');
  });

  it("returns no stylesheet without groups", () => {
    expect(projectGroupLayoutCss([])).toBe("");
  });

  it("derives header, placeholder and create orders", () => {
    expect(projectGroupHeaderOrder(0)).toBe(0);
    expect(projectGroupHeaderOrder(2)).toBe(2000);
    expect(projectGroupPlaceholderOrder(0)).toBe(900);
    expect(projectGroupCreateOrder(0)).toBe(950);
    expect(projectGroupCreateOrder(1)).toBe(950);
    expect(projectGroupCreateOrder(2)).toBe(1950);
    expect(projectGroupHeaderOrder(2)).toBeLessThan(projectGroupPlaceholderOrder(2));
    expect(projectGroupCreateOrder(2)).toBeLessThan(PROJECT_GROUP_NON_MEMBER_ORDER);
  });

  it("scopes the list selector to the native Projects section", () => {
    expect(projectsListSelector()).toContain(
      'section[data-app-action-sidebar-section][data-app-action-sidebar-section-heading="Projects"]',
    );
    expect(projectsListSelector()).toContain(":has(>");
  });
});

describe("Project group machine subtitles", () => {
  it("shows only the machine name when the project matches the group name", () => {
    const target = group({ name: "逆向", members: [member("p1", "逆向", "colab")] });
    const css = projectGroupSubtitleCss(target, soleMember(target));
    expect(css.join("\n")).toContain('content: "colab";');
    expect(css.join("\n")).not.toContain("colab · 逆向");
    expect(css.join("\n")).toContain("::before");
    expect(css.join("\n")).toContain("::after");
  });

  it("shows machine and project names when they differ", () => {
    const target = group({ name: "跨机前端", members: [member("p1", "beta", "本机", "local")] });
    const css = projectGroupSubtitleCss(target, soleMember(target));
    expect(css.join("\n")).toContain('content: "本机 · beta";');
  });

  it("escapes quotes and backslashes in CSS content", () => {
    const target = group({ name: "Group", members: [member("p1", 'a"b\\c', "本机", "local")] });
    const css = projectGroupSubtitleCss(target, soleMember(target)).join("\n");
    expect(css).toContain('content: "本机 · a\\"b\\\\c";');
  });

  it("turns the native row into a subtitle without touching native buttons", () => {
    const target = group({ name: "逆向", members: [member("p1", "逆向", "colab")] });
    const css = projectGroupLayoutCss([target]);
    expect(css).toContain("height: 24px !important");
    expect(css).toContain("min-height: 24px !important");
    expect(css).toContain("> div:first-child { display: none !important; }");
    expect(css).toContain(
      'div[role="presentation"] > div:last-child > div:first-child { display: none !important; }',
    );
    expect(css).toContain("margin-left: auto !important");
    expect(css).toContain("color: var(--color-chart-green");
    expect(css).toContain("color: var(--color-chart-yellow");
    expect(css).toContain("color: var(--color-chart-red");
    expect(css).not.toContain("pointer-events");
    expect(css).not.toContain("button");
  });
});

describe("Project group layout stylesheet", () => {
  it("installs one stylesheet, updates it, and clears it", () => {
    const { document, head } = fakeDocument();
    const layout = new ProjectGroupLayoutStyle(document);
    layout.apply([group()]);
    expect(head.children).toHaveLength(1);
    const style = head.children[0];
    expect(style?.getAttribute("data-codexhost-project-groups")).toBe("");
    expect(style?.textContent).toContain("local-alpha");

    layout.apply([group({ collapsed: true })]);
    expect(head.children).toHaveLength(1);
    expect(style?.textContent).toContain("display: none !important");

    layout.apply([]);
    expect(head.children).toHaveLength(0);
  });

  it("removes the stylesheet on dispose", () => {
    const { document, head } = fakeDocument();
    const layout = new ProjectGroupLayoutStyle(document);
    layout.apply([group()]);
    layout.dispose();
    expect(head.children).toHaveLength(0);
  });
});
