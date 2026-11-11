import type {
  MachineConnectionState,
  ProjectGroupProjectView,
  ProjectGroupView as ProjectGroupModelView,
  ThreadSnapshot,
} from "./renderer-project-groups-model.js";
import { projectGroupMachineSummary } from "./renderer-project-groups-model.js";
import { findProjectList, findProjectsSection } from "./renderer-project-groups-dom.js";

const ROW_HEIGHT = "var(--height-token-row, 30px)";
const ROW_RADIUS = "6px";
const TEXT_COLOR = "var(--color-text, currentColor)";
const MUTED_COLOR = "var(--color-text-secondary, #8b8b8b)";
const HOVER_BACKGROUND = "var(--color-primary-ghost-hover, rgba(127, 127, 127, 0.12))";
const SELECTED_BACKGROUND = "var(--color-primary-ghost-selected, rgba(127, 127, 127, 0.16))";

export interface ProjectGroupViewHandlers {
  toggleGroup(groupId: string): void;
  openThread(thread: ThreadSnapshot): void;
  openThreadMenu(thread: ThreadSnapshot, anchor: HTMLElement, nativeFirst?: boolean): void;
  toggleThreadPin(thread: ThreadSnapshot): void;
  archiveThread(thread: ThreadSnapshot): void;
  openNewChat(groupId: string, anchor: HTMLElement): void;
  openManager(groupId?: string): void;
  expandProject(projectId: string): void;
  showAll(projectId: string): void;
  showMoreProjects(): void;
}

export interface ProjectGroupViewOptions {
  collapsedGroups: ReadonlySet<string>;
  menuAvailable: boolean;
  threadActionsAvailable: boolean;
}

function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
}

function statusColor(state: MachineConnectionState): string {
  switch (state) {
    case "connected":
      return "var(--color-chart-green, #3fb950)";
    case "connecting":
      return "var(--color-chart-yellow, #d29922)";
    case "disconnected":
      return "var(--color-text-tertiary, #8b8b8b)";
    case "error":
      return "var(--color-chart-red, #f85149)";
    default:
      return "var(--color-text-tertiary, #8b8b8b)";
  }
}

function statusDot(document: Document, state: MachineConnectionState): HTMLElement {
  const dot = document.createElement("span");
  style(dot, {
    width: "6px",
    height: "6px",
    "border-radius": "999px",
    background: statusColor(state),
    flex: "0 0 auto",
  });
  dot.setAttribute("aria-hidden", "true");
  return dot;
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

function actionButton(
  document: Document,
  label: string,
  icon: Element | null | undefined,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  const clone = icon?.cloneNode(true);
  if (clone instanceof Element) {
    style(clone as HTMLElement, { width: "14px", height: "14px", "pointer-events": "none" });
    button.append(clone);
  } else {
    button.textContent = label;
  }
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
    "font-size": "10px",
    padding: "0",
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function threadRow(
  document: Document,
  thread: ThreadSnapshot,
  handlers: ProjectGroupViewHandlers,
  menuAvailable: boolean,
  threadActionsAvailable: boolean,
): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.dataset.codexhostProjectGroupThread = "";
  row.dataset.threadId = thread.threadId;
  row.dataset.hostId = thread.hostId;
  row.dataset.projectGroupThreadSelected = thread.selected || thread.active ? "true" : "false";
  style(row, {
    position: "relative",
    display: "flex",
    "align-items": "center",
    gap: "8px",
    height: ROW_HEIGHT,
    "min-height": ROW_HEIGHT,
    padding: "0 6px 0 30px",
    "border-radius": ROW_RADIUS,
    color: TEXT_COLOR,
    cursor: "pointer",
    "font-size": "13px",
    background: thread.selected || thread.active ? SELECTED_BACKGROUND : "transparent",
  });
  let menuButton: HTMLButtonElement | null = null;
  const hoverButtons: HTMLButtonElement[] = [];
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
  const showMenu = (): void => {
    actions.style.display = "flex";
  };
  const hideMenu = (): void => {
    actions.style.display = "none";
  };
  row.addEventListener("mouseenter", () => {
    if (!thread.selected && !thread.active) row.style.background = HOVER_BACKGROUND;
    showMenu();
  });
  row.addEventListener("mouseleave", () => {
    row.style.background = thread.selected || thread.active ? SELECTED_BACKGROUND : "transparent";
    hideMenu();
  });
  row.addEventListener("focusin", showMenu);
  row.addEventListener("focusout", hideMenu);

  const providerIcon = thread.providerIcon?.cloneNode(true);
  if (providerIcon instanceof HTMLElement) {
    style(providerIcon, {
      width: "14px",
      height: "14px",
      flex: "0 0 auto",
      "pointer-events": "none",
    });
    row.append(providerIcon);
  }

  const title = document.createElement("span");
  title.textContent = thread.title;
  style(title, {
    flex: "1 1 auto",
    "min-width": "0",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  });
  row.append(title);

  if (threadActionsAvailable) {
    hoverButtons.push(
      actionButton(document, thread.pinned ? "取消置顶" : "置顶", thread.pinIcon, () =>
        handlers.toggleThreadPin(thread),
      ),
      actionButton(document, "归档", thread.archiveIcon, () => handlers.archiveThread(thread)),
    );
  }
  if (menuAvailable) {
    menuButton = iconButton(document, "对话操作", "⋯", () => handlers.openThreadMenu(thread, row));
    hoverButtons.push(menuButton);
  }
  for (const button of hoverButtons) actions.append(button);
  row.append(actions);

  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    handlers.openThreadMenu(thread, row, true);
  });
  const activate = (): void => handlers.openThread(thread);
  row.addEventListener("click", activate);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
  return row;
}

