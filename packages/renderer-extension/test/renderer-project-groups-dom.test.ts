import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findProjectList,
  findProjectsShowMoreButton,
  inspectRendererProjectGroupsContract,
  newChatButton,
  probeProjectGroupsContract,
  projectRowOutsideSection,
  readNativeProjectSnapshots,
  statusIconState,
  PROJECTS_SECTION_SELECTOR,
  PROJECT_ROW_SELECTOR,
} from "../src/renderer-project-groups-dom.js";

interface Attributes {
  [name: string]: string;
}

class FakeElement {
  readonly tagName: string;
  readonly attributes: Attributes;
  readonly children: FakeElement[];
  readonly dataset: Record<string, string>;
  className: string;
  textContent = "";
  parentElement: FakeElement | null = null;

  constructor(
    tagName: string,
    attributes: Attributes = {},
    options: {
      children?: FakeElement[];
      dataset?: Record<string, string>;
      className?: string;
    } = {},
  ) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.children = options.children ?? [];
    this.dataset = options.dataset ?? {};
    this.className = options.className ?? "";
    for (const child of this.children) child.parentElement = this;
  }

  matches(selector: string): boolean {
    if (selector === PROJECT_ROW_SELECTOR)
      return "data-app-action-sidebar-project-row" in this.attributes;
    if (selector === "[data-sidebar-project-kind]")
      return "data-sidebar-project-kind" in this.attributes;
    if (selector === '[role="img"][aria-label]')
      return this.attributes.role === "img" && "aria-label" in this.attributes;
    if (selector === 'div[role="list"]')
      return this.tagName === "div" && this.attributes.role === "list";
    if (selector === "button") return this.tagName === "button";
    if (selector.startsWith("button:not("))
      return (
        this.tagName === "button" &&
        !("aria-haspopup" in this.attributes) &&
        !("data-app-action-sidebar-select-project" in this.attributes)
      );
    if (selector === PROJECTS_SECTION_SELECTOR)
      return this.attributes["data-app-action-sidebar-section-heading"] === "Projects";
    return false;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  contains(node: FakeElement): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
}

function projectRow(
  projectId: string,
  label: string,
  options: { kind?: "local" | "remote"; host?: string; newChat?: number } = {},
): FakeElement {
  const children: FakeElement[] = [];
  if (options.kind) {
    children.push(
      new FakeElement(
        "span",
        { "data-sidebar-project-kind": options.kind },
        {
          dataset: { sidebarProjectKind: options.kind },
        },
      ),
    );
  }
  for (let index = 0; index < (options.newChat ?? 1); index += 1)
    children.push(new FakeElement("button"));
  const attributes: Attributes = {
    "data-app-action-sidebar-project-row": "",
    "data-app-action-sidebar-project-id": projectId,
    "data-app-action-sidebar-project-label": label,
  };
  if (options.host) attributes["aria-label"] = `${label} ${options.host}`;
  return new FakeElement("div", attributes, { children });
}

function projectUnit(row: FakeElement): FakeElement {
  return new FakeElement("div", { role: "listitem" }, { children: [row] });
}

function projectsSection(units: FakeElement[]): FakeElement {
  const list = new FakeElement("div", { role: "list" }, { children: units });
  return new FakeElement(
    "section",
    {
      "data-app-action-sidebar-section": "",
      "data-app-action-sidebar-section-heading": "Projects",
    },
    { children: [list] },
  );
}

function stubCss(): void {
  vi.stubGlobal("CSS", {
    supports: (value: string) => value.includes(":has"),
    escape: (value: string) => value,
  });
}

