import { access, lstat, readdir, readlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { SkillAgent, SkillInventoryEntry } from "@codexhost/shared-contracts";
import { exists } from "./files.js";

export interface AgentRule {
  id: string;
  name: string;
  home: string;
  skills?: string;
  cli: string[];
  native: boolean | null;
  evidence: string;
  /** Installed codexhost Harnesses that provide this agent; absent means no mapping. */
  harness?: readonly string[];
  /** The official Codex agent ships with every Host. */
  builtin?: boolean;
}
const layoutEvidence =
  "https://github.com/vercel-labs/skills/blob/main/src/agents.ts (2026-11-17 globalSkillsDir)";
// These are capability evidence, not the installed-agent list. Discovery runs on every action.
const RULES: AgentRule[] = [
  {
    id: "codex",
    name: "Codex",
    home: ".codex",
    cli: ["codex"],
    native: true,
    evidence: "https://developers.openai.com/codex/skills/ — USER $HOME/.agents/skills",
    builtin: true,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    home: ".claude",
    cli: ["claude"],
    native: false,
    evidence: "https://code.claude.com/docs/en/skills — personal ~/.claude/skills",
    harness: ["claude-code"],
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    home: ".codebuddy",
    cli: ["codebuddy"],
    native: false,
    evidence: layoutEvidence,
    harness: ["codebuddy"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    home: ".gemini",
    cli: ["gemini"],
    native: true,
    evidence: "https://geminicli.com/docs/cli/skills/ — user ~/.agents/skills (higher priority)",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    home: ".gemini/antigravity",
    skills: ".gemini/config/skills",
    cli: ["agy", "antigravity"],
    native: false,
    evidence: `${layoutEvidence}; globalReadsCanonical=false`,
    harness: ["antigravity"],
  },
  {
    id: "grok",
    name: "Grok",
    home: ".grok",
    cli: ["grok"],
    native: false,
    evidence: layoutEvidence,
    harness: ["grok"],
  },
  {
    id: "cursor",
    name: "Cursor",
    home: ".cursor",
    cli: ["cursor", "cursor-agent"],
    native: false,
    evidence: layoutEvidence,
    harness: ["cursor-cli"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    home: ".config/opencode",
    cli: ["opencode"],
    native: true,
    evidence: "https://opencode.ai/docs/skills/ — global agent-compatible ~/.agents/skills",
    harness: ["opencode"],
  },
  {
    id: "kiro",
    name: "Kiro",
    home: ".kiro",
    cli: ["kiro", "kiro-cli"],
    native: false,
    evidence: layoutEvidence,
    harness: ["kiro-cli"],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    home: ".copilot",
    cli: ["copilot"],
    native: false,
    evidence: layoutEvidence,
    harness: ["copilot"],
  },
  {
    id: "qoder",
    name: "Qoder",
    home: ".qoder",
    cli: ["qoder"],
    native: false,
    evidence: layoutEvidence,
    harness: ["qoder"],
  },
  {
    id: "qoder-cn",
    name: "Qoder CN",
    home: ".qoder-cn",
    cli: ["qodercli", "qodercn"],
    native: false,
    evidence: layoutEvidence,
    harness: ["qoder-cn"],
  },
];
async function directory(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function hasCli(names: string[], searchPath: string): Promise<boolean> {
  for (const folder of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      try {
        await access(path.join(folder, name), constants.X_OK);
        return true;
      } catch {
        /* Not on PATH. */
      }
    }
  }
  return false;
}
export interface AgentCandidate {
  skillsDir: string;
  rule: AgentRule;
}
/**
 * Installed Harnesses only; the list changes about monthly, so callers cache it
 * for the Host lifetime instead of scanning every home directory on each open.
 */
export async function agentCandidates(
  home: string,
  searchPath: string,
  installed?: ReadonlySet<string>,
): Promise<AgentCandidate[]> {
  const candidates = new Map<string, AgentRule>();
  if (installed) {
    for (const rule of RULES) {
      if (!rule.builtin && !rule.harness?.some((id) => installed.has(id))) continue;
      candidates.set(path.join(home, rule.skills ?? `${rule.home}/skills`), rule);
    }
    return [...candidates].map(([skillsDir, rule]) => ({ skillsDir, rule }));
  }
  for (const rule of RULES) {
    if (!(await directory(path.join(home, rule.home))) && !(await hasCli(rule.cli, searchPath)))
      continue;
    candidates.set(path.join(home, rule.skills ?? `${rule.home}/skills`), rule);
  }
  // Unknown programs are included only when an actual user-level skills directory exists.
  for (const parent of [home, path.join(home, ".config")]) {
    if (!(await directory(parent))) continue;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || (parent === home && !entry.name.startsWith("."))) continue;
      if ([".agents", ".codexhost", ".git"].includes(entry.name)) continue;
      const folder = path.join(parent, entry.name, "skills");
      if (candidates.has(folder) || !(await directory(folder))) continue;
      const id = entry.name.replace(/^\./u, "");
      candidates.set(folder, {
        id,
        name: id,
        home: entry.name,
        cli: [],
        native: null,
        evidence: "发现用户技能目录；尚无中央库原生支持证据",
      });
    }
  }
  return [...candidates].map(([skillsDir, rule]) => ({ skillsDir, rule }));
}
export async function countAgent(
  home: string,
  skillsDir: string,
  rule: Pick<AgentRule, "id" | "name" | "native" | "evidence">,
  exclusions: string[],
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
    skillsDir,
    native: rule.native,
    evidence: rule.evidence,
    excluded: exclusions.includes(rule.id),
    linked,
    conflicts,
    managed,
    missing,
    states,
  };
}
export async function discoverAgents(
  home: string,
  searchPath: string,
  exclusions: string[],
  skills: SkillInventoryEntry[],
  installed?: ReadonlySet<string>,
): Promise<SkillAgent[]> {
  const candidates = await agentCandidates(home, searchPath, installed);
  const result = await Promise.all(
    candidates.map(({ skillsDir, rule }) => countAgent(home, skillsDir, rule, exclusions, skills)),
  );
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
// The delegation updater owns this location, including older managed revisions.
export function isManagedSkill(agentId: string, key: string): boolean {
  return agentId === "claude-code" && key === "codexhost-delegation";
}
