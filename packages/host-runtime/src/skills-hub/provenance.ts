import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillSource } from "@codexhost/shared-contracts";
import type { SkillPaths } from "./inventory.js";

export async function sourceOverrides(
  paths: SkillPaths,
): Promise<Record<string, SkillSource | null>> {
  try {
    return JSON.parse(await readFile(path.join(paths.state, "sources.json"), "utf8")) as Record<
      string,
      SkillSource | null
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
export async function setSource(
  paths: SkillPaths,
  key: string,
  source: SkillSource | null,
): Promise<void> {
  const sources = await sourceOverrides(paths);
  sources[key] = source;
  const file = path.join(paths.state, "sources.json"),
    temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(sources, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}
