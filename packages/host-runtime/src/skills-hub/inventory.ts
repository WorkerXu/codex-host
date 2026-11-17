import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SKILL_EXCLUSIONS,
  skillKeySchema,
  skillSourceSchema,
  type SkillInventory,
  type SkillSource,
} from "@codexhost/shared-contracts";
import { discoverAgents } from "./agents.js";
import { exists, inventoryEntry, readSkillFiles, safePath } from "./files.js";

export interface SkillPaths {
  home: string;
  state: string;
  searchPath: string;
}
export function library(paths: SkillPaths): string {
  return path.join(paths.home, ".agents/skills");
}
export async function exclusions(paths: SkillPaths): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(paths.state, "exclusions.json"), "utf8"),
    );
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
      throw new Error("invalid_exclusions");
    return value as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...DEFAULT_SKILL_EXCLUSIONS];
    throw error;
  }
}
async function sources(paths: SkillPaths): Promise<Record<string, SkillSource | null>> {
  const result: Record<string, SkillSource | null> = {};
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
export async function inventory(paths: SkillPaths): Promise<SkillInventory> {
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
  const excluded = await exclusions(paths);
  return {
    skills,
    agents: await discoverAgents(paths.home, paths.searchPath, excluded, skills),
    exclusions: excluded,
    warnings,
  };
}
