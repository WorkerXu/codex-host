import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { skillChangeResultSchema, skillLinkPlanSchema } from "@codexhost/shared-contracts";
import { LocalSkillsHub } from "../src/skills-hub/local.js";
import { SkillsHubService } from "../src/skills-hub/service.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "skills-direct-"));
  homes.push(home);
  await mkdir(path.join(home, ".agents/skills/example"), { recursive: true });
  await writeFile(
    path.join(home, ".agents/skills/example/SKILL.md"),
    "---\nname: Example\ndescription: Direct Host\n---\nbody\n",
  );
  await mkdir(path.join(home, ".claude/skills"), { recursive: true });
  const environment = { CODEXHOST_USER_DIR: path.join(home, ".codexhost") };
  const local = new LocalSkillsHub(
    {
      home,
      state: path.join(home, ".codexhost/skills-hub"),
    },
    { availableHarnessIds: async () => new Set(["claude-code"]) },
  );
  const service = new SkillsHubService(environment, {
    local,
    hosts: async () => [{ hostId: "local", name: "oracle-main" }],
  });
  return { home, service };
}

describe("direct requests to a remote Host", () => {
  it("plans, applies and undoes a link locally when the body uses hostId local", async () => {
    const { home, service } = await fixture();
    const plan = skillLinkPlanSchema.parse(
      await service.request({ op: "link-plan", hostId: "local" }),
    );
    expect(plan.hostId).toBe("local");
    expect(plan.actions.map((action) => action.kind)).toContain("link");

    await expect(service.request({ op: "link-plan", hostId: "oracle-main" })).rejects.toThrow(
      "connection_failed",
    );

    const applied = skillChangeResultSchema.parse(
      await service.request({ op: "link-apply", hostId: "local", id: plan.id }),
    );
    expect(await readlink(path.join(home, ".claude/skills/example"))).toBe(
      "../../.agents/skills/example",
    );
    await expect(
      service.request({ op: "link-apply", hostId: "oracle-main", id: applied.id }),
    ).rejects.toThrow("connection_failed");

    await service.request({ op: "undo", hostId: "local", id: applied.id });
    expect(await lstat(path.join(home, ".claude/skills/example")).catch(() => null)).toBeNull();
    await expect(
      service.request({ op: "undo", hostId: "oracle-main", id: applied.id }),
    ).rejects.toThrow("connection_failed");
  });
});
