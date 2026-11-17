import type { SkillMachine } from "@codexhost/shared-contracts";
import { skillAgentName } from "./skills-presentation.js";
import { skillsDialog, skillNode, skillButton } from "./skills-dialog.js";
export function renderSkillExclusions(
  root: HTMLElement,
  machines: SkillMachine[],
  edit: () => void,
): void {
  const document = root.ownerDocument;
  const ids = [...new Set(machines.flatMap((machine) => machine.inventory?.exclusions ?? []))];
  root.replaceChildren(
    skillNode(
      document,
      "span",
      `不链接的 Agent：${ids.map((id) => skillAgentName(machines, id)).join("、") || "无"}`,
      "skills-muted",
    ),
    skillButton(document, "编辑", edit),
  );
}
export function editSkillExclusions(options: {
  root: HTMLElement;
  machines: SkillMachine[];
  save(hostId: string, agents: string[], close: () => void): void;
}): void {
  const { root, machines } = options,
    document = root.ownerDocument;
  const available = machines.filter((machine) => machine.inventory);
  const dialog = skillsDialog(root, "不链接的 Agent");
  const select = skillNode(document, "select");
  select.setAttribute("aria-label", "设置机器");
  for (const machine of available) {
    const option = skillNode(document, "option", machine.name);
    option.value = machine.hostId;
    select.append(option);
  }
  const machineLabel = skillNode(document, "label", "设置机器", "skills-field");
  machineLabel.append(select);
  dialog.body.append(machineLabel);
  const list = skillNode(document, "div");
  dialog.body.append(list);
  let selected = new Set<string>();
  const draw = () => {
    const machine = available.find((machine) => machine.hostId === select.value);
    selected = new Set(machine?.inventory?.exclusions ?? []);
    const ids = [
      ...new Set([
        "github-copilot",
        "qoder",
        ...selected,
        ...(machine?.inventory?.agents.map((agent) => agent.id) ?? []),
      ]),
    ];
    list.replaceChildren();
    for (const id of ids) {
      const label = skillNode(document, "label", "", "skills-target"),
        checkbox = skillNode(document, "input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(id);
        else selected.delete(id);
      });
      label.append(checkbox, document.createTextNode(skillAgentName(machines, id)));
      list.append(label);
    }
  };
  select.addEventListener("change", draw);
  draw();
  dialog.footer.append(
    skillButton(document, "取消", dialog.close),
    skillButton(
      document,
      "保存",
      () => options.save(select.value, [...selected], dialog.close),
      true,
    ),
  );
}
