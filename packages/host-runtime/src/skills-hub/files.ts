import { parseSkillFrontmatter } from "@codexhost/skill-library";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { SkillInventoryEntry, SkillSource } from "@codexhost/shared-contracts";
export const MAX_SKILL_BYTES = 64 * 1024 * 1024;
const IGNORED = new Set([".DS_Store", ".git", ".hg", ".svn"]);
export interface SkillFile {
  path: string;
  data: Buffer;
  executable: boolean;
  modified: number;
}
export function fail(message: string): never {
  throw new Error(message);
}
export function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Reject symlink ancestors before any write; never follow an Agent's redirected home. */
export async function safePath(home: string, file: string): Promise<void> {
  if (!inside(home, file) || home === file) fail("invalid_path");
  let cursor = home;
  for (const part of path.relative(home, file).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (!(await exists(cursor))) continue;
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail("symlink_path");
  }
}
export async function readSkillFiles(directory: string): Promise<SkillFile[]> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) fail("skill_not_directory");
  const files: SkillFile[] = [];
  let bytes = 0;
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (IGNORED.has(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(directory, name);
      const info = await lstat(file);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        fail("skill_unsafe_file");
      if (info.isDirectory()) {
        await walk(name);
        continue;
      }
      bytes += info.size;
      if (bytes > MAX_SKILL_BYTES || files.length >= 8192) fail("skill_too_large");
      const data = await readFile(file);
      files.push({
        path: name,
        data,
        executable: (info.mode & 0o111) !== 0,
        modified: info.mtimeMs,
      });
    }
  }
  await walk("");
  if (!files.some((file) => file.path === "SKILL.md")) fail("missing_skill_md");
  return files;
}
export function fingerprint(files: SkillFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(JSON.stringify([file.path, file.data.length, file.executable]));
    hash.update(file.data);
  }
  return hash.digest("hex");
}
export function inventoryEntry(
  key: string,
  files: SkillFile[],
  source: SkillSource | null,
): SkillInventoryEntry {
  const skillMd = required(files.find((file) => file.path === "SKILL.md")).data.toString("utf8");
  if (Buffer.byteLength(skillMd) > 64 * 1024) fail("skill_md_too_large");
  const { data } = parseSkillFrontmatter(skillMd);
  return {
    key,
    name: typeof data?.name === "string" && data.name ? data.name : key,
    description: typeof data?.description === "string" ? data.description.trimEnd() : "",
    version: typeof data?.version === "string" ? data.version : null,
    fingerprint: fingerprint(files),
    modifiedAt: new Date(Math.max(...files.map((file) => file.modified))).toISOString(),
    skillMd,
    source,
    files: files.map((file) => ({
      path: file.path,
      hash: createHash("sha256").update(file.data).digest("hex"),
      size: file.data.length,
      executable: file.executable,
    })),
  };
}
export async function canonicalHome(home: string): Promise<string> {
  return realpath(home);
}
export function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) fail("invalid_skill_state");
  return value;
}
