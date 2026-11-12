import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_GROUP_NON_MEMBER_ORDER,
  ProjectGroupLayoutStyle,
  projectGroupCreateOrder,
  projectGroupHeaderOrder,
  projectGroupLayoutCss,
  projectGroupMemberOrder,
  projectGroupPlaceholderOrder,
  projectsListSelector,
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

describe("Project group layout CSS", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps native items below group orders and indents members", () => {
    const css = projectGroupLayoutCss([
      { id: "g1", collapsed: false, projectIds: ["local-alpha", "project-beta"] },
    ]);
    expect(css).toContain(`> div[role="listitem"] { order: ${PROJECT_GROUP_NON_MEMBER_ORDER}; }`);
    expect(css).toContain(
      `:has([data-app-action-sidebar-project-row][data-app-action-sidebar-project-id="local-alpha"]) { order: ${projectGroupMemberOrder(
        0,
        0,
      )}; margin-left: 12px; }`,
    );
    expect(css).toContain(`order: ${projectGroupMemberOrder(0, 1)}`);
    expect(css).not.toContain("display: none");
    expect(css.match(/margin-left: 12px/g)).toHaveLength(2);
  });

  it("hides members of a collapsed group", () => {
    const css = projectGroupLayoutCss([{ id: "g1", collapsed: true, projectIds: ["local-alpha"] }]);
    expect(css).toContain("display: none !important");
  });

  it("orders multiple groups in sequence and de-duplicates shared members", () => {
    const css = projectGroupLayoutCss([
      { id: "g1", collapsed: false, projectIds: ["local-alpha"] },
      { id: "g2", collapsed: false, projectIds: ["project-beta", "local-alpha"] },
    ]);
    expect(css).toContain(
      `:has([data-app-action-sidebar-project-row][data-app-action-sidebar-project-id="project-beta"]) { order: ${projectGroupMemberOrder(
        1,
        0,
      )}`,
    );
    expect(css.match(/local-alpha"\]\)/g)).toHaveLength(1);
  });

  it("escapes project ids for attribute selectors", () => {
    vi.stubGlobal("CSS", { escape: (value: string) => `escaped-${value}` });
    const css = projectGroupLayoutCss([{ id: "g1", collapsed: false, projectIds: ["1234"] }]);
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

describe("Project group layout stylesheet", () => {
  it("installs one stylesheet, updates it, and clears it", () => {
    const { document, head } = fakeDocument();
    const layout = new ProjectGroupLayoutStyle(document);
    layout.apply([{ id: "g1", collapsed: false, projectIds: ["local-alpha"] }]);
    expect(head.children).toHaveLength(1);
    const style = head.children[0];
    expect(style?.getAttribute("data-codexhost-project-groups")).toBe("");
    expect(style?.textContent).toContain("local-alpha");

    layout.apply([{ id: "g1", collapsed: true, projectIds: ["local-alpha"] }]);
    expect(head.children).toHaveLength(1);
    expect(style?.textContent).toContain("display: none !important");

    layout.apply([]);
    expect(head.children).toHaveLength(0);
  });

  it("removes the stylesheet on dispose", () => {
    const { document, head } = fakeDocument();
    const layout = new ProjectGroupLayoutStyle(document);
    layout.apply([{ id: "g1", collapsed: false, projectIds: ["local-alpha"] }]);
    layout.dispose();
    expect(head.children).toHaveLength(0);
  });
});
