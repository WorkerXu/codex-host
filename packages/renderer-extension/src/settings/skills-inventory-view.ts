import type { SkillAgent, SkillInventoryEntry, SkillMachine } from "@codexhost/shared-contracts";
import { skillsAgentIcons, type SkillsAgentPlugin } from "./skills-agent-icon.js";
import { skillsErrorText } from "../renderer-skills-client.js";
import { createRendererSettingsIcon, type RendererSettingsIconName } from "./icons.js";
import { skillButton, skillNode } from "./skills-dialog.js";
import { skillDirectory } from "./skills-presentation.js";
import { skillsClass } from "./skills-style.js";
import { hubAgeLabel } from "./hub-cache.js";

export interface SkillsViewState {
  tab: "library" | "agents";
  search: string;
  link: "all" | "linked" | "unlinked";
  machine: string;
  layout: "grid" | "list";
  agent: { hostId: string; agentId: string } | null;
}
export interface SkillsInventoryOptions {
  container: HTMLElement;
  machines: SkillMachine[];
  progress: Map<string, string>;
  /** When each machine's inventory last answered, including cached values. */
  updatedAt: ReadonlyMap<string, number>;
  state: SkillsViewState;
  onState(patch: Partial<SkillsViewState>): void;
  sync(skill: string, source?: string): void;
  linkAll(hostId: string): void;
  toggle(hostId: string, agentId: string, skill: string, linked: boolean): void;
  refresh(): void;
  pluginForHost?: SkillsAgentPlugin | undefined;
}
interface SkillsRenderOptions extends SkillsInventoryOptions {
  agentIcon: ReturnType<typeof skillsAgentIcons>;
}
type NodeFn = (tag: string, text?: string, className?: string) => HTMLElement;
type AgentState = SkillAgent["states"][string];
const STATUS: Record<AgentState, { label: string; className: string }> = {
  linked: { label: "已链接", className: "skills-status-linked" },
  missing: { label: "未链接", className: "skills-status-missing" },
  conflict: { label: "冲突", className: "skills-status-conflict" },
  native: { label: "原生支持", className: "skills-status-native" },
  managed: { label: "由 codexhost 管理", className: "skills-status-managed" },
};
function setClass(element: HTMLElement, name: string): void {
  element.className = skillsClass(name);
}
function ownIconButton(
  document: Document,
  label: string,
  icon: RendererSettingsIconName,
  pressed: boolean,
  run: () => void,
): HTMLButtonElement {
  const button = skillButton(document, "", run);
  setClass(button, "skills-layout-button");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.dataset.skillsFocus = label;
  button.setAttribute("aria-pressed", String(pressed));
  button.append(createRendererSettingsIcon(icon, 15));
  return button;
}
export function renderSkillsInventory(options: SkillsInventoryOptions): void {
  const { container, machines, state } = options;
  const document = container.ownerDocument;
  const node: NodeFn = (tag, text = "", className = "") =>
    skillNode(document, tag as keyof HTMLElementTagNameMap, text, className);
  const tree = container.getRootNode() as Document | ShadowRoot;
  const focused = tree.activeElement as HTMLElement | null;
  const focusKey = focused?.dataset.skillsFocus;
  const selection =
    focused instanceof HTMLInputElement ? (focused.selectionStart ?? focused.value.length) : null;
  container.replaceChildren();
  const tabs = node("div", "", "skills-tabs");
  tabs.setAttribute("role", "tablist");
  for (const [value, label] of [
    ["library", "技能库"],
    ["agents", "按 Agent"],
  ] as const) {
    const button = skillButton(document, label, () => options.onState({ tab: value, agent: null }));
    setClass(button, "skills-tab");
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.tab === value));
    button.dataset.skillsFocus = `tab-${value}`;
    tabs.append(button);
  }
  container.append(tabs);
  const progress = [...options.progress.values()].filter(Boolean).at(-1);
  if (progress) {
    const line = node("p", progress, "skills-muted");
    line.setAttribute("role", "status");
    container.append(line);
  }
  const renderOptions = {
    ...options,
    agentIcon: skillsAgentIcons(document, options.pluginForHost),
  };
  if (state.tab === "library") {
    renderLibrary(renderOptions, container, node);
  } else if (state.agent) {
    const machine = machines.find((item) => item.hostId === state.agent?.hostId);
    const agent = machine?.inventory?.agents.find((item) => item.id === state.agent?.agentId);
    if (machine && agent) renderAgentDetail(renderOptions, container, node, machine, agent);
    else options.onState({ agent: null });
  } else renderAgents(renderOptions, container, node);
  if (focusKey) {
    const target = container.querySelector<HTMLElement>(
      `[data-skills-focus="${CSS.escape(focusKey)}"]`,
    );
    target?.focus();
    if (target instanceof HTMLInputElement && selection !== null)
      target.setSelectionRange(selection, selection);
  }
}
function renderLibrary(options: SkillsRenderOptions, container: HTMLElement, node: NodeFn): void {
  const document = container.ownerDocument;
  const { machines, state } = options;
  const toolbar = node("div", "", "skills-toolbar");
  const search = node("input", "", "skills-search") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "搜索技能";
  search.setAttribute("aria-label", "搜索技能");
  search.dataset.skillsFocus = "search";
  search.value = state.search;
  search.addEventListener("input", (event) => {
    if (!(event as InputEvent).isComposing) options.onState({ search: search.value });
  });
  search.addEventListener("compositionend", () => options.onState({ search: search.value }));
  const filters = node("div", "", "skills-segmented");
  for (const [value, label] of [
    ["all", "全部"],
    ["linked", "已链接"],
    ["unlinked", "未链接"],
  ] as const) {
    const button = skillButton(document, label, () => options.onState({ link: value }));
    setClass(button, "skills-filter");
    button.setAttribute("aria-pressed", String(state.link === value));
    button.dataset.skillsFocus = `filter-${value}`;
    filters.append(button);
  }
  const machine = node("select", "", "skills-select") as HTMLSelectElement;
  machine.setAttribute("aria-label", "筛选机器");
  machine.dataset.skillsFocus = "machine";
  machine.append(new Option("全部机器", ""));
  for (const item of machines) machine.append(new Option(item.name, item.hostId));
  machine.value = state.machine;
  machine.addEventListener("change", () => options.onState({ machine: machine.value }));
  const layouts = node("div", "", "skills-layout-toggle");
  layouts.append(
    ownIconButton(document, "卡片视图", "dashboard", state.layout === "grid", () =>
      options.onState({ layout: "grid" }),
    ),
    ownIconButton(document, "列表视图", "logs", state.layout === "list", () =>
      options.onState({ layout: "list" }),
    ),
  );
  toolbar.append(search, filters, machine, layouts);
  container.append(toolbar);

  const skills = new Map<
    string,
    {
      key: string;
      name: string;
      description: string;
      source: string | null;
      entries: Map<string, SkillInventoryEntry>;
    }
  >();
  for (const item of machines) {
    for (const entry of item.inventory?.skills ?? []) {
      const existing = skills.get(entry.key);
      if (existing) {
        existing.entries.set(item.hostId, entry);
        if (!existing.description) existing.description = entry.description;
        existing.source ??= entry.source?.source ?? null;
      } else
        skills.set(entry.key, {
          key: entry.key,
          name: entry.name,
          description: entry.description,
          source: entry.source?.source ?? null,
          entries: new Map([[item.hostId, entry]]),
        });
    }
  }
  const badgeMachine =
    (state.machine ? machines.find((item) => item.hostId === state.machine) : undefined) ??
    machines.find((item) => item.hostId === "local" && item.inventory) ??
    machines.find((item) => item.inventory);
  const badgeAgents = badgeMachine?.inventory?.agents ?? [];
  const rows = [...skills.values()]
    .filter((skill) => {
      const text = `${skill.key} ${skill.name} ${skill.description}`.toLowerCase();
      if (state.search && !text.includes(state.search.toLowerCase())) return false;
      if (state.machine && !skill.entries.has(state.machine)) return false;
      if (state.link === "all") return true;
      const linked = badgeAgents.some((agent) => {
        const status = agent.states[skill.key];
        return status === "linked" || status === "native";
      });
      return state.link === "linked" ? linked : !linked;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!rows.length) {
    container.append(node("p", "中央库中还没有匹配的技能", "skills-empty"));
    return;
  }
  const grid = node("div", "", state.layout === "grid" ? "skills-grid" : "skills-list");
  for (const skill of rows) {
    const fingerprints = new Set([...skill.entries.values()].map((entry) => entry.fingerprint));
    const differs = fingerprints.size > 1;
    const missing = machines.some((item) => item.inventory && !skill.entries.has(item.hostId));
    const card = node(
      "article",
      "",
      state.layout === "grid" ? "skills-card" : "skills-card skills-card-list",
    );
    const head = node("div", "", "skills-card-head");
    const title = node("h3", skill.name, "skills-card-name");
    title.title = skill.name;
    head.append(title);
    const version = [...skill.entries.values()].find((entry) => entry.version)?.version;
    if (version) head.append(node("span", version, "skills-version-chip"));
    card.append(head, node("p", skill.description || "暂无描述", "skills-card-description"));
    const meta = node("div", "", "skills-card-meta");
    const source = node("span", skill.source ? `git · ${skill.source}` : "本地", "skills-source");
    source.title = source.textContent ?? "";
    meta.append(source);
    card.append(meta);
    const chips = node("div", "", "skills-chips");
    for (const item of machines) {
      if (!item.inventory) {
        chips.append(node("span", `${item.name} 离线`, "skills-chip"));
        continue;
      }
      const entry = skill.entries.get(item.hostId);
      const stateName = !entry ? "缺失" : differs ? "版本不同" : "✓";
      const chip = node("span", `${item.name} ${stateName}`, "skills-chip");
      chip.dataset.state = !entry ? "missing" : differs ? "different" : "same";
      const age = options.updatedAt.get(item.hostId);
      if (age !== undefined) chip.title = `更新于 ${hubAgeLabel(age)}`;
      chips.append(chip);
    }
    if ((differs || missing) && machines.filter((item) => item.inventory).length > 1) {
      const sync = skillButton(document, "同步…", () => options.sync(skill.key));
      setClass(sync, "skills-chip-action");
      chips.append(sync);
    }
    card.append(chips);
    if (badgeMachine?.inventory) {
      const badges = node("div", "", "skills-badges");
      badges.setAttribute("aria-label", `${badgeMachine.name} 的 Agent 链接状态`);
      for (const agent of badgeAgents) {
        const status = agent.states[skill.key] ?? "missing";
        const linked = status === "linked";
        const native = status === "native";
        const managed = status === "managed";
        const button = skillButton(document, "", () => {
          if (native || managed) return;
          options.toggle(badgeMachine.hostId, agent.id, skill.key, linked);
        });
        setClass(button, "skills-badge");
        button.dataset.linked = String(linked || native);
        button.dataset.native = String(native);
        button.dataset.managed = String(managed);
        button.title = `${agent.name} · ${STATUS[status]?.label ?? "未链接"}`;
        button.setAttribute(
          "aria-label",
          `${agent.name} ${STATUS[status]?.label ?? "未链接"}${
            native || managed ? "" : linked ? "，点击解除链接" : "，点击建立链接"
          }`,
        );
        if (native || managed) button.setAttribute("aria-disabled", "true");
        button.dataset.skillsFocus = `badge-${badgeMachine.hostId}-${agent.id}-${skill.key}`;
        if (!skill.entries.has(badgeMachine.hostId)) {
          button.disabled = true;
          button.title = `请先同步到 ${badgeMachine.name}`;
          button.setAttribute("aria-label", `${agent.name} · 请先同步到 ${badgeMachine.name}`);
        }
        button.append(options.agentIcon(agent, badgeMachine.hostId));
        badges.append(button);
      }
      card.append(badges);
    }
    grid.append(card);
  }
  container.append(grid);
}
function renderAgents(options: SkillsRenderOptions, container: HTMLElement, node: NodeFn): void {
  const document = container.ownerDocument;
  const { machines } = options;
  let sections = 0;
  for (const machine of machines) {
    if (!machine.inventory) continue;
    sections++;
    const section = node("section", "", "skills-machine-group");
    const head = node("div", "", "skills-machine-heading");
    head.append(node("h3", machine.name));
    const age = options.updatedAt.get(machine.hostId);
    if (age !== undefined) head.append(node("span", `更新于 ${hubAgeLabel(age)}`, "skills-muted"));
    if (machine.inventory.agents.length) {
      const linkAll = skillButton(document, "一键链接", () => options.linkAll(machine.hostId));
      setClass(linkAll, "skills-chip-action");
      head.append(linkAll);
    }
    section.append(head);
    const progress = options.progress.get(machine.hostId);
    if (progress) {
      const status = node("p", progress, "skills-muted");
      status.setAttribute("role", "status");
      section.append(status);
    }
    const grid = node("div", "", "skills-agent-grid");
    for (const agent of machine.inventory.agents) {
      const card = node("button", "", "skills-agent-card") as HTMLButtonElement;
      card.type = "button";
      card.addEventListener("click", () =>
        options.onState({ agent: { hostId: machine.hostId, agentId: agent.id } }),
      );
      const icon = node("span", "", "skills-agent-icon");
      icon.append(options.agentIcon(agent, machine.hostId, 22));
      const info = node("div", "", "skills-agent-info");
      const title = node("div", "", "skills-agent-title");
      title.append(
        node("strong", agent.name),
        node("span", `${Object.keys(agent.states).length} 个技能`, "skills-muted"),
      );
      info.append(title, node("span", skillDirectory(agent.skillsDir), "skills-path"));
      const tags = node("div", "", "skills-agent-tags");
      if (agent.native === true) tags.append(node("span", "原生支持", "skills-chip"));
      if (agent.conflicts)
        tags.append(node("span", `${agent.conflicts} 个冲突`, "skills-status-conflict"));
      info.append(tags);
      card.append(icon, info);
      grid.append(card);
    }
    if (!machine.inventory.agents.length)
      grid.append(node("p", "这台机器上没有已安装的 Agent", "skills-empty"));
    section.append(grid);
    if (machine.inventory.warnings.length)
      section.append(
        node(
          "p",
          `${machine.inventory.warnings.length} 个技能或目录无法读取，请检查文件与权限`,
          "skills-empty",
        ),
      );
    container.append(section);
  }
  for (const machine of machines) {
    if (machine.inventory) continue;
    const section = node("section", "", "skills-machine-group");
    const head = node("div", "", "skills-machine-heading");
    head.append(node("h3", machine.name), node("span", "离线", "skills-chip"));
    section.append(
      head,
      node("p", skillsErrorText(machine.error), "skills-muted"),
      skillButton(document, "重试", options.refresh),
    );
    container.append(section);
  }
  if (!sections) container.append(node("p", "没有可用的机器", "skills-empty"));
}
function renderAgentDetail(
  options: SkillsRenderOptions,
  container: HTMLElement,
  node: NodeFn,
  machine: SkillMachine,
  agent: SkillAgent,
): void {
  const document = container.ownerDocument;
  const head = node("div", "", "skills-detail-head");
  const back = skillButton(document, "", () => options.onState({ agent: null }));
  setClass(back, "skills-back");
  back.setAttribute("aria-label", "返回所有 Agent");
  back.append(createRendererSettingsIcon("chevron-left", 16));
  const title = node("div", "", "skills-detail-title");
  const icon = node("span", "", "skills-agent-icon");
  icon.append(options.agentIcon(agent, machine.hostId, 24));
  const info = node("div", "", "skills-agent-info");
  const line = node("div", "", "skills-agent-title");
  line.append(node("h3", agent.name));
  if (agent.native === true) line.append(node("span", "原生支持", "skills-chip"));
  info.append(line, node("span", skillDirectory(agent.skillsDir), "skills-path"));
  title.append(icon, info);
  head.append(back, title);
  container.append(head);
  const skills = machine.inventory?.skills ?? [];
  const linked = Object.values(agent.states).filter((item) => item === "linked").length;
  const conflicts = Object.values(agent.states).filter((item) => item === "conflict").length;
  container.append(
    node(
      "p",
      agent.native === true
        ? `${skills.length} 个技能 · 原生支持`
        : `${skills.length} 个技能 · ${linked} 已链接 · ${conflicts} 冲突`,
      "skills-detail-stats",
    ),
  );
  if (!skills.length) {
    container.append(node("p", "中央库中还没有技能", "skills-empty"));
    return;
  }
  const grid = node("div", "", "skills-skill-grid");
  for (const entry of skills) {
    const state = agent.states[entry.key] ?? "missing";
    const card = node("article", "", "skills-skill-card");
    const top = node("div", "", "skills-skill-top");
    top.append(
      node("strong", entry.name),
      node("span", STATUS[state].label, `skills-state ${STATUS[state].className}`),
    );
    card.append(top, node("p", entry.description || "暂无描述", "skills-card-description"));
    grid.append(card);
  }
  container.append(grid);
}
