import createElement from "lucide/dist/esm/createElement.mjs";
import Server from "lucide/dist/esm/icons/server.mjs";

import { createRendererAgentIcon } from "./renderer-agent-icon.js";
import type {
  CrossHostHarness,
  CrossHostHarnessCatalog,
  CrossHostMachine,
} from "./renderer-cross-host-harness-catalog.js";

export interface CrossHostAgentSelection {
  machine: CrossHostMachine;
  harness: CrossHostHarness;
}

export interface CrossHostAgentSectionOptions {
  document: Document;
  catalog: CrossHostHarnessCatalog;
  acknowledged: boolean;
  loading?: boolean;
  error?: string | null;
  onAcknowledge(): void;
  onSelect(selection: CrossHostAgentSelection): void;
  onClose(): void;
}

export interface CrossHostAgentSectionState {
  loading?: boolean;
  error?: string | null;
}

export interface CrossHostAgentSection {
  element: HTMLElement;
  refresh(
    catalog: CrossHostHarnessCatalog,
    acknowledged: boolean,
    state?: CrossHostAgentSectionState,
  ): void;
  dispose(): void;
}

const ROW_HEIGHT = "36px";
const ROW_FONT = "500 13px/1 system-ui, sans-serif";
const ROW_RADIUS = "4px";
const TERTIARY = "var(--color-text-tertiary, #8b8b8b)";

export function machineStatusLabel(state: CrossHostMachine["state"]): string {
  switch (state) {
    case "ready":
      return "";
    case "offline":
      return "离线";
    case "error":
      return "列表不可用";
    default:
      return "";
  }
}

function statusColor(state: CrossHostMachine["state"]): string {
  switch (state) {
    case "ready":
      return "var(--color-chart-green, #3fb950)";
    case "error":
      return "var(--color-chart-red, #f85149)";
    default:
      return "#8b8b8b";
  }
}

function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
}

function rowButton(document: Document, depth: number, rightPadding: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  style(button, {
    display: "flex",
    "align-items": "center",
    gap: "8px",
    width: "100%",
    "min-width": "0",
    height: ROW_HEIGHT,
    padding: `0 ${rightPadding}px 0 ${8 + depth * 20}px`,
    border: "0",
    "border-radius": ROW_RADIUS,
    background: "transparent",
    color: "inherit",
    font: ROW_FONT,
    "letter-spacing": "0",
    "text-align": "left",
    cursor: "pointer",
  });
  button.addEventListener("pointerenter", () => {
    if (!button.disabled) button.style.background = "rgba(127, 127, 127, 0.1)";
  });
  button.addEventListener("pointerleave", () => {
    button.style.background = "transparent";
  });
  return button;
}

function text(document: Document, value: string, flex = true): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = value;
  span.style.minWidth = "0";
  span.style.overflow = "hidden";
  span.style.textOverflow = "ellipsis";
  span.style.whiteSpace = "nowrap";
  if (flex) span.style.flex = "1 1 auto";
  return span;
}

function chevron(document: Document, expanded: boolean): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  svg.style.flex = "0 0 auto";
  svg.style.color = TERTIARY;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", expanded ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function statusDot(document: Document, state: CrossHostMachine["state"]): HTMLSpanElement {
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

function serverIcon(): Element {
  const icon = createElement(Server, {
    width: 18,
    height: 18,
    "aria-hidden": "true",
    focusable: "false",
    "stroke-width": 1.8,
  });
  icon.style.color = TERTIARY;
  icon.style.flex = "0 0 auto";
  return icon;
}

function secondaryLine(document: Document, message: string, depth = 0): HTMLElement {
  const line = document.createElement("div");
  line.textContent = message;
  style(line, {
    padding: `6px 8px 6px ${8 + depth * 20}px`,
    color: TERTIARY,
    font: "400 12px/17px system-ui, sans-serif",
    "white-space": "normal",
  });
  return line;
}

/**
 * Appended to the codexhost Agent picker. Rows intentionally reuse the native
 * Agent row metrics so the cross-host section is visually part of the same
 * menu; the menu itself, not this section, owns scrolling.
 */
