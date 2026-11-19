import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  skillBundleSchema,
  skillInventorySchema,
  skillLinkPlanSchema,
} from "@codexhost/shared-contracts";
import { HarnessAvailabilityStore } from "../src/harness-availability-store.js";
import { getSkillsHub } from "../src/skills-hub/service.js";
import { LocalSkillsHub } from "../src/skills-hub/local.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    stat: vi.fn(actual.stat),
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
  };
});
const homes: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await fs.mkdtemp(path.join(tmpdir(), "skills-availability-"));
  homes.push(home);
  await fs.mkdir(path.join(home, ".agents/skills/example"), { recursive: true });
  await fs.writeFile(path.join(home, ".agents/skills/example/SKILL.md"), "Example\n");
  for (const id of [".claude", ".cursor", ".kiro", ".gemini"])
    await fs.mkdir(path.join(home, id, "skills"), { recursive: true });
  let available = new Set(["claude-code"]);
  const hub = new LocalSkillsHub(
    { home, state: path.join(home, ".codexhost/skills-hub"), searchPath: "" },
    { availableHarnessIds: async () => available },
  );
  return {
    home,
    hub,
    uninstall: () => {
      available = new Set();
    },
  };
}

it("limits inventory, previews, apply, export, import and exclusions to available Agents", async () => {
  const { home, hub } = await fixture();
  vi.clearAllMocks();
  const inventory = skillInventorySchema.parse(await hub.request("inventory", {}));
  expect(inventory.agents.map((agent) => agent.id)).toEqual(["claude-code", "codex"]);
  const plan = skillLinkPlanSchema.parse(await hub.request("link-plan", {}));
  expect(plan.actions.map((action) => action.agentId)).toEqual(["claude-code"]);
  await hub.request("link-apply", { id: plan.id });
  const bundle = skillBundleSchema.parse(
    await hub.request("export", {
      skill: "example",
      expected: inventory.skills[0]?.fingerprint,
    }),
  );
  await hub.request("import", { bundle, expected: bundle.fingerprint });
  const excluded = skillInventorySchema.parse(await hub.request("exclusions", { agents: [] }));
  expect(excluded.agents.map((agent) => agent.id)).toEqual(["claude-code", "codex"]);
  for (const operation of [fs.lstat, fs.stat, fs.readdir, fs.readFile]) {
    const reads = vi.mocked(operation).mock.calls.map(([file]) => String(file));
    expect(reads).not.toContain(home);
    for (const id of [".cursor", ".kiro", ".gemini"])
      expect(reads.filter((file) => file.startsWith(path.join(home, id)))).toEqual([]);
  }
  await hub.request("undo", { id: plan.id });
});

it("rejects a preview if its Agent becomes uninstalled before apply", async () => {
  const { home, hub, uninstall } = await fixture();
  const plan = skillLinkPlanSchema.parse(await hub.request("link-plan", {}));
  uninstall();
  await expect(hub.request("link-apply", { id: plan.id })).rejects.toThrow("stale_plan");
  await expect(fs.lstat(path.join(home, ".claude/skills/example"))).rejects.toThrow();
});

it("keeps managed delegation links protected from targeted unlink requests", async () => {
  const { home, hub } = await fixture();
  const link = path.join(home, ".claude/skills/codexhost-delegation");
  await fs.symlink("../../.agents/skills/codexhost-delegation", link);
  const scope = { agentId: "claude-code", skill: "codexhost-delegation" };
  const plan = skillLinkPlanSchema.parse(
    await hub.request("link-plan", { scope, unlink: [scope] }),
  );
  expect(plan.actions).toEqual([]);
  expect(await fs.readlink(link)).toBe("../../.agents/skills/codexhost-delegation");
});

it("deduplicates targeted unlinks and refuses undo after the Agent is uninstalled", async () => {
  const { home, hub, uninstall } = await fixture();
  const link = path.join(home, ".claude/skills/example");
  await fs.symlink("../../.agents/skills/example", link);
  const scope = { agentId: "claude-code", skill: "example" };
  const plan = skillLinkPlanSchema.parse(
    await hub.request("link-plan", { scope, unlink: [scope, scope] }),
  );
  expect(plan.actions.map((action) => action.kind)).toEqual(["unlink"]);
  await hub.request("link-apply", { id: plan.id });
  uninstall();
  vi.clearAllMocks();
  await expect(hub.request("undo", { id: plan.id })).rejects.toThrow("undo_conflict");
  for (const operation of [fs.lstat, fs.stat, fs.readdir, fs.readFile])
    expect(
      vi
        .mocked(operation)
        .mock.calls.filter(([file]) => String(file).startsWith(path.join(home, ".claude"))),
    ).toEqual([]);
});

it("observes availability cache changes written by the Harness inspector", async () => {
  const { home } = await fixture();
  const environment = { CODEXHOST_USER_DIR: path.join(home, ".codexhost") };
  const inspector = new HarnessAvailabilityStore(environment);
  await inspector.set("claude-code", { status: "ready", checkedAt: 1 });
  const readAvailable = getSkillsHub(environment).local.options.availableHarnessIds;
  if (!readAvailable) throw new Error("Missing availability source");
  expect(await readAvailable()).toEqual(new Set(["claude-code"]));
  await inspector.set("claude-code", { status: "notInstalled", checkedAt: 2 });
  expect(await readAvailable()).toEqual(new Set());
});
