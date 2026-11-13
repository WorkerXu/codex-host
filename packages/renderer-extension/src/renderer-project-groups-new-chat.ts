import type {
  MachineConnectionState,
  ProjectGroupAddMachineResult,
  ProjectGroupAddMachineTarget,
  ProjectGroupProjectView,
  ProjectGroupView,
} from "./renderer-project-groups-model.js";

export type { ProjectGroupAddMachineTarget } from "./renderer-project-groups-model.js";

const MENU_WIDTH = 280;
const MENU_MAX_HEIGHT = 420;
const ROW_HEIGHT = "36px";
const ROW_FONT = "400 14px/20px system-ui, sans-serif";
const TERTIARY = "var(--color-token-text-tertiary, #8b8b8b)";
const SECONDARY = "var(--color-token-text-secondary, #6b6b6b)";

function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
}

function statusColor(state: MachineConnectionState | "ready" | "offline" | "error"): string {
  switch (state) {
    case "connected":
    case "ready":
      return "var(--color-token-charts-green, #3fb950)";
    case "connecting":
      return "var(--color-token-charts-yellow, #d29922)";
    case "error":
      return "var(--color-token-charts-red, #f85149)";
    default:
      return "var(--color-token-text-tertiary, #8b8b8b)";
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(document: Document, paths: readonly string[], size = 18): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.style.color = TERTIARY;
  svg.style.flex = "0 0 auto";
  for (const definition of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", definition);
    svg.append(path);
  }
  return svg;
}

function serverIcon(document: Document): SVGElement {
  return icon(document, ["M4 4h16v6H4z", "M4 14h16v6H4z", "M7 7h.01", "M7 17h.01"]);
}

function plusIcon(document: Document): SVGElement {
  return icon(document, ["M12 5v14", "M5 12h14"], 16);
}

function chevronLeftIcon(document: Document): SVGElement {
  const svg = icon(document, ["m15 18-6-6 6-6"], 16);
  svg.style.color = SECONDARY;
  return svg;
}

function statusDot(
  document: Document,
  state: MachineConnectionState | "ready" | "offline" | "error",
): HTMLElement {
  const dot = document.createElement("span");
  style(dot, {
    width: "5px",
    height: "5px",
    flex: "0 0 auto",
    "border-radius": "999px",
    background: statusColor(state),
  });
  return dot;
}

function rowButton(document: Document, height = ROW_HEIGHT): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.setAttribute("role", "menuitem");
  style(row, {
    display: "flex",
    width: "100%",
    "min-width": "0",
    height,
    "align-items": "center",
    gap: "8px",
    padding: "0 8px",
    color: "inherit",
    background: "transparent",
    border: "0",
    "border-radius": "8px",
    cursor: "pointer",
    font: ROW_FONT,
    "text-align": "left",
  });
  row.addEventListener("pointerenter", () => {
    if (!row.disabled)
      row.style.background = "var(--color-token-list-hover-background, rgba(127,127,127,0.1))";
  });
  row.addEventListener("pointerleave", () => {
    row.style.background = "transparent";
  });
  return row;
}

function label(document: Document, text: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = text;
  style(span, {
    "min-width": "0",
    flex: "1 1 auto",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  });
  return span;
}

export function newChatProjectDisabled(
  project: ProjectGroupProjectView,
  state: MachineConnectionState,
): boolean {
  return (
    project.project.missing !== null ||
    !project.newChatAvailable ||
    state === "disconnected" ||
    state === "error"
  );
}

export interface ProjectGroupNewChatPickerOptions {
  document: Document;
  window: Window;
  onSelect(project: ProjectGroupProjectView): void;
  /** Ready and offline machines that can be mirrored into the group. */
  loadAddTargets?(groupId: string): Promise<readonly ProjectGroupAddMachineTarget[]>;
  onAddMachine?(
    groupId: string,
    target: ProjectGroupAddMachineTarget,
  ): Promise<ProjectGroupAddMachineResult> | undefined;
  onClosed?(): void;
}

export class ProjectGroupNewChatPicker {
  readonly #document: Document;
  readonly #window: Window;
  readonly #options: ProjectGroupNewChatPickerOptions;
  #popover: HTMLElement | null = null;
  readonly #targets = new Map<string, ProjectGroupAddMachineTarget>();

  constructor(options: ProjectGroupNewChatPickerOptions) {
    this.#document = options.document;
    this.#window = options.window;
    this.#options = options;
  }