export function createCrossHostAgentSection(
  options: CrossHostAgentSectionOptions,
): CrossHostAgentSection {
  const { document } = options;
  let catalog = options.catalog;
  let acknowledged = options.acknowledged;
  let loading = options.loading ?? false;
  let error = options.error ?? null;
  let expandedHostId: string | null = null;

  const element = document.createElement("div");
  element.setAttribute("data-codexhost-cross-host-agent-menu", "");
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "其他机器");
  style(element, {
    display: "flex",
    "flex-direction": "column",
    gap: "2px",
    "padding-top": "4px",
  });

  const separator = document.createElement("div");
  separator.setAttribute("role", "separator");
  style(separator, {
    height: "1px",
    margin: "4px 0",
    background: "var(--color-border, rgba(127,127,127,0.2))",
  });

  const heading = document.createElement("div");
  heading.textContent = "其他机器";
  heading.setAttribute("role", "presentation");
  style(heading, {
    padding: "6px 8px 4px",
    color: TERTIARY,
    font: "400 14px/20px system-ui, sans-serif",
  });

  const body = document.createElement("div");
  style(body, {
    display: "flex",
    "flex-direction": "column",
    gap: "2px",
  });

  const render = (): void => {
    body.replaceChildren();
    if (!acknowledged) {
      const enable = rowButton(document, 0, 8);
      enable.textContent = "启用跨机对话";
      enable.style.color = "#6d9fff";
      enable.addEventListener("click", (event) => {
        event.preventDefault();
        options.onAcknowledge();
      });
      body.append(
        secondaryLine(
          document,
          "把对话放到另一台机器上运行；首次使用需要确认此项目是按名字自动创建的。",
        ),
        enable,
      );
      return;
    }
    if (loading) {
      body.append(secondaryLine(document, "正在加载其他机器…"));
      return;
    }
    if (error) {
      body.append(secondaryLine(document, error || "其他机器不可用"));
      return;
    }
    if (catalog.machines.length === 0) {
      body.append(secondaryLine(document, "没有其他机器"));
      return;
    }
    for (const machine of catalog.machines) {
      const expanded = expandedHostId === machine.hostId;
      const status = machineStatusLabel(machine.state);
      const button = rowButton(document, 0, 8);
      button.setAttribute("aria-label", `${machine.label}${status ? ` ${status}` : ""}`);
      button.setAttribute("aria-expanded", String(expanded));
      if (machine.state === "offline") {
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.style.cursor = "default";
        button.style.opacity = "0.45";
      }
      button.append(
        serverIcon(),
        text(document, machine.label),
        statusDot(document, machine.state),
        chevron(document, expanded),
      );
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (machine.state === "offline") return;
        expandedHostId = expanded ? null : machine.hostId;
        render();
      });
      body.append(button);
      if (!expanded) continue;
      if (machine.state === "error") body.append(secondaryLine(document, "Harness 列表不可用", 1));
      if (machine.harnesses.length === 0) {
        body.append(secondaryLine(document, "没有可用的 Harness", 1));
        continue;
      }
      for (const harness of machine.harnesses) {
        const row = rowButton(document, 1, 34);
        row.setAttribute("aria-label", `${machine.label} · ${harness.label}`);
        row.append(
          createRendererAgentIcon(harness.id, 20, document, harness.plugin),
          text(document, harness.label),
        );
        row.addEventListener("click", (event) => {
          event.preventDefault();
          options.onClose();
          options.onSelect({ machine, harness });
        });
        body.append(row);
      }
    }
  };

  render();
  element.append(separator, heading, body);

  return {
    element,
    refresh(nextCatalog, nextAcknowledged, state) {
      catalog = nextCatalog;
      acknowledged = nextAcknowledged;
      if (state?.loading !== undefined) loading = state.loading;
      if (state?.error !== undefined) error = state.error;
      if (
        expandedHostId &&
        !catalog.machines.some(
          (machine) => machine.hostId === expandedHostId && machine.state !== "offline",
        )
      )
        expandedHostId = null;
      render();
    },
    dispose() {
      element.remove();
    },
  };
}
