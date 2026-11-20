import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonObject } from "@codexhost/protocol-core";
import { expect, it } from "vitest";
import { SKILLS_HUB_METHOD, skillLinkPlanSchema } from "@codexhost/shared-contracts";
import { SkillsHubService } from "../src/skills-hub/service.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

it("routes a targeted unlink through Desktop to the local skills library", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "desktop-skills-"));
  const skills = new SkillsHubService(
    { HOME: home },
    {
      availableHarnessIds: async () => new Set(["claude-code"]),
    },
  );
  const fixture = createFixture({ desktopHubs: { skills } });
  const request = async (id: number, params: JsonObject) => {
    writeRequest(fixture.desktopInput, { id, method: SKILLS_HUB_METHOD, params });
    return fixture.collector.waitFor((message) => requestId(message, id));
  };
  try {
    await fixture.ready;
    const library = path.join(home, ".agents/skills/example");
    const agent = path.join(home, ".claude/skills");
    const link = path.join(agent, "example");
    await mkdir(library, { recursive: true });
    await writeFile(path.join(library, "SKILL.md"), "---\nname: example\n---\n");
    await mkdir(agent, { recursive: true });
    await symlink("../../.agents/skills/example", link);

    const scope = { agentId: "claude-code", skill: "example" };
    const preview = await request(1, { op: "link-plan", hostId: "local", scope, unlink: [scope] });
    const plan = skillLinkPlanSchema.parse((preview as { result?: unknown }).result);
    expect(plan.actions.map(({ kind }) => kind)).toEqual(["unlink"]);

    await expect(
      request(2, { op: "link-apply", hostId: "local", id: plan.id }),
    ).resolves.toMatchObject({
      result: { changed: 1 },
    });
    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(library, "SKILL.md"))).resolves.toBeDefined();
    await expect(
      request(3, { op: "link-apply", hostId: "local", id: plan.id }),
    ).resolves.toMatchObject({
      error: { code: -32096, message: "expired_plan" },
    });
  } finally {
    await stopFixture(fixture);
    await rm(home, { recursive: true, force: true });
  }
});
