import type { SkillSyncPlan } from "@codexhost/shared-contracts";
import { skillsDialog, skillButton, skillNode } from "./skills-dialog.js";
import { skillModifiedTime } from "./skills-presentation.js";

export function showSkillConflicts(options: {
  root: HTMLElement;
  plan: SkillSyncPlan;
  choices?: Record<string, string> | undefined;
  continueWith(choices: Record<string, string>): void;
}): void {
  const { root, plan } = options,
    document = root.ownerDocument;
  const dialog = skillsDialog(root, "选择保留的版本");
  const choices = Object.assign(Object.create(null) as Record<string, string>, options.choices);
  const next = skillButton(
    document,
    "继续",
    () => {
      if (plan.conflicts.some((conflict) => !Object.hasOwn(choices, conflict.skill))) return;
      dialog.close();
      options.continueWith(choices);
    },
    true,
  );
  next.disabled = true;
  for (const conflict of plan.conflicts) {
    dialog.body.append(skillNode(document, "h3", conflict.skill));
    const cards = skillNode(document, "div", "", "skills-versions");
    const modified = conflict.versions.map((version) => Date.parse(version.entry.modifiedAt));
    const newest = Math.max(...modified),
      oldest = Math.min(...modified);
    for (const version of conflict.versions) {
      const label = skillNode(document, "label", "", "skills-version");
      const radio = skillNode(document, "input");
      radio.type = "radio";
      radio.name = conflict.skill;
      radio.value = version.hostId;
      radio.addEventListener("change", () => {
        choices[conflict.skill] = version.hostId;
        next.disabled = plan.conflicts.some((entry) => !Object.hasOwn(choices, entry.skill));
      });
      const detail = skillNode(document, "div"),
        title = skillNode(document, "strong", version.name);
      if (newest > oldest && Date.parse(version.entry.modifiedAt) === newest)
        title.append(skillNode(document, "span", "较新", "skills-newer"));
      detail.append(
        title,
        skillNode(
          document,
          "span",
          `${skillModifiedTime(version.entry.modifiedAt)} 修改 · ${version.entry.files.length} 个文件`,
          "skills-version-meta",
        ),
      );
      label.append(radio, detail);
      cards.append(label);
    }
    dialog.body.append(cards);
    const paths = [
      ...new Set(
        conflict.versions.flatMap((version) => version.entry.files.map((file) => file.path)),
      ),
    ];
    const changed = paths.filter(
      (path) =>
        new Set(
          conflict.versions.map((version) => {
            const file = version.entry.files.find((file) => file.path === path);
            return file ? `${file.hash}:${file.executable}` : "missing";
          }),
        ).size > 1,
    );
    const fileLines = new Set(paths.flatMap((path) => [`+ ${path}`, `- ${path}`, `~ ${path}`]));
    const diff = skillNode(document, "div", "", "skills-diff");
    diff.setAttribute("aria-label", `${conflict.skill} 正文差异`);
    for (const line of conflict.diff.split("\n")) {
      if (!line || fileLines.has(line) || line.includes(" → ")) continue;
      diff.append(
        skillNode(
          document,
          "div",
          line,
          line.startsWith("+")
            ? "skills-diff-add"
            : line.startsWith("-")
              ? "skills-diff-remove"
              : "skills-diff-context",
        ),
      );
    }
    dialog.body.append(
      skillNode(
        document,
        "div",
        conflict.versions.map((version) => version.name).join(" → "),
        "skills-diff-heading",
      ),
      diff,
    );
    const files = skillNode(document, "details");
    files.append(
      skillNode(
        document,
        "summary",
        `文件变更 · ${changed.length} 个文件`,
        "skills-muted cursor-pointer",
      ),
    );
    const list = skillNode(document, "ul", "", "skills-file-list");
    for (const path of changed) list.append(skillNode(document, "li", path));
    files.append(list);
    dialog.body.append(files);
  }
  dialog.footer.append(skillButton(document, "取消", dialog.close), next);
}