function actionRow(
  document: Document,
  text: string,
  action: string,
  onAction: () => void,
): HTMLElement {
  const row = document.createElement("div");
  style(row, {
    display: "flex",
    "align-items": "center",
    gap: "8px",
    "min-height": "26px",
    padding: "0 6px 0 30px",
    color: MUTED_COLOR,
    "font-size": "12px",
  });
  const label = document.createElement("span");
  label.textContent = text;
  style(label, { flex: "1 1 auto", "min-width": "0" });
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = action;
  style(button, {
    border: "0",
    background: "transparent",
    color: "var(--color-text-info, #4c8dff)",
    cursor: "pointer",
    "font-size": "12px",
    padding: "0",
    flex: "0 0 auto",
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onAction();
  });
  row.append(label, button);
  return row;
}

function projectContent(
  document: Document,
  projectView: ProjectGroupProjectView,
  handlers: ProjectGroupViewHandlers,
  menuAvailable: boolean,
  threadActionsAvailable: boolean,
): HTMLElement {
  const container = document.createElement("div");
  container.dataset.codexhostProjectGroupProject = projectView.project.entry?.projectId ?? "";
  const resolved = projectView.project;
  if (resolved.missing === "missing") {
    const message = document.createElement("div");
    message.textContent = "成员项目已不存在";
    style(message, {
      padding: "0 6px 0 30px",
      "min-height": "26px",
      display: "flex",
      "align-items": "center",
      color: statusColor("error"),
      "font-size": "12px",
    });
    container.append(
      message,
      actionRow(document, "请在组管理中移除或重新绑定", "管理", () => handlers.openManager()),
    );
    return container;
  }
  if (resolved.missing === "not-mounted") {
    const message = document.createElement("div");
    message.textContent = "该项目当前未显示在侧边栏";
    style(message, {
      padding: "0 6px 0 30px",
      "min-height": "26px",
      display: "flex",
      "align-items": "center",
      color: MUTED_COLOR,
      "font-size": "12px",
    });
    container.append(
      message,
      actionRow(document, "该项目在收起的列表中", "展开", () => handlers.showMoreProjects()),
    );
    return container;
  }
  if (!projectView.hasList) {
    const projectId = resolved.entry?.projectId;
    if (!projectId) return container;
    container.append(
      actionRow(document, "该项目在原生侧已折叠", "展开", () => handlers.expandProject(projectId)),
    );
    return container;
  }
  if (projectView.threads.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "暂无对话";
    style(empty, {
      padding: "0 6px 0 30px",
      "min-height": "26px",
      display: "flex",
      "align-items": "center",
      color: MUTED_COLOR,
      "font-size": "12px",
    });
    container.append(empty);
  } else {
    for (const thread of projectView.threads)
      container.append(
        threadRow(document, thread, handlers, menuAvailable, threadActionsAvailable),
      );
  }
  const entry = resolved.entry;
  if (projectView.canShowAll && entry) {
    container.append(
      actionRow(document, "仅显示部分对话", "查看全部", () => handlers.showAll(entry.projectId)),
    );
  }
  return container;
}

