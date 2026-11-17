import type { SkillMachine } from "@codexhost/shared-contracts";
import { skillsErrorText } from "../renderer-skills-client.js";
import { skillButton, skillNode } from "./skills-dialog.js";
import { skillDirectory, skillStatus } from "./skills-presentation.js";
export function renderSkillsInventory(options: {
  matrix: HTMLElement;
  agents: HTMLElement;
  machines: SkillMachine[];
  progress: Map<string, string>;
  changes: Map<string, string[]>;
  sync(skill: string, source?: string): void;
  link(hostId: string): void;
  undo(hostId: string, id: string): void;
  refresh(): void;
}): void {
  const { matrix, agents, machines } = options,
    document = matrix.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") =>
    skillNode(document, tag, text, className);
  matrix.replaceChildren();
  agents.replaceChildren();
  const keys = [
    ...new Set(
      machines.flatMap((machine) => machine.inventory?.skills.map((skill) => skill.key) ?? []),
    ),
  ].sort();
  if (!keys.length) matrix.append(node("p", "中央库中还没有技能", "skills-empty"));
  else {
    const table = node("table"),
      thead = node("thead"),
      heading = node("tr");
    heading.append(node("th", "技能"));
    for (const machine of machines) heading.append(node("th", machine.name));
    const actionHeading = node("th");
    actionHeading.setAttribute("aria-label", "操作");
    heading.append(actionHeading);
    thead.append(heading);
    table.append(thead);
    const body = node("tbody");
    for (const key of keys) {
      const entries = machines.flatMap(
        (machine) => machine.inventory?.skills.filter((entry) => entry.key === key) ?? [],
      );
      const different = new Set(entries.map((entry) => entry.fingerprint)).size > 1;
      const missing = machines.some(
        (machine) =>
          machine.inventory && !machine.inventory.skills.some((entry) => entry.key === key),
      );
      const row = node("tr"),
        name = node("td");
      name.append(node("strong", key));
      const description = node("span", entries[0]?.description ?? "", "skills-description");
      description.title = description.textContent ?? "";
      name.append(description);
      row.append(name);
      for (const machine of machines) {
        const entry = machine.inventory?.skills.find((skill) => skill.key === key),
          cell = node("td");
        if (machine.inventory)
          cell.append(skillStatus(document, !entry ? "missing" : different ? "different" : "same"));
        else cell.append(node("span", skillsErrorText(machine.error), "skills-muted"));
        row.append(cell);
      }
      const actions = node("td");
      if (different || missing)
        actions.append(skillButton(document, "同步…", () => options.sync(key)));
      row.append(actions);
      body.append(row);
    }
    table.append(body);
    matrix.append(table);
  }
  for (const machine of machines) {
    const section = node("section", "", "skills-machine"),
      head = node("div", "", "skills-machine-head"),
      title = node("div", "", "skills-machine-title");
    const online = node("span", "", machine.inventory ? "skills-online" : "skills-offline");
    online.setAttribute("aria-label", machine.inventory ? "在线" : "离线");
    online.title = machine.inventory ? "在线" : "离线";
    title.append(node("h2", machine.name), online);
    head.append(title);
    const message =
      options.progress.get(machine.hostId) ??
      (machine.inventory ? "" : skillsErrorText(machine.error));
    if (message) {
      const status = node("span", message, "skills-muted");
      status.setAttribute("role", "status");
      head.append(status);
    }
    if (machine.inventory) {
      head.append(
        skillButton(document, "同步到其他机器…", () => options.sync("--all", machine.hostId)),
        skillButton(document, "一键链接", () => options.link(machine.hostId), true),
      );
      const previous = options.changes.get(machine.hostId)?.at(-1);
      if (previous)
        head.append(
          skillButton(document, "撤销上次更改", () => options.undo(machine.hostId, previous)),
        );
    } else head.append(skillButton(document, "重试", options.refresh));
    section.append(head);
    if (machine.inventory) {
      const rows = node("div", "", "skills-agent-scroll");
      rows.setAttribute("role", "table");
      rows.setAttribute("aria-label", `${machine.name} 的 Agent`);
      for (const agent of machine.inventory.agents) {
        const row = node("div", "", agent.excluded ? "skills-agent-excluded" : "skills-agent-row");
        row.setAttribute("role", "row");
        row.dataset.agent = agent.id;
        const name = node("span", agent.name);
        name.title = agent.evidence;
        const directory = node("span", skillDirectory(agent.skillsDir), "skills-path");
        directory.title = skillDirectory(agent.skillsDir);
        const support = node(
          "span",
          agent.excluded
            ? "已排除"
            : agent.native === true
              ? "原生支持"
              : agent.native === false
                ? "需链接"
                : "待核实",
          "skills-muted",
        );
        const progress = node("span", "", "skills-agent-progress");
        if (!agent.excluded) {
          progress.append(
            document.createTextNode(
              agent.native
                ? "直接读取中央库"
                : `已链接 ${agent.linked}/${agent.linked + agent.missing + agent.conflicts}`,
            ),
          );
          if (agent.conflicts && !agent.native)
            progress.append(node("span", `${agent.conflicts} 个冲突`, "skills-conflict-badge"));
        }
        for (const cell of [name, directory, support, progress]) {
          cell.setAttribute("role", "cell");
          row.append(cell);
        }
        rows.append(row);
      }
      if (!machine.inventory.agents.length) rows.append(node("p", "未发现 Agent", "skills-empty"));
      section.append(rows);
      if (machine.inventory.warnings.length)
        section.append(
          node(
            "p",
            `${machine.inventory.warnings.length} 个技能或目录无法读取，请检查文件与权限`,
            "skills-empty",
          ),
        );
    }
    agents.append(section);
  }
}
