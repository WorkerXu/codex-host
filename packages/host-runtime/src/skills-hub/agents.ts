import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import type { SkillAgent, SkillInventoryEntry } from "@codexhost/shared-contracts";
import { exists } from "./files.js";

export interface AgentRule {
  id: string;
  name: string;
  home: string;
  skills?: string;
  native: boolean | null;
  evidence: string;
  /** Installed codexhost Harnesses that provide this agent; absent means no mapping. */
  harness?: readonly string[];
  /** The official Codex agent ships with every Host. */
  builtin?: boolean;
}
const layoutEvidence =
  "https://github.com/vercel-labs/skills/blob/main/src/agents.ts (2026-11-17 globalSkillsDir)";
// The availability cache selects installed Agents from these supported layouts.
const RULES: AgentRule[] = [
  {
    id: "codex",
    name: "Codex",
    home: ".codex",
    native: true,
    evidence: "https://developers.openai.com/codex/skills/ — USER $HOME/.agents/skills",
    builtin: true,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    home: ".claude",
    native: false,
    evidence: "https://code.claude.com/docs/en/skills — personal ~/.claude/skills",
    harness: ["claude-code"],
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    home: ".codebuddy",
    native: false,
    evidence: layoutEvidence,
    harness: ["codebuddy"],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    home: ".gemini/antigravity",
    skills: ".gemini/config/skills",
    native: false,
    evidence: `${layoutEvidence}; globalReadsCanonical=false`,
    harness: ["antigravity"],
  },
  {
    id: "grok",
    name: "Grok",
    home: ".grok",
    native: false,
    evidence: layoutEvidence,
    harness: ["grok"],
  },
  {
    id: "cursor",
    name: "Cursor",
    home: ".cursor",
    native: false,
    evidence: layoutEvidence,
    harness: ["cursor-cli"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    home: ".config/opencode",
    native: true,
    evidence: "https://opencode.ai/docs/skills/ — global agent-compatible ~/.agents/skills",
    harness: ["opencode"],
  },
  {
    id: "kiro",
    name: "Kiro",
    home: ".kiro",
    native: false,
    evidence: layoutEvidence,
    harness: ["kiro-cli"],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    home: ".copilot",
    native: false,
    evidence: layoutEvidence,
    harness: ["copilot"],
  },
  {
    id: "qoder",
    name: "Qoder",
    home: ".qoder",
    native: false,
    evidence: layoutEvidence,
    harness: ["qoder"],
  },
  {
    id: "qoder-cn",
    name: "Qoder CN",
    home: ".qoder-cn",
    native: false,
    evidence: layoutEvidence,
    harness: ["qoder-cn"],
  },
];
export interface AgentCandidate {
  skillsDir: string;
  rule: AgentRule;
}

export function agentCandidates(
  home: string,
  installed: ReadonlySet<string> = new Set(),
): AgentCandidate[] {
  return RULES.filter((rule) => rule.builtin || rule.harness?.some((id) => installed.has(id))).map(
    (rule) => ({ skillsDir: path.join(home, rule.skills ?? `${rule.home}/skills`), rule }),
  );
}

export async function countAgent(
  home: string,
  skillsDir: string,
  rule: Pick<AgentRule, "id" | "name" | "native" | "evidence">,
  skills: SkillInventoryEntry[],
): Promise<SkillAgent> {
  let linked = 0,
    conflicts = 0,
    managed = 0,
    missing = 0;
  const states: SkillAgent["states"] = {};
  for (const skill of skills) {
    const file = path.join(skillsDir, skill.key);
    if (rule.native === true) {
      states[skill.key] = "native";
      continue;
    }
    if (isManagedSkill(rule.id, skill.key)) {
      states[skill.key] = "managed";
      managed++;
      continue;
    }
    if (!(await exists(file))) {
      states[skill.key] = "missing";
      missing++;
      continue;
    }
    if (
      (await lstat(file)).isSymbolicLink() &&
      path.resolve(skillsDir, await readlink(file)) === path.join(home, ".agents/skills", skill.key)
    ) {
      states[skill.key] = "linked";
      linked++;
    } else {
      states[skill.key] = "conflict";
      conflicts++;
    }
  }
  return {
    id: rule.id,
    name: rule.name,
    skillsDir: rule.native === true ? path.join(home, ".agents/skills") : skillsDir,
    native: rule.native,
    evidence: rule.evidence,
    linked,
    conflicts,
    managed,
    missing,
    states,
  };
}
// The delegation updater owns this location, including older managed revisions.
export function isManagedSkill(agentId: string, key: string): boolean {
  return agentId === "claude-code" && key === "codexhost-delegation";
}