  open(view: ProjectGroupView, anchor: HTMLElement): void {
    this.close();
    const rect = anchor.getBoundingClientRect();
    const popover = this.#document.createElement("div");
    popover.setAttribute("data-codexhost-project-groups-new-chat", "");
    popover.setAttribute("role", "menu");
    popover.setAttribute("aria-label", "选择新建对话的机器");
    style(popover, {
      position: "fixed",
      top: `${Math.max(8, Math.min(rect.bottom + 4, this.#window.innerHeight - MENU_MAX_HEIGHT))}px`,
      left: `${Math.max(8, Math.min(rect.left, this.#window.innerWidth - MENU_WIDTH - 8))}px`,
      width: `${MENU_WIDTH}px`,
      "max-height": `${MENU_MAX_HEIGHT}px`,
      display: "flex",
      "flex-direction": "column",
      overflow: "hidden",
      "z-index": "2147483000",
      background: "var(--color-token-dropdown-background, #fff)",
      color: "var(--color-token-text-primary, #111)",
      border: "1px solid var(--color-token-border-default, rgba(13,13,13,0.08))",
      "border-radius": "var(--menu-radius, 12px)",
      "box-shadow": "var(--menu-box-shadow, 0 10px 30px rgba(0,0,0,0.22))",
      padding: "4px",
    });

    const scroll = this.#document.createElement("div");
    style(scroll, {
      display: "flex",
      "flex-direction": "column",
      "min-height": "0",
      "overflow-y": "auto",
      gap: "2px",
    });
    const footer = this.#document.createElement("div");
    style(footer, {
      flex: "none",
      "border-top": "1px solid var(--color-token-border-light, rgba(127,127,127,0.14))",
      "margin-top": "4px",
      "padding-top": "4px",
    });

    for (const machine of view.machines) {
      const header = this.#document.createElement("div");
      header.textContent = machine.label;
      style(header, {
        display: "flex",
        "align-items": "center",
        gap: "6px",
        padding: "6px 8px 4px",
        color: TERTIARY,
        "font-size": "12px",
        "line-height": "18px",
      });
      header.prepend(statusDot(this.#document, machine.state));
      scroll.append(header);
      for (const project of machine.projects) {
        const projectLabel = project.project.entry?.label ?? project.project.member.label;
        const disabled = newChatProjectDisabled(project, machine.state);
        const row = rowButton(this.#document);
        row.disabled = disabled;
        row.textContent = projectLabel;
        row.setAttribute("aria-label", projectLabel);
        if (disabled) {
          row.style.color = TERTIARY;
          row.style.cursor = "default";
          row.style.opacity = "0.5";
        }
        row.addEventListener("click", () => {
          if (disabled) return;
          this.close();
          this.#options.onSelect(project);
        });
        scroll.append(row);
      }
    }
    if (view.machines.length === 0) {
      scroll.append(this.#line("这个项目组还没有机器", TERTIARY));
    }

    const addRow = rowButton(this.#document);
    addRow.setAttribute("data-codexhost-add-machine-row", "");
    addRow.setAttribute("role", "menuitem");
    addRow.append(plusIcon(this.#document), label(this.#document, "添加机器…"));
    addRow.addEventListener("click", () => this.#showMachineMenu(popover, view));
    footer.append(addRow);

    popover.append(scroll, footer);
    this.#mount(popover);
  }

  #showMachineMenu(popover: HTMLElement, view: ProjectGroupView): void {
    if (this.#popover !== popover) return;
    popover.replaceChildren();
    const menu = this.#document.createElement("div");
    menu.setAttribute("data-codexhost-add-machine-menu", "");
    style(menu, {
      display: "flex",
      "min-height": "0",
      "flex-direction": "column",
      gap: "2px",
      "overflow-y": "auto",
    });

    const heading = this.#document.createElement("div");
    style(heading, {
      display: "flex",
      "align-items": "center",
      gap: "4px",
      padding: "2px 2px 4px",
      color: TERTIARY,
      "font-size": "12px",
      "line-height": "20px",
    });
    const back = this.#document.createElement("button");
    back.type = "button";
    back.setAttribute("aria-label", "返回");
    style(back, {
      display: "inline-flex",
      width: "24px",
      height: "24px",
      "align-items": "center",
      "justify-content": "center",
      padding: "0",
      color: SECONDARY,
      background: "transparent",
      border: "0",
      "border-radius": "6px",
      cursor: "pointer",
    });
    back.append(chevronLeftIcon(this.#document));
    back.addEventListener("click", () => {
      const rect = popover.getBoundingClientRect();
      this.open(view, { getBoundingClientRect: () => rect } as HTMLElement);
    });
    const headingText = this.#document.createElement("span");
    headingText.textContent = "添加机器";
    heading.append(back, headingText);
    menu.append(heading);

    const body = this.#document.createElement("div");
    style(body, { display: "flex", "flex-direction": "column", gap: "2px" });
    body.append(this.#line("正在查找可用机器…", TERTIARY));
    menu.append(body);
    popover.append(menu);

    const renderTargets = (targets: readonly ProjectGroupAddMachineTarget[]): void => {
      if (this.#popover !== popover) return;
      body.replaceChildren();
      this.#targets.clear();
      if (targets.length === 0) {
        body.append(this.#line("没有可添加的机器", TERTIARY));
        return;
      }
      for (const target of targets) {
        this.#targets.set(target.hostId, target);
        body.append(this.#machineRow(view, target, body));
      }
    };
    const request = this.#options.loadAddTargets?.(view.group.id) ?? Promise.resolve([]);
    void request.then(renderTargets).catch(() => renderTargets([]));
  }

  #machineRow(
    view: ProjectGroupView,
    target: ProjectGroupAddMachineTarget,
    body: HTMLElement,
  ): HTMLElement {
    const wrapper = this.#document.createElement("div");
    const row = rowButton(this.#document);
    row.setAttribute("data-codexhost-add-machine-host", target.hostId);
    const unavailable = target.state !== "ready" || target.harnessId === null;
    row.disabled = unavailable;
    row.setAttribute(
      "aria-label",
      `${target.machineLabel}${target.state === "offline" ? " 离线" : ""}`,
    );
    if (unavailable) {
      row.style.cursor = "default";
      row.style.opacity = "0.45";
    }
    row.append(
      serverIcon(this.#document),
      label(this.#document, target.machineLabel),
      statusDot(this.#document, target.state),
    );
    wrapper.append(row);
    const error = this.#line("", "var(--color-token-charts-red, #f85149)");
    error.hidden = true;
    wrapper.append(error);

    row.addEventListener("click", () => {
      if (unavailable || row.getAttribute("aria-busy") === "true") return;
      const rows: { row: HTMLButtonElement; target: ProjectGroupAddMachineTarget }[] = [];
      for (const candidate of body.querySelectorAll<HTMLButtonElement>(
        "[data-codexhost-add-machine-host]",
      )) {
        const candidateTarget = this.#targets.get(
          candidate.getAttribute("data-codexhost-add-machine-host") ?? "",
        );
        if (candidateTarget) rows.push({ row: candidate, target: candidateTarget });
        candidate.disabled = true;
        candidate.style.opacity = "0.45";
      }
      row.setAttribute("aria-busy", "true");
      const dot = row.lastElementChild;
      dot?.replaceWith(this.#spinner());
      error.hidden = true;
      const finish = (result: ProjectGroupAddMachineResult | undefined): void => {
        if (!wrapper.isConnected) return;
        if (!result || result.ok) {
          this.close();
          return;
        }
        row.removeAttribute("aria-busy");
        row.lastElementChild?.replaceWith(statusDot(this.#document, target.state));
        for (const candidate of rows) {
          candidate.row.disabled =
            candidate.target.state !== "ready" || candidate.target.harnessId === null;
          candidate.row.style.opacity = candidate.row.disabled ? "0.45" : "1";
        }
        error.hidden = false;
        error.textContent = result.message ?? "添加机器失败，请稍后重试。";
      };
      Promise.resolve(this.#options.onAddMachine?.(view.group.id, target))
        .then(finish)
        .catch((failure: unknown) =>
          finish({
            ok: false,
            message: failure instanceof Error ? failure.message : "添加机器失败，请稍后重试。",
          }),
        );
    });
    return wrapper;
  }

  #spinner(): HTMLElement {
    const spinner = this.#document.createElement("span");
    style(spinner, {
      width: "12px",
      height: "12px",
      flex: "0 0 auto",
      border: "1.5px solid var(--color-token-text-tertiary, #8b8b8b)",
      "border-right-color": "transparent",
      "border-radius": "999px",
    });
    spinner.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
      duration: 800,
      iterations: Number.POSITIVE_INFINITY,
    });
    return spinner;
  }

  #line(text: string, color: string): HTMLElement {
    const line = this.#document.createElement("div");
    line.textContent = text;
    style(line, {
      padding: "4px 8px 8px",
      color,
      "font-size": "12px",
      "line-height": "18px",
      "white-space": "normal",
    });
    return line;
  }

  #cleanup: (() => void) | null = null;
  #listenerTimer: number | null = null;

  #mount(popover: HTMLElement): void {
    this.#document.body.append(popover);
    this.#popover = popover;
    const onPointerDown = (event: PointerEvent): void => {
      if (!popover.contains(event.target as Node)) this.close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") this.close();
    };
    this.#listenerTimer = this.#window.setTimeout(() => {
      this.#listenerTimer = null;
      this.#document.addEventListener("pointerdown", onPointerDown, true);
      this.#document.addEventListener("keydown", onKeyDown, true);
    }, 0);
    this.#cleanup = () => {
      this.#document.removeEventListener("pointerdown", onPointerDown, true);
      this.#document.removeEventListener("keydown", onKeyDown, true);
    };
  }

  close(): void {
    const wasOpen = this.#popover !== null;
    if (this.#listenerTimer !== null) this.#window.clearTimeout(this.#listenerTimer);
    this.#listenerTimer = null;
    this.#cleanup?.();
    this.#cleanup = null;
    this.#popover?.remove();
    this.#popover = null;
    if (wasOpen) this.#options.onClosed?.();
  }

  dispose(): void {
    this.close();
  }
}
