import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: null as FakeElement | null,
  units: new Map<string, FakeElement>(),
  showMore: 0,
}));

vi.mock("../src/renderer-project-groups-dom.js", () => ({
  PROJECTS_SECTION_SELECTOR: "section[data-projects]",
  PROJECT_ROW_SELECTOR: "[data-app-action-sidebar-project-row]",
  PROJECT_ID_ATTRIBUTE: "data-app-action-sidebar-project-id",
  findProjectsSection: () => ({}),
  findProjectList: () => mocks.list,
  projectUnitForId: (_section: unknown, projectId: string) => mocks.units.get(projectId) ?? null,
}));

class FakeStyle {
  readonly #values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.#values.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.#values.get(name) ?? "";
  }

  get display(): string {
    return this.#values.get("display") ?? "";
  }

  set display(value: string) {
    this.#values.set("display", value);
  }

  get background(): string {
    return this.#values.get("background") ?? "";
  }

  set background(value: string) {
    this.#values.set("background", value);
  }
}

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  defaultPrevented = false;
  currentTarget: FakeElement | null = null;
  target: FakeElement | null = null;
  key = "";

  constructor(target: FakeElement) {
    this.target = target;
  }

  stopPropagation(): void {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  readonly #attributes = new Map<string, string>();
  readonly #listeners = new Map<string, Listener[]>();
  parentElement: FakeElement | null = null;
  textContent = "";
  title = "";
  type = "";
  tabIndex = 0;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get nextSibling(): FakeElement | null {
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

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
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

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  dispatch(type: string, event = new FakeEvent(this)): void {
    event.currentTarget = this;
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function fakeDocument(): Document {
  return {
    createElement: (tagName: string) => new FakeElement(tagName),
    head: new FakeElement("head"),
    documentElement: new FakeElement("html"),
    body: new FakeElement("body"),
  } as unknown as Document;
}

function headerTexts(root: FakeElement): string {
  return [root.textContent, ...root.children.map(headerTexts)].join(" ");
}

function find(root: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement | null {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}

function newList(): FakeElement {
  const list = new FakeElement("div");
  mocks.list = list;
  return list;
}

function memberUnit(projectId: string): FakeElement {
  const unit = new FakeElement("div");
  unit.setAttribute("data-project", projectId);
  mocks.units.set(projectId, unit);
  mocks.list?.append(unit);
  return unit;
}

async function setup() {
  const { ProjectGroupHeaders } = await import("../src/renderer-project-groups-header.js");
  const calls = {
    toggle: [] as string[],
    newChat: [] as Array<[string, number]>,
    manager: [] as Array<string | undefined>,
    showMore: 0,
  };
  const headers = new ProjectGroupHeaders(fakeDocument(), {
    toggleGroup: (id) => calls.toggle.push(id),
    openNewChat: (id, anchor) => calls.newChat.push([id, anchor ? 1 : 0]),
    openManager: (id) => calls.manager.push(id),
    showMoreProjects: () => {
      calls.showMore += 1;
    },
  });
  return { headers, calls };
}

describe("Project group headers", () => {
  afterEach(() => {
    mocks.list = null;
    mocks.units.clear();
    vi.unstubAllGlobals();
  });

  it("inserts the group header before its first native member and adds a create row", async () => {
    newList();
    const alpha = memberUnit("alpha");
    const { headers } = await setup();
    headers.render(
      [
        {
          id: "g1",
          name: "验收测试组",
          machineSummary: "2 台",
          machineSummaryTitle: "本机 · colab",
          projectIds: ["alpha"],
        },
      ],
      { collapsedGroups: new Set(), placeholders: new Map() },
    );

    const header = find(
      mocks.list ?? new FakeElement("div"),
      (node) => node.getAttribute("data-codexhost-project-group-header") === "g1",
    );
    expect(header).not.toBeNull();
    expect(header?.style.getPropertyValue("order")).toBe("0");
    expect(header?.parentElement).toBe(mocks.list);
    expect(header?.nextSibling).toBe(alpha);
    expect(headerTexts(header as FakeElement)).toContain("验收测试组");
    expect(headerTexts(header as FakeElement)).toContain("2 台");
    const row = header?.firstElementChild as FakeElement;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.title).toBe("");

    const create = find(
      mocks.list ?? new FakeElement("div"),
      (node) => node.getAttribute("data-codexhost-project-group-create") !== null,
    );
    expect(create).not.toBeNull();
    expect(create?.style.getPropertyValue("order")).toBe("950");
    expect(headerTexts(create as FakeElement)).toContain("新建项目组");
    headers.dispose();
  });

  it("reflects collapse and hides the compacted-list placeholder", async () => {
    newList();
    memberUnit("alpha");
    const { headers } = await setup();
    const group = {
      id: "g1",
      name: "Group",
      machineSummary: "本机",
      machineSummaryTitle: "本机",
      projectIds: ["alpha"],
    };
    headers.render([group], {
      collapsedGroups: new Set(["g1"]),
      placeholders: new Map([["g1", 2]]),
    });
    const header = find(
      mocks.list ?? new FakeElement("div"),
      (node) => node.getAttribute("data-codexhost-project-group-header") === "g1",
    );
    expect(header?.firstElementChild?.getAttribute("aria-expanded")).toBe("false");
    const placeholder = find(
      mocks.list ?? new FakeElement("div"),
      (node) => node.getAttribute("data-codexhost-project-group-placeholder") === "g1",
    );
    expect(placeholder?.style.getPropertyValue("display")).toBe("none");
    expect(headerTexts(placeholder as FakeElement)).toContain("2 个成员项目在收起的列表中");
    headers.dispose();
  });

  it("shows one placeholder row and expands the native list when clicked", async () => {
    newList();
    memberUnit("alpha");
    const { headers, calls } = await setup();
    const group = {
      id: "g1",
      name: "Group",
      machineSummary: "本机",
      machineSummaryTitle: "本机",
      projectIds: ["alpha"],
    };
    headers.render([group], {
      collapsedGroups: new Set(),
      placeholders: new Map([["g1", 3]]),
    });
    const placeholder = find(
      mocks.list ?? new FakeElement("div"),
      (node) => node.getAttribute("data-codexhost-project-group-placeholder") === "g1",
    );
    const row = placeholder?.firstElementChild as FakeElement;
    expect(headerTexts(row)).toBe("3 个成员项目在收起的列表中 · 展开");
    row.dispatch("click");
    expect(calls.showMore).toBe(1);

    headers.render([group], {
      collapsedGroups: new Set(),
      placeholders: new Map([["g1", 1]]),
    });
    expect(headerTexts(row)).toBe("1 个成员项目在收起的列表中 · 展开");
    headers.dispose();
  });

  it("routes header toggle and actions to the controller", async () => {
    newList();
    memberUnit("alpha");
    const { headers, calls } = await setup();
    headers.render(
      [
        {
          id: "g1",
          name: "Group",
          machineSummary: "本机",
          machineSummaryTitle: "本机",
          projectIds: ["alpha"],
        },
      ],
      { collapsedGroups: new Set(), placeholders: new Map() },
    );
    const header = find(
      mocks.list ?? new FakeElement("div"),
      (node) => node.getAttribute("data-codexhost-project-group-header") === "g1",
    );
    const row = header?.firstElementChild as FakeElement;
    row.dispatch("click");
    expect(calls.toggle).toEqual(["g1"]);

    const buttons = row.children.filter((child) => child.tagName === "button");
    const actionContainer = row.children.find((child) =>
      child.children.some((candidate) => candidate.tagName === "button"),
    );
    const actionButtons = actionContainer?.children.filter((child) => child.tagName === "button");
    expect(actionButtons).toHaveLength(2);
    actionButtons?.[0]?.dispatch("click");
    actionButtons?.[1]?.dispatch("click");
    expect(calls.newChat).toEqual([["g1", 1]]);
    expect(calls.manager).toEqual(["g1"]);

    const create = find(
      mocks.list ?? new FakeElement("div"),
      (node) => node.getAttribute("data-codexhost-project-group-create") !== null,
    );
    (create?.firstElementChild as FakeElement).dispatch("click");
    expect(calls.manager).toEqual(["g1", undefined]);
    expect(buttons).toHaveLength(0);
    headers.dispose();
  });

  it("updates content without duplicating and removes obsolete groups", async () => {
    newList();
    memberUnit("alpha");
    const { headers } = await setup();
    const group = {
      id: "g1",
      name: "Old",
      machineSummary: "本机",
      machineSummaryTitle: "本机",
      projectIds: ["alpha"],
    };
    headers.render([group], { collapsedGroups: new Set(), placeholders: new Map() });
    headers.render([{ ...group, name: "New" }], {
      collapsedGroups: new Set(),
      placeholders: new Map(),
    });
    const headersFound = (mocks.list?.children ?? []).filter(
      (child) => child.getAttribute("data-codexhost-project-group-header") === "g1",
    );
    expect(headersFound).toHaveLength(1);
    expect(headerTexts(headersFound[0] as FakeElement)).toContain("New");
    expect(headerTexts(headersFound[0] as FakeElement)).not.toContain("Old");

    headers.render([], { collapsedGroups: new Set(), placeholders: new Map() });
    expect(
      (mocks.list?.children ?? []).some(
        (child) => child.getAttribute("data-codexhost-project-group-header") !== null,
      ),
    ).toBe(false);
    headers.dispose();
  });

  it("re-attaches headers when React replaces the native list", async () => {
    const first = newList();
    memberUnit("alpha");
    const { headers } = await setup();
    const group = {
      id: "g1",
      name: "Group",
      machineSummary: "本机",
      machineSummaryTitle: "本机",
      projectIds: ["alpha"],
    };
    headers.render([group], { collapsedGroups: new Set(), placeholders: new Map() });
    const header = first.children.find(
      (child) => child.getAttribute("data-codexhost-project-group-header") === "g1",
    );
    expect(header?.parentElement).toBe(first);

    const second = newList();
    const alpha = memberUnit("alpha");
    headers.render([group], { collapsedGroups: new Set(), placeholders: new Map() });
    expect(header?.parentElement).toBe(second);
    expect(header?.nextSibling).toBe(alpha);
    headers.dispose();
    expect(second.children).toHaveLength(1);
  });

  it("dispose removes every foreign node", async () => {
    const list = newList();
    memberUnit("alpha");
    const { headers } = await setup();
    headers.render(
      [
        {
          id: "g1",
          name: "Group",
          machineSummary: "本机",
          machineSummaryTitle: "本机",
          projectIds: ["alpha"],
        },
      ],
      { collapsedGroups: new Set(), placeholders: new Map([["g1", 1]]) },
    );
    headers.dispose();
    expect(list.children).toHaveLength(1);
    expect(list.children[0]?.getAttribute("data-project")).toBe("alpha");
  });
});