function machineSection(
  document: Document,
  machine: ProjectGroupModelView["machines"][number],
  handlers: ProjectGroupViewHandlers,
  menuAvailable: boolean,
  threadActionsAvailable: boolean,
): HTMLElement {
  const section = document.createElement("div");
  section.dataset.codexhostProjectGroupMachine = machine.key;
  style(section, { display: "flex", "flex-direction": "column", gap: "1px" });

  const header = document.createElement("div");
  style(header, {
    display: "flex",
    "align-items": "center",
    gap: "6px",
    "min-height": "24px",
    padding: "0 6px 0 26px",
    color: MUTED_COLOR,
    "font-size": "11px",
  });
  const label = document.createElement("span");
  label.textContent = machine.label;
  label.title = machine.label;
  style(label, {
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
    flex: "1 1 auto",
  });
  header.append(statusDot(document, machine.state), label);
  section.append(header);

  if (machine.projects.length > 1) {
    for (const project of machine.projects) {
      const projectLabel = project.project.entry?.label ?? project.project.member.label;
      const projectHeader = document.createElement("div");
      projectHeader.textContent = projectLabel;
      style(projectHeader, {
        padding: "0 6px 0 30px",
        "min-height": "22px",
        display: "flex",
        "align-items": "center",
        color: MUTED_COLOR,
        "font-size": "11px",
        "font-weight": "500",
      });
      section.append(
        projectHeader,
        projectContent(document, project, handlers, menuAvailable, threadActionsAvailable),
      );
    }
  } else {
    for (const project of machine.projects)
      section.append(
        projectContent(document, project, handlers, menuAvailable, threadActionsAvailable),
      );
  }
  return section;
}

function groupRow(
  document: Document,
  view: ProjectGroupModelView,
  collapsed: boolean,
  handlers: ProjectGroupViewHandlers,
): HTMLElement {
  const row = document.createElement("div");
  row.dataset.codexhostProjectGroupRow = view.group.id;
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.setAttribute("aria-expanded", String(!collapsed));
  row.setAttribute("aria-label", `${view.group.name}，项目组`);
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
  name.textContent = view.group.name;
  style(name, {
    flex: "1 1 auto",
    "min-width": "0",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  });
  row.append(name);

  const summary = projectGroupMachineSummary(view.machines);
  const machines = document.createElement("span");
  machines.textContent = summary.text;
  machines.title = summary.title;
  machines.setAttribute("aria-label", summary.title);
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
      handlers.openNewChat(view.group.id, event.currentTarget as HTMLElement),
    ),
    iconButton(document, "管理项目组", "⋯", () => handlers.openManager(view.group.id)),
  );
  row.append(actions);

  const toggle = (): void => handlers.toggleGroup(view.group.id);
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
  return row;
}

