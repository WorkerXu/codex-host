import { access, lstat, readdir, readlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { SkillAgent, SkillInventoryEntry } from "@codexhost/shared-contracts";
import { exists } from "./files.js";

interface AgentRule {
  id: string;
  name: string;
  home: string;
  skills?: string;
  cli: string[];
  native: boolean;
  evidence: string;
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
  },
  {
    id: "claude-code",
    name: "Claude Code",
    home: ".claude",
    cli: ["claude"],
    native: false,
    evidence: "https://code.claude.com/docs/en/skills — personal ~/.claude/skills",
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    home: ".codebuddy",
    cli: ["codebuddy"],
    native: false,
    evidence: layoutEvidence,
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
  },
  {
    id: "grok",
    name: "Grok",
    home: ".grok",
    cli: ["grok"],
    native: false,
    evidence: layoutEvidence,
  },
  {
    id: "cursor",
    name: "Cursor",
    home: ".cursor",
    cli: ["cursor", "cursor-agent"],
    native: false,
    evidence: layoutEvidence,
  },
  {
    id: "opencode",
    name: "OpenCode",
    home: ".config/opencode",
    cli: ["opencode"],
    native: true,
    evidence: "https://opencode.ai/docs/skills/ — global agent-compatible ~/.agents/skills",
  },
  {
    id: "kiro",
    name: "Kiro",
    home: ".kiro",
    cli: ["kiro", "kiro-cli"],
    native: false,
    evidence: layoutEvidence,
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    home: ".copilot",
    cli: ["copilot"],
    native: false,
    evidence: layoutEvidence,
  },
  {
    id: "qoder",
    name: "Qoder",
    home: ".qoder",
    cli: ["qoder"],
    native: false,
    evidence: layoutEvidence,
  },
  {
    id: "qoder-cn",
    name: "Qoder CN",
    home: ".qoder-cn",
    cli: ["qodercli", "qodercn"],
    native: false,
    evidence: layoutEvidence,
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
export async function discoverAgents(
  home: string,
  searchPath: string,
  exclusions: string[],
  skills: SkillInventoryEntry[],
): Promise<SkillAgent[]> {
  const candidates = new Map<
    string,
    { id: string; name: string; native: boolean | null; evidence: string }
  >();
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
        native: null,
        evidence: "发现用户技能目录；尚无中央库原生支持证据",
      });
    }
  }
  const result: SkillAgent[] = [];
  for (const [skillsDir, rule] of candidates) {
    let linked = 0,
      conflicts = 0,
      managed = 0,
      missing = 0;
    for (const skill of skills) {
      const file = path.join(skillsDir, skill.key);
      if (isManagedSkill(rule.id, skill.key)) {
        managed++;
        continue;
      }
      if (!(await exists(file))) {
        missing++;
        continue;
      }
      if (
        (await lstat(file)).isSymbolicLink() &&
        path.resolve(skillsDir, await readlink(file)) ===
          path.join(home, ".agents/skills", skill.key)
      )
        linked++;
      else conflicts++;
    }
    result.push({
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
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
// The delegation updater owns this location, including older managed revisions.
export function isManagedSkill(agentId: string, key: string): boolean {
  return agentId === "claude-code" && key === "codexhost-delegation";
}
