import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillsInventoryCache, type SkillPaths } from "../src/skills-hub/inventory.js";
import { agentCandidates } from "../src/skills-hub/agents.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((file) => rm(file, { recursive: true, force: true })));
});
async function fixture(): Promise<SkillPaths> {
  const home = await mkdtemp(path.join(tmpdir(), "skills-cache-"));
  temporary.push(home);
  const paths = { home, state: path.join(home, ".codexhost/skills-hub") };
  await mkdir(path.join(home, ".agents/skills/example"), { recursive: true });
  await writeFile(
    path.join(home, ".agents/skills/example/SKILL.md"),
    "---\nname: Example\ndescription: Cache test\nversion: '1.0'\n---\nbody\n",
  );
  return paths;
}
describe("Skills inventory cache", () => {
  it("returns the cached inventory while directory mtimes stay unchanged", async () => {
    const paths = await fixture();
    const cache = new SkillsInventoryCache();
    const first = await cache.inventory(paths, new Set());
    const second = await cache.inventory(paths, new Set());
    expect(second).toBe(first);
    expect(first.skills.map((skill) => skill.key)).toEqual(["example"]);
  });

  it("rescans after a skill directory changes", async () => {
    const paths = await fixture();
    const cache = new SkillsInventoryCache();
    const first = await cache.inventory(paths, new Set());
    const directory = path.join(paths.home, ".agents/skills/example");
    await writeFile(path.join(directory, "notes.md"), "extra\n");
    const changed = new Date(Date.now() + 5_000);
    await utimes(directory, changed, changed);
    const second = await cache.inventory(paths, new Set());
    expect(second).not.toBe(first);
    expect(second.skills[0]?.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "notes.md",
    ]);
  });

  it("lists only installed Harnesses plus the built-in Codex agent", async () => {
    const paths = await fixture();
    await mkdir(path.join(paths.home, ".codex"), { recursive: true });
    await mkdir(path.join(paths.home, ".claude/skills"), { recursive: true });
    await mkdir(path.join(paths.home, ".cursor/skills"), { recursive: true });
    await mkdir(path.join(paths.home, ".gemini/skills"), { recursive: true });
    const installed = agentCandidates(paths.home, new Set(["claude-code"]));
    expect(installed.map(({ rule }) => rule.id).sort()).toEqual(["claude-code", "codex"]);
    expect(agentCandidates(paths.home).map(({ rule }) => rule.id)).toEqual(["codex"]);
  });
});
