import type { SkillMachine } from "@codexhost/shared-contracts";
import { createRendererSettingsIcon } from "./icons.js";
import { skillNode } from "./skills-dialog.js";

const AGENT_NAMES: Record<string, string> = {
  "github-copilot": "GitHub Copilot",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  codex: "Codex",
  "claude-code": "Claude Code",
  codebuddy: "CodeBuddy",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  grok: "Grok",
  opencode: "OpenCode",
  kiro: "Kiro",
};
export function skillAgentName(machines: SkillMachine[], id: string): string {
  return (
    machines.flatMap((machine) => machine.inventory?.agents ?? []).find((agent) => agent.id === id)
      ?.name ??
    (Object.hasOwn(AGENT_NAMES, id) ? AGENT_NAMES[id] : undefined) ??
    id
      .split(/[-_]/u)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}
export function skillModifiedTime(value: string): string {
  const date = new Date(value);
  const parts = [date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()].map(
    (part) => String(part).padStart(2, "0"),
  );
  return `${parts[0]}-${parts[1]} ${parts[2]}:${parts[3]}`;
}
export function skillStatus(
  document: Document,
  state: "same" | "different" | "missing",
): HTMLElement {
  const status = skillNode(
    document,
    "span",
    "",
    { same: "skills-success", different: "skills-warning", missing: "skills-missing" }[state],
  );
  const icon =
    state === "missing"
      ? skillNode(document, "span", "−")
      : createRendererSettingsIcon(state === "same" ? "check" : "alert", 14);
  icon.setAttribute("aria-hidden", "true");
  status.append(
    icon,
    document.createTextNode({ same: "一致", different: "版本不同", missing: "缺失" }[state]),
  );
  return status;
}
export function skillDirectory(directory: string): string {
  return directory.replaceAll("\\", "/").replace(/^.*?(?=\/\.[^/]+(?:\/|$))/u, "~");
}
