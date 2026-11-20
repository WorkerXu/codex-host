import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  skillKeySchema,
  skillSourceSchema,
  type SkillInventory,
  type SkillSource,
} from "@codexhost/shared-contracts";
import { agentCandidates, countAgent, type AgentCandidate } from "./agents.js";
import { exists, inventoryEntry, readSkillFiles, safePath } from "./files.js";

export interface SkillPaths {
  home: string;
  state: string;
  searchPath: string;
}
export function library(paths: SkillPaths): string {
  return path.join(paths.home, ".agents/skills");
}
async function sources(paths: SkillPaths): Promise<Record<string, SkillSource | null>> {
  const result = Object.create(null) as Record<string, SkillSource | null>;
  // npx skills stores global provenance in ~/.agents/.skill-lock.json (v3).
  for (const file of [
    path.join(paths.home, ".agents/.skill-lock.json"),
    path.join(paths.state, "sources.json"),
  ]) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { skills?: Record<string, unknown> };
      const entries = raw.skills ?? raw;
      for (const [key, value] of Object.entries(entries)) {
        if (value === null) {
          result[key] = null;
          continue;
        }
        if (typeof value !== "object") continue;
        const entry = value as Record<string, unknown>;
        const parsed = skillSourceSchema.safeParse({
          source: entry.source,
          ...(typeof entry.commit === "string" ? { commit: entry.commit } : {}),
          ...(typeof entry.sourceUrl === "string" ? { sourceUrl: entry.sourceUrl } : {}),
          ...(typeof entry.skillPath === "string" ? { skillPath: entry.skillPath } : {}),
        });
        if (parsed.success && skillKeySchema.safeParse(key).success) result[key] = parsed.data;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("invalid_skill_metadata");
    }
  }
  return result;
}
async function buildInventory(
  paths: SkillPaths,
  candidates: AgentCandidate[],
): Promise<SkillInventory> {
  const root = library(paths);
  await safePath(paths.home, root);
  const skills: SkillInventory["skills"] = [],
    warnings: string[] = [];
  const sourceMap = await sources(paths);
  if (await exists(root)) {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!skillKeySchema.safeParse(entry.name).success || entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) {
        warnings.push(`${entry.name}: skill_not_directory`);
        continue;
      }
      try {
        skills.push(
          inventoryEntry(
            entry.name,
            await readSkillFiles(path.join(root, entry.name)),
            sourceMap[entry.name] ?? null,
          ),
        );
      } catch (error) {
        warnings.push(`${entry.name}: ${error instanceof Error ? error.message : "scan_failed"}`);
      }
    }
  }
  return {
    skills,
    agents: (
      await Promise.all(
        candidates.map(({ skillsDir, rule }) => countAgent(paths.home, skillsDir, rule, skills)),
      )
    ).sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}
async function stamp(file: string): Promise<string> {
  try {
    const value = await stat(file);
    return `${value.mtimeMs}:${value.size}`;
  } catch {
    return "missing";
  }
}
/** Only mtimes and sizes: unchanged directories never trigger a content scan. */
async function inventoryKey(paths: SkillPaths, candidates: AgentCandidate[]): Promise<string> {
  const root = library(paths);
  const names = await readdir(root).catch(() => [] as string[]);
  const parts = [await stamp(root), await stamp(path.join(paths.home, ".agents/.skill-lock.json"))];
  for (const name of names.sort()) parts.push(`${name}:${await stamp(path.join(root, name))}`);
  for (const { skillsDir } of candidates) parts.push(`${skillsDir}:${await stamp(skillsDir)}`);
  parts.push(`sources.json:${await stamp(path.join(paths.state, "sources.json"))}`);
  return parts.join("|");
}
export class SkillsInventoryCache {
  #key: string | null = null;
  #value: SkillInventory | null = null;
  #candidates: Promise<AgentCandidate[]> | null = null;
  #installedKey = "";
  async inventory(paths: SkillPaths, installed?: ReadonlySet<string>): Promise<SkillInventory> {
    const installedKey = installed ? [...installed].sort().join(",") : "";
    if (installedKey !== this.#installedKey) {
      this.#installedKey = installedKey;
      this.#candidates = null;
      this.#key = null;
      this.#value = null;
    }
    this.#candidates ??= agentCandidates(paths.home, paths.searchPath, installed);
    const candidates = await this.#candidates;
    const key = await inventoryKey(paths, candidates);
    if (this.#value && key === this.#key) return this.#value;
    const value = await buildInventory(paths, candidates);
    this.#key = key;
    this.#value = value;
    return value;
  }
}
export async function inventory(
  paths: SkillPaths,
  installed?: ReadonlySet<string>,
): Promise<SkillInventory> {
  return new SkillsInventoryCache().inventory(paths, installed);
}
