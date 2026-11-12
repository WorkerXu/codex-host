import type {
  CrossHostMachine,
  CrossHostModel,
  CrossHostModelCatalog,
} from "./renderer-cross-host-model-catalog.js";
import {
  crossHostMenuRows,
  machineStatusLabel,
  type CrossHostMenuExpansion,
  type CrossHostMenuSelection,
} from "./renderer-cross-host-model-menu.js";

export interface CrossHostModelSectionOptions {
  document: Document;
  catalog: CrossHostModelCatalog;
  acknowledged: boolean;
  onAcknowledge(): void;
  onSelect(selection: CrossHostMenuSelection): void;
  onClose(): void;
}

export interface CrossHostModelSection {
  element: HTMLElement;
  refresh(catalog: CrossHostModelCatalog, acknowledged: boolean): void;
  dispose(): void;
}

function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
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

function rowButton(document: Document, depth: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.gap = "6px";
  button.style.width = "100%";
  button.style.minWidth = "0";
  button.style.padding = `6px 8px 6px ${8 + depth * 16}px`;
  button.style.border = "0";
  button.style.borderRadius = "6px";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.font = "400 13px/18px system-ui, sans-serif";
  button.style.textAlign = "left";
  button.style.cursor = "pointer";
  button.addEventListener("pointerenter", () => {
    button.style.background = "rgba(127, 127, 127, 0.1)";
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

/**
 * Appended to the native model menu. Rows are plain DOM outside React's keyed
 * children; the caller re-appends the section if React replaces the menu body.
 */
export function createCrossHostModelSection(
  options: CrossHostModelSectionOptions,
): CrossHostModelSection {
  const { document } = options;
  let catalog = options.catalog;
  let acknowledged = options.acknowledged;
  let expansion: CrossHostMenuExpansion = { hostId: null, providerId: null };

  const element = document.createElement("div");
  element.setAttribute("data-codexhost-cross-host-model-menu", "");
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
  style(heading, {
    padding: "4px 8px",
    color: "var(--color-text-tertiary, #8b8b8b)",
    font: "500 11px/16px system-ui, sans-serif",
  });

  const body = document.createElement("div");
  style(body, {
    display: "flex",
    "flex-direction": "column",
    gap: "2px",
    "max-height": "320px",
    overflow: "auto",
  });

  const arrow = (expanded: boolean): HTMLSpanElement => {
    const span = document.createElement("span");
    span.textContent = expanded ? "▾" : "▸";
    span.setAttribute("aria-hidden", "true");
    span.style.flex = "none";
    span.style.color = "var(--color-text-tertiary, #8b8b8b)";
    return span;
  };

  const render = (): void => {
    for (const child of [...body.children]) child.remove();
    if (!acknowledged) {
      const hint = document.createElement("div");
      hint.textContent = "把对话放到另一台机器上运行；首次使用需要确认此项目是按名字自动创建的。";
      style(hint, {
        padding: "4px 8px",
        color: "var(--color-text-secondary, #777)",
        font: "400 12px/17px system-ui, sans-serif",
      });
      const enable = rowButton(document, 0);
      enable.textContent = "启用跨机对话";
      enable.style.color = "#6d9fff";
      enable.addEventListener("click", (event) => {
        event.preventDefault();
        options.onAcknowledge();
      });
      body.append(hint, enable);
      return;
    }
    if (catalog.machines.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "没有已连接的远程机器";
      style(empty, {
        padding: "4px 8px",
        color: "var(--color-text-tertiary, #8b8b8b)",
        font: "400 12px/17px system-ui, sans-serif",
      });
      body.append(empty);
      return;
    }
    for (const row of crossHostMenuRows(catalog, expansion)) {
      if (row.kind === "machine") {
        const button = rowButton(document, 0);
        button.setAttribute("aria-label", `${row.label}${machineStatusLabel(row.state)}`);
        button.disabled = row.state !== "ready";
        if (row.state !== "ready") button.setAttribute("aria-disabled", "true");
        const dot = document.createElement("span");
        style(dot, {
          width: "6px",
          height: "6px",
          flex: "0 0 auto",
          "border-radius": "999px",
          background: statusColor(row.state),
        });
        const status = machineStatusLabel(row.state);
        button.append(dot, text(document, row.label));
        if (status) {
          const badge = text(document, status, false);
          badge.style.color = "var(--color-text-tertiary, #8b8b8b)";
          badge.style.fontSize = "11px";
          button.append(badge);
        }
        button.append(arrow(row.expanded));
        button.addEventListener("click", (event) => {
          event.preventDefault();
          expansion = {
            hostId: row.expanded ? null : row.hostId,
            providerId: null,
          };
          render();
        });
        body.append(button);
        continue;
      }
      if (row.kind === "provider") {
        const button = rowButton(document, 1);
        button.setAttribute("aria-label", row.label);
        button.append(text(document, row.label), arrow(row.expanded));
        button.addEventListener("click", (event) => {
          event.preventDefault();
          const key = `${row.hostId}\u0000${row.providerId}`;
          expansion = {
            hostId: row.hostId,
            providerId: expansion.providerId === key ? null : key,
          };
          render();
        });
        body.append(button);
        continue;
      }
      const machine = catalog.machines.find((candidate) => candidate.hostId === row.hostId);
      if (!machine) continue;
      const button = rowButton(document, 2);
      button.setAttribute("aria-label", row.model.label);
      const model: CrossHostModel = row.model;
      button.append(text(document, row.model.label, true));
      if (row.model.isDefault) {
        const badge = text(document, "默认", false);
        badge.style.color = "var(--color-text-tertiary, #8b8b8b)";
        badge.style.fontSize = "11px";
        button.append(badge);
      }
      button.addEventListener("click", (event) => {
        event.preventDefault();
        options.onClose();
        options.onSelect({
          machine,
          providerId: row.providerId,
          providerLabel: row.providerLabel,
          model,
        });
      });
      body.append(button);
    }
  };

  render();
  element.append(separator, heading, body);

  return {
    element,
    refresh(nextCatalog, nextAcknowledged) {
      catalog = nextCatalog;
      acknowledged = nextAcknowledged;
      if (!catalog.machines.some((machine) => machine.hostId === expansion.hostId))
        expansion = { hostId: null, providerId: null };
      render();
    },
    dispose() {
      element.remove();
    },
  };
}
