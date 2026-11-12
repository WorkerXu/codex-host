import {
  findProjectList,
  findProjectsSection,
  projectUnitForId,
} from "./renderer-project-groups-dom.js";
import {
  projectGroupCreateOrder,
  projectGroupHeaderOrder,
  projectGroupPlaceholderOrder,
} from "./renderer-project-groups-layout.js";

const ROW_HEIGHT = "var(--height-token-row, 30px)";
const ROW_RADIUS = "6px";
const TEXT_COLOR = "var(--color-text, currentColor)";
const MUTED_COLOR = "var(--color-text-secondary, #8b8b8b)";
const HOVER_BACKGROUND = "var(--color-primary-ghost-hover, rgba(127, 127, 127, 0.12))";
const UI_ATTRIBUTE = "data-codexhost-project-groups-ui";

export interface ProjectGroupHeaderItem {
  id: string;
  name: string;
  machineSummary: string;
  machineSummaryTitle: string;
  /** Native project IDs in group order; used only for DOM placement. */
  projectIds: readonly string[];
}

export interface ProjectGroupHeaderHandlers {
  toggleGroup(groupId: string): void;
  openNewChat(groupId: string, anchor: HTMLElement): void;
  openManager(groupId?: string): void;
  showMoreProjects(): void;
}

export interface ProjectGroupHeaderRenderOptions {
  collapsedGroups: ReadonlySet<string>;
  /** Number of group members that the compacted native list has not mounted. */
  placeholders: ReadonlyMap<string, number>;
}

function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
}