describe("Project groups DOM contract", () => {
  beforeEach(() => vi.stubGlobal("HTMLElement", FakeElement));

  afterEach(() => vi.unstubAllGlobals());

  it("fails when the Projects section or list is missing", () => {
    stubCss();
    expect(probeProjectGroupsContract(null).missing).toContain("projects-section");
    const empty = new FakeElement("section", {
      "data-app-action-sidebar-section": "",
      "data-app-action-sidebar-section-heading": "Projects",
    });
    expect(probeProjectGroupsContract(empty as unknown as HTMLElement).missing).toContain(
      "projects-list",
    );
  });

  it("accepts a compacted list with a show-more row and a project without new chat", () => {
    stubCss();
    const row = projectRow("remote-offline", "offline", { kind: "remote", newChat: 0 });
    const showMoreButton = new FakeElement("button");
    showMoreButton.textContent = "展开显示";
    const showMore = new FakeElement(
      "div",
      { role: "listitem" },
      {
        children: [showMoreButton],
      },
    );
    const section = projectsSection([projectUnit(row), showMore]);
    const contract = probeProjectGroupsContract(section as unknown as HTMLElement);
    expect(contract.ok).toBe(true);
    expect(contract.missing).toEqual([]);
    expect(contract.projectCount).toBe(1);
    expect(contract.missingNewChatCount).toBe(1);
    expect(contract.hasHasSelector).toBe(true);
  });

  it("fails when a project row loses its identity", () => {
    stubCss();
    const row = new FakeElement("div", { "data-app-action-sidebar-project-row": "" });
    const section = projectsSection([projectUnit(row)]);
    const contract = probeProjectGroupsContract(section as unknown as HTMLElement);
    expect(contract.ok).toBe(false);
    expect(contract.missing).toContain("project-row-identity");
  });

  it("fails without :has() support", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    const section = projectsSection([projectUnit(projectRow("alpha", "alpha"))]);
    const contract = probeProjectGroupsContract(section as unknown as HTMLElement);
    expect(contract.ok).toBe(false);
    expect(contract.missing).toContain("has-selector");
  });

  it("reads native project snapshots", () => {
    const row = projectRow("project-beta", "beta", {
      kind: "remote",
      host: "beta-host",
      newChat: 0,
    });
    const section = projectsSection([projectUnit(row)]);
    expect(findProjectList(section as unknown as HTMLElement)).not.toBeNull();
    expect(readNativeProjectSnapshots(section as unknown as HTMLElement)).toEqual([
      {
        projectId: "project-beta",
        label: "beta",
        kind: "remote",
        hostLabel: "beta-host",
        hasNewChatButton: false,
      },
    ]);
  });

  it("requires exactly one native new-chat button", () => {
    const button = {} as HTMLButtonElement;
    expect(newChatButton({ querySelectorAll: () => [button] } as unknown as HTMLElement)).toBe(
      button,
    );
    expect(newChatButton({ querySelectorAll: () => [] } as unknown as HTMLElement)).toBeNull();
    expect(
      newChatButton({ querySelectorAll: () => [button, button] } as unknown as HTMLElement),
    ).toBeNull();
  });

  it("finds the native Projects Show more button", () => {
    const showMoreButton = new FakeElement("button");
    showMoreButton.textContent = "展开显示";
    const showMore = new FakeElement(
      "div",
      { role: "listitem" },
      {
        children: [showMoreButton],
      },
    );
    const section = projectsSection([projectUnit(projectRow("alpha", "alpha")), showMore]);
    expect(findProjectsShowMoreButton(section as unknown as HTMLElement)).toBe(showMoreButton);
  });

  it("detects a project row rendered outside the Projects section", () => {
    const row = projectRow("pinned", "pinned");
    const section = projectsSection([projectUnit(projectRow("alpha", "alpha"))]);
    const outside = new FakeElement("section", {}, { children: [row] });
    const root = new FakeElement("div", {}, { children: [outside, section] });
    expect(
      projectRowOutsideSection(
        root as unknown as ParentNode,
        section as unknown as HTMLElement,
        "pinned",
      ),
    ).toBe(row);
    expect(
      projectRowOutsideSection(
        root as unknown as ParentNode,
        section as unknown as HTMLElement,
        "alpha",
      ),
    ).toBeNull();
  });

  it("reads the native status icon", () => {
    const connected = { className: "text-chart-green", getAttribute: () => "已连接" };
    const error = { className: "", getAttribute: () => "连接失败" };
    expect(statusIconState({ querySelector: () => connected } as unknown as HTMLElement)).toBe(
      "connected",
    );
    expect(statusIconState({ querySelector: () => error } as unknown as HTMLElement)).toBe("error");
    expect(statusIconState({ querySelector: () => null } as unknown as HTMLElement)).toBe(
      "unknown",
    );
  });

  it("inspects the audit surface", () => {
    stubCss();
    const section = projectsSection([projectUnit(projectRow("alpha", "alpha"))]);
    const root = new FakeElement("div", {}, { children: [section] });
    expect(inspectRendererProjectGroupsContract(root as unknown as ParentNode)).toEqual({
      sectionCount: 1,
      projectCount: 1,
      missingNewChatCount: 0,
      contractOk: true,
    });
  });
});
