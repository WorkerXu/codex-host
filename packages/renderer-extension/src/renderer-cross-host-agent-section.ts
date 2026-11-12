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
  onAcknowledge(): void;
  onSelect(selection: CrossHostAgentSelection): void;
  onClose(): void;
}

export interface CrossHostAgentSection {
  element: HTMLElement;
  refresh(catalog: CrossHostHarnessCatalog, acknowledged: boolean): void;
  dispose(): void;
}

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
      return "var(--color-text-tertiary, #8b8b8b)";
  }
}

function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
}

function rowButton(document: Document, depth: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.gap = "6px";
  button.style.width = "100%";
  button.style.minWidth = "0";
  button.style.height = "32px";
  button.style.padding = `0 8px 0 ${8 + depth * 14}px`;
  button.style.border = "0";
  button.style.borderRadius = "4px";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.font = "500 12px/1 system-ui, sans-serif";
  button.style.textAlign = "left";
  button.style.cursor = "pointer";
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

function arrow(expanded: boolean): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = expanded ? "▾" : "▸";
  span.setAttribute("aria-hidden", "true");
  span.style.flex = "none";
  span.style.color = "var(--color-text-tertiary, #8b8b8b)";
  return span;
}

function note(document: Document, message: string): HTMLElement {
  const element = document.createElement("div");
  element.textContent = message;
  style(element, {
    padding: "4px 8px",
    color: "var(--color-text-secondary, #777)",
    font: "400 12px/17px system-ui, sans-serif",
  });
  return element;
}

/**
 * Appended to the codexhost Agent picker. The picker menu is React-owned but
 * its section list is replaced wholesale on regroup; this node stays at the
 * end and is re-rendered independently.
 */
export function createCrossHostAgentSection(
  options: CrossHostAgentSectionOptions,
): CrossHostAgentSection {
  const { document } = options;
  let catalog = options.catalog;
  let acknowledged = options.acknowledged;
  let expandedHostId: string | null = null;

  const element = document.createElement("div");
  element.setAttribute("data-codexhost-cross-host-agent-menu", "");
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "其他机器");
  style(element, {
    display: "flex",
    "flex-direction": "column",
    gap: "1px",
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
  style(heading, {
    padding: "4px 8px",
    color: "var(--color-text-tertiary, #8b8b8b)",
    font: "500 11px/16px system-ui, sans-serif",
  });

  const body = document.createElement("div");
  style(body, {
    display: "flex",
    "flex-direction": "column",
    gap: "1px",
    "max-height": "280px",
    overflow: "auto",
  });

  const render = (): void => {
    body.replaceChildren();
    if (!acknowledged) {
      const enable = rowButton(document, 0);
      enable.textContent = "启用跨机对话";
      enable.style.color = "#6d9fff";
      enable.addEventListener("click", (event) => {
        event.preventDefault();
        options.onAcknowledge();
      });
      body.append(
        note(document, "把对话放到另一台机器上运行；首次使用需要确认此项目是按名字自动创建的。"),
        enable,
      );
      return;
    }
    if (catalog.machines.length === 0) {
      body.append(note(document, "没有其他机器"));
      return;
    }
    for (const machine of catalog.machines) {
      const expanded = expandedHostId === machine.hostId;
      const button = rowButton(document, 0);
      const status = machineStatusLabel(machine.state);
      button.setAttribute("aria-label", `${machine.label}${status ? ` ${status}` : ""}`);
      button.setAttribute("aria-expanded", String(expanded));
      if (machine.state === "offline") {
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.style.cursor = "default";
      }
      const dot = document.createElement("span");
      style(dot, {
        width: "6px",
        height: "6px",
        flex: "0 0 auto",
        "border-radius": "999px",
        background: statusColor(machine.state),
      });
      button.append(dot, text(document, machine.label));
      if (status) {
        const badge = text(document, status, false);
        badge.style.color = "var(--color-text-tertiary, #8b8b8b)";
        badge.style.fontSize = "11px";
        button.append(badge);
      }
      button.append(arrow(expanded));
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (machine.state === "offline") return;
        expandedHostId = expanded ? null : machine.hostId;
        render();
      });
      body.append(button);
      if (!expanded) continue;
      if (machine.state === "error")
        body.append(note(document, "Harness 列表不可用，仅可选择 Codex"));
      for (const harness of machine.harnesses) {
        const row = rowButton(document, 1);
        row.setAttribute("aria-label", `${machine.label} · ${harness.label}`);
        row.append(text(document, harness.label));
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
    refresh(nextCatalog, nextAcknowledged) {
      catalog = nextCatalog;
      acknowledged = nextAcknowledged;
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