function signature(
  views: readonly ProjectGroupModelView[],
  options: ProjectGroupViewOptions,
): string {
  return JSON.stringify([
    [...options.collapsedGroups].sort(),
    options.menuAvailable,
    options.threadActionsAvailable,
    views.map((view) => [
      view.group.id,
      view.group.name,
      view.group.order,
      view.machines.map((machine) => [
        machine.key,
        machine.label,
        machine.state,
        machine.projects.map((project) => [
          project.project.entry?.projectId ?? project.project.member.projectId,
          project.project.entry?.label ?? project.project.member.label,
          project.project.missing,
          project.collapsed,
          project.hasList,
          project.showAll,
          project.threads.map((thread) => [
            thread.threadId,
            thread.title,
            thread.providerIcon ? "icon" : "",
            thread.selected,
            thread.active,
            thread.pinned,
          ]),
        ]),
      ]),
    ]),
  ]);
}

export class ProjectGroupView {
  readonly #document: Document;
  readonly #handlers: ProjectGroupViewHandlers;
  #root: HTMLElement | null = null;
  #signature = "";

  constructor(document: Document, handlers: ProjectGroupViewHandlers) {
    this.#document = document;
    this.#handlers = handlers;
  }

  render(views: readonly ProjectGroupModelView[], options: ProjectGroupViewOptions): void {
    const section = findProjectsSection(this.#document);
    if (!section) {
      this.dispose();
      return;
    }
    const list = findProjectList(section);
    const host = list?.parentElement ?? null;
    if (!list || !host) {
      this.dispose();
      return;
    }
    if (!this.#root) {
      this.#root = this.#document.createElement("div");
      this.#root.setAttribute("data-codexhost-project-groups-root", "");
      this.#root.setAttribute("role", "group");
      this.#root.setAttribute("aria-label", "跨机项目组");
      style(this.#root, { display: "flex", "flex-direction": "column", gap: "1px" });
    }
    if (this.#root.parentElement !== host || this.#root.nextElementSibling !== list)
      host.insertBefore(this.#root, list);

    if (views.length === 0) {
      const emptySignature = "empty";
      if (this.#signature === emptySignature) return;
      const empty = this.#document.createDocumentFragment();
      empty.append(this.#createRow());
      this.#root.replaceChildren(empty);
      this.#signature = emptySignature;
      return;
    }

    const nextSignature = signature(views, options);
    if (nextSignature === this.#signature) return;

    const fragment = this.#document.createDocumentFragment();
    for (const view of views) {
      fragment.append(
        groupRow(this.#document, view, options.collapsedGroups.has(view.group.id), this.#handlers),
      );
      if (options.collapsedGroups.has(view.group.id)) continue;
      const content = this.#document.createElement("div");
      content.dataset.codexhostProjectGroupContent = view.group.id;
      style(content, {
        display: "flex",
        "flex-direction": "column",
        gap: "1px",
        "padding-bottom": "4px",
      });
      for (const machine of view.machines)
        content.append(
          machineSection(
            this.#document,
            machine,
            this.#handlers,
            options.menuAvailable,
            options.threadActionsAvailable,
          ),
        );
      if (view.unresolved.length > 0) {
        const warning = this.#document.createElement("div");
        warning.textContent = `${view.unresolved.length} 个成员项目当前不可用`;
        style(warning, {
          padding: "0 6px 0 26px",
          color: statusColor("error"),
          "font-size": "11px",
          "min-height": "22px",
          display: "flex",
          "align-items": "center",
        });
        content.append(warning);
      }
      fragment.append(content);
    }
    fragment.append(this.#createRow());

    this.#root.replaceChildren(fragment);
    this.#signature = nextSignature;
  }

  #createRow(): HTMLElement {
    const create = this.#document.createElement("div");
    create.setAttribute("role", "button");
    create.tabIndex = 0;
    create.dataset.codexhostProjectGroupCreate = "";
    create.textContent = "＋ 新建项目组";
    style(create, {
      display: "flex",
      "align-items": "center",
      height: "28px",
      padding: "0 6px 0 26px",
      color: MUTED_COLOR,
      cursor: "pointer",
      "font-size": "12px",
      "border-radius": ROW_RADIUS,
    });
    create.addEventListener("click", () => this.#handlers.openManager());
    create.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.#handlers.openManager();
      }
    });
    return create;
  }

  dispose(): void {
    this.#root?.remove();
    this.#root = null;
    this.#signature = "";
  }
}