function groupIcon(document: Document): HTMLElement {
  const icon = document.createElement("span");
  style(icon, {
    position: "relative",
    width: "16px",
    height: "16px",
    flex: "0 0 auto",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
  });
  for (const [inset, opacity] of [
    ["2px", "0.55"],
    ["0", "1"],
  ] as const) {
    const layer = document.createElement("span");
    style(layer, {
      position: "absolute",
      inset,
      border: `1px solid ${TEXT_COLOR}`,
      "border-radius": "3px",
      opacity,
    });
    icon.append(layer);
  }
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function iconButton(
  document: Document,
  label: string,
  text: string,
  onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  button.title = label;
  style(button, {
    border: "0",
    background: "transparent",
    color: MUTED_COLOR,
    cursor: "pointer",
    width: "20px",
    height: "20px",
    "border-radius": "5px",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    flex: "0 0 auto",
    "font-size": "14px",
    padding: "0",
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

function actionRow(document: Document, text: string, onClick: () => void): HTMLDivElement {
  const row = document.createElement("div");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.textContent = text;
  style(row, {
    display: "flex",
    "align-items": "center",
    height: "26px",
    "min-height": "26px",
    padding: "0 6px 0 26px",
    color: MUTED_COLOR,
    cursor: "pointer",
    "font-size": "12px",
    "border-radius": ROW_RADIUS,
  });
  const activate = (event: Event): void => {
    event.stopPropagation();
    onClick();
  };
  row.addEventListener("click", activate);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(event);
    }
  });
  return row;
}

export class ProjectGroupHeaders {
  readonly #document: Document;
  readonly #handlers: ProjectGroupHeaderHandlers;
  readonly #headers = new Map<string, HTMLElement>();
  readonly #placeholders = new Map<string, HTMLElement>();
  #create: HTMLElement | null = null;

  constructor(document: Document, handlers: ProjectGroupHeaderHandlers) {
    this.#document = document;
    this.#handlers = handlers;
  }

  render(
    groups: readonly ProjectGroupHeaderItem[],
    options: ProjectGroupHeaderRenderOptions,
  ): void {
    const section = findProjectsSection(this.#document);
    const list = section ? findProjectList(section) : null;
    if (!section || !list) {
      this.dispose();
      return;
    }

    const ids = new Set(groups.map((group) => group.id));
    for (const [id, node] of this.#headers) {
      if (!ids.has(id)) {
        node.remove();
        this.#headers.delete(id);
      }
    }
    for (const [id, node] of this.#placeholders) {
      if (!ids.has(id)) {
        node.remove();
        this.#placeholders.delete(id);
      }
    }

    groups.forEach((group, index) => {
      const collapsed = options.collapsedGroups.has(group.id);
      const header = this.#headerNode(group, index, collapsed);
      this.#place(list, header, this.#firstMemberUnit(section, group));
      const placeholderCount = options.placeholders.get(group.id) ?? 0;
      this.#renderPlaceholder(list, group, index, placeholderCount, collapsed);
    });

    this.#renderCreate(list, groups.length);
  }

  #headerNode(group: ProjectGroupHeaderItem, index: number, collapsed: boolean): HTMLElement {
    let node = this.#headers.get(group.id);
    if (!node) {
      node = this.#document.createElement("div");
      node.setAttribute("role", "listitem");
      node.setAttribute("data-codexhost-project-group-header", group.id);
      node.setAttribute(UI_ATTRIBUTE, "");
      style(node, { display: "block", width: "100%" });
      this.#headers.set(group.id, node);
    }
    node.style.setProperty("order", String(projectGroupHeaderOrder(index)));
    const signature = JSON.stringify([
      group.name,
      group.machineSummary,
      group.machineSummaryTitle,
      collapsed,
    ]);
    if (node.dataset.codexhostProjectGroupSignature !== signature) {
      node.dataset.codexhostProjectGroupSignature = signature;
      node.replaceChildren(this.#headerRow(group, collapsed));
    }
    return node;
  }

  #headerRow(group: ProjectGroupHeaderItem, collapsed: boolean): HTMLElement {
    const document = this.#document;
    const row = document.createElement("div");
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.setAttribute("aria-expanded", String(!collapsed));
    row.setAttribute("aria-label", `${group.name}，项目组`);
    style(row, {
      position: "relative",
      display: "flex",
      "align-items": "center",
      gap: "6px",
      height: ROW_HEIGHT,
      "min-height": ROW_HEIGHT,
      padding: "0 4px",
      "border-radius": ROW_RADIUS,
      color: TEXT_COLOR,
      cursor: "pointer",
      "font-size": "14px",
      background: "transparent",
    });

    const actions = document.createElement("div");
    style(actions, {
      position: "absolute",
      right: "4px",
      top: "50%",
      transform: "translateY(-50%)",
      display: "none",
      "align-items": "center",
      gap: "2px",
      "padding-left": "12px",
      background: "linear-gradient(to right, transparent, var(--color-surface, #111) 22%)",
      "border-radius": "4px",
      "z-index": "1",
    });
    const showActions = (): void => {
      actions.style.display = "flex";
    };
    const hideActions = (): void => {
      actions.style.display = "none";
    };
    row.addEventListener("mouseenter", () => {
      row.style.background = HOVER_BACKGROUND;
      showActions();
    });
    row.addEventListener("mouseleave", () => {
      row.style.background = "transparent";
      hideActions();
    });
    row.addEventListener("focusin", showActions);
    row.addEventListener("focusout", hideActions);

    row.append(groupIcon(document));
    const name = document.createElement("span");
    name.textContent = group.name;
    style(name, {
      flex: "1 1 auto",
      "min-width": "0",
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    });
    row.append(name);

    const machines = document.createElement("span");
    machines.textContent = group.machineSummary;
    machines.title = group.machineSummaryTitle;
    machines.setAttribute("aria-label", group.machineSummaryTitle);
    style(machines, {
      color: MUTED_COLOR,
      "font-size": "10px",
      "max-width": "34px",
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
      flex: "0 0 auto",
    });
    row.append(machines);

    actions.append(
      iconButton(document, "新建对话", "+", (event) =>
        this.#handlers.openNewChat(group.id, event.currentTarget as HTMLElement),
      ),
      iconButton(document, "管理项目组", "⋯", () => this.#handlers.openManager(group.id)),
    );
    row.append(actions);

    const toggle = (event: Event): void => {
      event.stopPropagation();
      this.#handlers.toggleGroup(group.id);
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle(event);
      }
    });
    return row;
  }

  #renderPlaceholder(
    list: HTMLElement,
    group: ProjectGroupHeaderItem,
    index: number,
    count: number,
    collapsed: boolean,
  ): void {
    let node = this.#placeholders.get(group.id);
    if (count <= 0) {
      node?.remove();
      this.#placeholders.delete(group.id);
      return;
    }
    if (!node) {
      node = this.#document.createElement("div");
      node.setAttribute("role", "listitem");
      node.setAttribute("data-codexhost-project-group-placeholder", group.id);
      node.setAttribute(UI_ATTRIBUTE, "");
      style(node, { display: "block", width: "100%" });
      node.append(
        actionRow(this.#document, `${count} 个成员项目在收起的列表中 · 展开`, () =>
          this.#handlers.showMoreProjects(),
        ),
      );
      this.#placeholders.set(group.id, node);
    } else {
      const row = node.firstElementChild;
      if (row && row.textContent !== `${count} 个成员项目在收起的列表中 · 展开`)
        row.textContent = `${count} 个成员项目在收起的列表中 · 展开`;
    }
    node.style.setProperty("order", String(projectGroupPlaceholderOrder(index)));
    node.style.setProperty("display", collapsed ? "none" : "block");
    const header = this.#headers.get(group.id);
    const member = this.#lastMemberUnit(list, group);
    const reference = member?.nextSibling ?? header?.nextSibling ?? null;
    if (reference !== node) this.#place(list, node, reference);
  }

  #renderCreate(list: HTMLElement, groupCount: number): void {
    if (!this.#create) {
      this.#create = this.#document.createElement("div");
      this.#create.setAttribute("role", "listitem");
      this.#create.setAttribute("data-codexhost-project-group-create", "");
      this.#create.setAttribute(UI_ATTRIBUTE, "");
      style(this.#create, { display: "block", width: "100%" });
      this.#create.append(
        actionRow(this.#document, "＋ 新建项目组", () => this.#handlers.openManager()),
      );
      list.append(this.#create);
    } else if (this.#create.parentElement !== list) {
      list.append(this.#create);
    }
    this.#create.style.setProperty("order", String(projectGroupCreateOrder(groupCount)));
  }

  #firstMemberUnit(section: HTMLElement, group: ProjectGroupHeaderItem): HTMLElement | null {
    for (const projectId of group.projectIds) {
      const unit = projectUnitForId(section, projectId);
      if (unit) return unit;
    }
    return null;
  }

  #lastMemberUnit(list: HTMLElement, group: ProjectGroupHeaderItem): HTMLElement | null {
    const section = findProjectsSection(this.#document);
    if (!section) return null;
    let last: HTMLElement | null = null;
    for (const projectId of group.projectIds) {
      const unit = projectUnitForId(section, projectId);
      if (unit && (last === null || this.#laterInList(list, unit, last))) last = unit;
    }
    return last;
  }

  #laterInList(list: HTMLElement, candidate: HTMLElement, current: HTMLElement): boolean {
    const children = [...list.children];
    return children.indexOf(candidate) > children.indexOf(current);
  }

  #place(list: HTMLElement, node: HTMLElement, reference: ChildNode | null): void {
    if (reference && reference.parentElement === list) {
      if (node.parentElement !== list || node.nextSibling !== reference)
        list.insertBefore(node, reference);
      return;
    }
    if (node.parentElement !== list) list.append(node);
  }

  dispose(): void {
    for (const node of this.#headers.values()) node.remove();
    for (const node of this.#placeholders.values()) node.remove();
    this.#create?.remove();
    this.#headers.clear();
    this.#placeholders.clear();
    this.#create = null;
  }
}
