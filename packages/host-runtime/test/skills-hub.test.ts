import { required } from "../src/skills-hub/files.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  skillBundleSchema,
  skillChangeResultSchema,
  skillInventorySchema,
  skillLinkPlanSchema,
} from "@codexhost/shared-contracts";
import { fingerprint, frontmatter, readSkillFiles } from "../src/skills-hub/files.js";
import { inventory, type SkillPaths } from "../src/skills-hub/inventory.js";
import { LocalSkillsHub } from "../src/skills-hub/local.js";
import { packSkill, unpackSkill } from "../src/skills-hub/archive.js";
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((file) => rm(file, { recursive: true, force: true })));
});
async function fixture(): Promise<{
  paths: SkillPaths;
  hub: LocalSkillsHub;
}> {
  const home = await mkdtemp(path.join(tmpdir(), "skills-hub-"));
  temporary.push(home);
  const paths = { home, state: path.join(home, ".codexhost/skills-hub"), searchPath: "" };
  return { paths, hub: new LocalSkillsHub(paths) };
}
async function skill(
  home: string,
  folder = ".agents/skills/example",
  text = "hello",
): Promise<string> {
  const directory = path.join(home, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: Example\ndescription: >\n  First line\n  Second line\nversion: '1.0'\n---\n${text}\n`,
  );
  return directory;
}
describe("skills inventory and discovery", () => {
  it("reads scalar and folded metadata, provenance and all-file fingerprints without writing", async () => {
    const { paths } = await fixture();
    const dir = await skill(paths.home);
    await writeFile(
      path.join(paths.home, ".agents/.skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          example: {
            source: "owner/repo",
            sourceUrl: "https://github.com/owner/repo",
            commit: "a".repeat(40),
            skillPath: "skills/example/SKILL.md",
          },
        },
      }),
    );
    const before = await inventory(paths);
    expect(before.skills[0]).toMatchObject({
      key: "example",
      name: "Example",
      description: "First line Second line",
      version: "1.0",
      source: { source: "owner/repo" },
    });
    await mkdir(path.join(dir, ".git"));
    await writeFile(path.join(dir, ".git/config"), "ignored");
    await writeFile(path.join(dir, ".DS_Store"), "ignored");
    expect(required((await inventory(paths)).skills[0]).fingerprint).toBe(
      required(before.skills[0]).fingerprint,
    );
    await writeFile(path.join(dir, "run.sh"), "echo hello");
    expect(required((await inventory(paths)).skills[0]).fingerprint).not.toBe(
      required(before.skills[0]).fingerprint,
    );
    expect(await lstat(paths.state).catch(() => null)).toBeNull();
    expect(frontmatter("---\nname: 'foo'\n---\n").name).toBe("foo");
  });
  it("detects homes, existing skills dirs, config homes and executable CLIs at action time", async () => {
    const { paths } = await fixture();
    await skill(paths.home);
    for (const folder of [
      ".claude",
      ".codex",
      ".gemini",
      ".gemini/antigravity",
      ".config/opencode",
      ".kiro",
      ".copilot",
      ".qoder",
      ".new-agent/skills",
      ".config/other/skills",
    ])
      await mkdir(path.join(paths.home, folder), { recursive: true });
    const bin = path.join(paths.home, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "grok"), "#!/bin/sh\n");
    await chmod(path.join(bin, "grok"), 0o755);
    paths.searchPath = bin;
    const result = await inventory(paths);
    expect(
      result.agents
        .filter((a) => a.native)
        .map((a) => a.id)
        .sort(),
    ).toEqual(["codex", "gemini", "opencode"]);
    expect(result.agents.find((a) => a.id === "grok")).toBeDefined();
    expect(result.agents.find((a) => a.id === "new-agent")?.native).toBeNull();
    expect(result.agents.find((a) => a.id === "github-copilot")?.excluded).toBe(true);
    expect(result.agents.find((a) => a.id === "qoder")?.excluded).toBe(true);
    await mkdir(path.join(paths.home, ".cursor"));
    expect((await inventory(paths)).agents.find((a) => a.id === "cursor")).toBeDefined();
  });
  it("refuses central symlink roots and warns on symlinks within a skill", async () => {
    const { paths } = await fixture();
    const dir = await skill(paths.home);
    await symlink("SKILL.md", path.join(dir, "alias"));
    expect((await inventory(paths)).warnings[0]).toContain("skill_unsafe_file");
    await rm(path.join(paths.home, ".agents/skills"), { recursive: true });
    await symlink(paths.state, path.join(paths.home, ".agents/skills"));
    await expect(inventory(paths)).rejects.toThrow("symlink_path");
  });
});
describe("link previews and reversals", () => {
  it("plans relative links, dangling cleanup, real conflicts, exclusions and managed skills; dry-run writes nothing", async () => {
    const { paths, hub } = await fixture();
    await skill(paths.home);
    await skill(paths.home, ".agents/skills/codexhost-delegation");
    await skill(paths.home, ".claude/skills/local-only");
    for (const folder of [".copilot", ".qoder", ".cursor/skills"])
      await mkdir(path.join(paths.home, folder), { recursive: true });
    await symlink("../../.agents/skills/gone", path.join(paths.home, ".claude/skills/gone"));
    await symlink("/unrelated/missing", path.join(paths.home, ".claude/skills/foreign"));
    const plan = skillLinkPlanSchema.parse(await hub.request("link-plan", {}));
    expect(plan.actions.some((a) => a.skill === "gone" && a.kind === "remove-dangling")).toBe(true);
    expect(plan.actions.find((a) => a.skill === "foreign")?.kind).toBe("conflict");
    expect(plan.actions.find((a) => a.skill === "local-only")?.kind).toBe("conflict");
    expect(plan.actions.some((a) => ["github-copilot", "qoder"].includes(a.agentId))).toBe(false);
    expect(
      plan.actions.some((a) => a.agentId === "claude-code" && a.skill === "codexhost-delegation"),
    ).toBe(false);
    expect(await lstat(paths.state).catch(() => null)).toBeNull();
    const applied = skillChangeResultSchema.parse(await hub.request("link-apply", { id: plan.id }));
    expect(await readlink(path.join(paths.home, ".claude/skills/example"))).toBe(
      "../../.agents/skills/example",
    );
    expect(await lstat(path.join(paths.home, ".qoder/skills")).catch(() => null)).toBeNull();
    await hub.request("undo", { id: applied.id });
    expect(await readlink(path.join(paths.home, ".claude/skills/gone"))).toBe(
      "../../.agents/skills/gone",
    );
    expect(
      await readFile(path.join(paths.home, ".claude/skills/local-only/SKILL.md"), "utf8"),
    ).toContain("hello");
  });
  it("adopts a real directory only after an explicit preview, backs up central content and undoes it", async () => {
    const { paths, hub } = await fixture();
    const central = await skill(paths.home);
    const original = await readFile(path.join(central, "SKILL.md"), "utf8");
    const agent = await skill(paths.home, ".claude/skills/example", "agent version");
    const preview = skillLinkPlanSchema.parse(await hub.request("link-plan", {}));
    expect(preview.actions[0]?.kind).toBe("conflict");
    const plan = skillLinkPlanSchema.parse(
      await hub.request("link-plan", { adopt: [{ agentId: "claude-code", skill: "example" }] }),
    );
    await hub.request("link-apply", { id: plan.id });
    expect(await readFile(path.join(central, "SKILL.md"), "utf8")).toContain("agent version");
    await hub.request("undo", { id: plan.id });
    expect((await lstat(agent)).isDirectory()).toBe(true);
    expect(await readFile(path.join(central, "SKILL.md"), "utf8")).toBe(original);
  });
  it("rejects stale previews and modified undo targets without touching real files", async () => {
    const { paths, hub } = await fixture();
    const dir = await skill(paths.home);
    await mkdir(path.join(paths.home, ".claude"));
    const plan = skillLinkPlanSchema.parse(await hub.request("link-plan", {}));
    await writeFile(path.join(dir, "changed"), "changed");
    await expect(hub.request("link-apply", { id: plan.id })).rejects.toThrow("stale_plan");
    const next = skillLinkPlanSchema.parse(await hub.request("link-plan", {}));
    await hub.request("link-apply", { id: next.id });
    const file = path.join(paths.home, ".claude/skills/example");
    await rm(file);
    await mkdir(file);
    await writeFile(path.join(file, "mine"), "keep");
    await expect(hub.request("undo", { id: next.id })).rejects.toThrow("undo_conflict");
    expect(await readFile(path.join(file, "mine"), "utf8")).toBe("keep");
  });
});
describe("bounded tar transport", () => {
  it("round trips all files and executable bits", async () => {
    const { paths, hub } = await fixture();
    const dir = await skill(paths.home);
    await writeFile(path.join(dir, "run"), "hello", { mode: 0o755 });
    const files = await readSkillFiles(dir);
    expect(fingerprint(unpackSkill(packSkill(files)))).toBe(fingerprint(files));
    const entry = required(
      skillInventorySchema.parse(await hub.request("inventory", {})).skills[0],
    );
    const bundle = skillBundleSchema.parse(
      await hub.request("export", { skill: entry.key, expected: entry.fingerprint }),
    );
    expect(bundle.fingerprint).toBe(entry.fingerprint);
  });
  it("rejects traversal, duplicate paths, links, wrong checksums and decompression bombs", async () => {
    const { paths } = await fixture();
    const files = await readSkillFiles(await skill(paths.home));
    for (const name of ["../escape", "/absolute", "a/../../outside", "C:/outside", "a\\b"])
      expect(() => unpackSkill(packSkill([{ ...required(files[0]), path: name }]))).toThrow();
    expect(() => unpackSkill(packSkill([required(files[0]), required(files[0])]))).toThrow(
      "invalid_archive_path",
    );
    expect(() => unpackSkill("bad payload")).toThrow();
  });
});
