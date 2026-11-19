import type { SkillLinkPlan, SkillMachine } from "@codexhost/shared-contracts";
import { skillButton, skillNode, skillsDialog } from "./skills-dialog.js";
import { createPreferenceCheckbox } from "./preference-ui.js";
import { skillAgentName, skillDirectory } from "./skills-presentation.js";
export interface SkillAdoption {
  agentId: string;
  skill: string;
}
export function showSkillLinks(options: {
  root: HTMLElement;
  machines: SkillMachine[];
  plan: SkillLinkPlan;
  adopt: SkillAdoption[];
  apply(): void;
  replan(adopt: SkillAdoption[], focus: string): void;
  focus?: string | undefined;
}): void {
  const { root, machines, plan } = options,
    document = root.ownerDocument;
  const name = machines.find((machine) => machine.hostId === plan.hostId)?.name ?? "当前机器";
  const dialog = skillsDialog(root, `${name} · 链接变更预览`);
  const count = (kind: string) => plan.actions.filter((action) => action.kind === kind).length;
  const conflicts = count("conflict") + count("adopt");
  const changes = [
    count("link") ? `新建 ${count("link")} 个链接` : "",
    count("unlink") ? `解除 ${count("unlink")} 个链接` : "",
    count("remove-dangling") ? `清理 ${count("remove-dangling")} 个失效链接` : "",
  ].filter(Boolean);
  dialog.body.append(
    skillNode(
      document,
      "p",
      `${changes.join("、") || "没有链接变更"}${conflicts ? `，${conflicts} 个冲突${count("adopt") ? "已选择" : "需要你选择"}` : ""}`,
      "skills-summary",
    ),
  );
  const agentIds = [...new Set(plan.actions.map((action) => action.agentId))];
  for (const agentId of agentIds) {
    const actions = plan.actions.filter((action) => action.agentId === agentId);
    const agent = machines
      .find((machine) => machine.hostId === plan.hostId)
      ?.inventory?.agents.find((agent) => agent.id === agentId);
    const group = skillNode(document, "section", "", "skills-link-group");
    const heading = skillNode(document, "div", "", "skills-link-group-head");
    const first = actions[0];
    const dir = agent?.skillsDir ?? (first ? first.path.slice(0, -first.skill.length - 1) : "");
    heading.append(
      skillNode(document, "strong", skillAgentName(machines, agentId)),
      skillNode(document, "span", skillDirectory(dir), "skills-path"),
    );
    group.append(heading);
    for (const action of actions) {
      const row = skillNode(document, "div", "", "skills-link-row");
      row.append(
        skillNode(document, "strong", action.skill),
        skillNode(
          document,
          "span",
          action.kind === "link"
            ? "新建链接"
            : action.kind === "unlink"
              ? "解除链接"
              : action.kind === "remove-dangling"
                ? "清理失效链接"
                : "冲突",
          action.kind === "conflict" || action.kind === "adopt"
            ? "skills-conflict-badge"
            : "skills-action-tag",
        ),
      );
      if ((action.kind === "conflict" && action.fingerprint) || action.kind === "adopt") {
        const label = skillNode(document, "label", "", "skills-link-choice");
        const check = createPreferenceCheckbox(document);
        check.checked = action.kind === "adopt";
        const key = `${agentId}/${action.skill}`;
        check.dataset.skillAdoption = key;
        check.addEventListener("change", () => {
          const selected = options.adopt.filter((item) => item.skill !== action.skill);
          if (check.checked) selected.push({ agentId, skill: action.skill });
          dialog.close();
          options.replan(selected, key);
        });
        label.append(check, document.createTextNode("收进中央库"));
        row.append(label);
      }
      group.append(row);
    }
    dialog.body.append(group);
  }
  if (!plan.actions.length) dialog.body.append(skillNode(document, "p", "链接已就绪，无需更改。"));
  dialog.body.append(
    skillNode(
      document,
      "p",
      "解除链接只移除符号链接，不删除中央库技能。未选择的冲突会保留；收进中央库会移动目录、备份同名版本并留下链接。所有更改均可撤销。",
      "skills-muted",
    ),
  );
  const apply = skillButton(
    document,
    "应用",
    () => {
      dialog.close();
      options.apply();
    },
    true,
  );
  apply.disabled = !plan.actions.some((action) => action.kind !== "conflict");
  dialog.footer.append(skillButton(document, "取消", dialog.close), apply);
  if (options.focus)
    [...dialog.body.querySelectorAll<HTMLInputElement>("[data-skill-adoption]")]
      .find((input) => input.dataset.skillAdoption === options.focus)
      ?.focus();
}
