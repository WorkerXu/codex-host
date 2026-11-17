import { required } from "../src/skills-hub/files.js";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  skillSyncPlanSchema,
  skillSyncResultSchema,
  type SkillMachine,
} from "@codexhost/shared-contracts";
import { LocalSkillsHub } from "../src/skills-hub/local.js";
import { SkillsHubService } from "../src/skills-hub/service.js";
import { planSync } from "../src/skills-hub/sync.js";
import { runSkillsCli } from "../src/skills-hub/cli.js";
import { inventory } from "../src/skills-hub/inventory.js";
import {
  startDelegationControlServer,
  type DelegationControlServer,
} from "../src/delegation-control-server.js";
import type { DelegationControlApi } from "../src/delegation-types.js";
import { parsePeerExecRequest } from "../src/peer-exec.js";
const roots: string[] = [],
  servers: DelegationControlServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function machine() {
  const home = await mkdtemp(path.join(tmpdir(), "skills-host-"));
  roots.push(home);
  const paths = { home, state: path.join(home, ".codexhost/skills-hub"), searchPath: "" };
  return { home, paths, local: new LocalSkillsHub(paths) };
}
async function install(home: string, key: string, text: string) {
  const dir = path.join(home, ".agents/skills", key);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${key}\ndescription: Example\n---\n${text}`,
  );
  return dir;
}
async function setup() {
  const a = await machine(),
    b = await machine();
  const server = await startDelegationControlServer({
    token: "test-secret",
    api: {} as DelegationControlApi,
    skills: b.local,
  });
  servers.push(server);
  const service = new SkillsHubService(
    {},
    {
      local: a.local,
      hosts: async () => [
        { hostId: "local", name: "Mac" },
        { hostId: "peer", name: "Peer" },
      ],
      transport: async (hostId, op, body) => {
        expect(hostId).toBe("peer");
        const response = await fetch(`${server.endpoint}/v1/skills/${op}`, {
          method: "POST",
          headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = (await response.json()) as {
          error?: {
            message: string;
          };
        };
        if (result.error) throw new Error(result.error.message);
        return result;
      },
    },
  );
  return { a, b, service, server };
}
describe("skills sync planning", () => {
  it("fills only missing skills and asks for every ambiguous source", async () => {
    const a = await machine(),
      b = await machine(),
      c = await machine();
    await install(a.home, "example", "A");
    await install(b.home, "example", "B");
    const machines: SkillMachine[] = await Promise.all(
      [a, b, c].map(async (m, index) => ({
        hostId: String(index),
        name: String(index),
        inventory: await inventory(m.paths),
        error: null,
      })),
    );
    const plan = planSync(machines, { skill: "--all", mode: "fill", to: ["0", "1", "2"] });
    expect(plan.actions).toEqual([]);
    expect(plan.conflicts[0]?.diff).toContain("- A");
    const resolved = planSync(machines, {
      skill: "--all",
      mode: "fill",
      to: ["0", "1", "2"],
      choices: { example: "1" },
    });
    expect(resolved.actions.map((a) => a.targetHost)).toEqual(["2"]);
    expect(resolved.actions[0]?.sourceHost).toBe("1");
  });
});
describe("two fake hosts through authenticated skills routes", () => {
  it("copies tarball content, offers links separately and undoes imports", async () => {
    const { a, b, service } = await setup();
    await install(a.home, "example", "A");
    await mkdir(path.join(b.home, ".claude"));
    const plan = skillSyncPlanSchema.parse(
      await service.request({
        op: "sync-plan",
        skill: "example",
        mode: "sync",
        sourceHost: "local",
        to: ["peer"],
      }),
    );
    expect(
      await readFile(path.join(b.home, ".agents/skills/example/SKILL.md")).catch(() => null),
    ).toBeNull();
    const result = skillSyncResultSchema.parse(
      await service.request({ op: "sync-apply", id: plan.id }),
    );
    expect(result.results[0]?.error).toBeNull();
    expect(await readFile(path.join(b.home, ".agents/skills/example/SKILL.md"), "utf8")).toContain(
      "A",
    );
    expect(
      await readFile(path.join(b.home, ".claude/skills/example/SKILL.md")).catch(() => null),
    ).toBeNull();
    await service.request({ op: "undo", hostId: "peer", id: required(result.results[0]).id });
    expect(
      await readFile(path.join(b.home, ".agents/skills/example/SKILL.md")).catch(() => null),
    ).toBeNull();
    await expect(service.request({ op: "sync-apply", id: plan.id })).rejects.toThrow(
      "expired_plan",
    );
  });
  it("never overwrites a conflict without a fresh, explicit per-skill winner", async () => {
    const { a, b, service } = await setup();
    await install(a.home, "example", "A");
    const target = await install(b.home, "example", "B");
    const input = {
      op: "sync-plan",
      skill: "example",
      mode: "sync",
      sourceHost: "local",
      to: ["peer"],
    };
    const conflict = skillSyncPlanSchema.parse(await service.request(input));
    expect(conflict.conflicts).toHaveLength(1);
    await expect(service.request({ op: "sync-apply", id: conflict.id })).rejects.toThrow(
      "unresolved_conflicts",
    );
    const again = skillSyncPlanSchema.parse(await service.request(input));
    await expect(service.request({ ...input, choices: { example: "local" } })).rejects.toThrow(
      "expired_plan",
    );
    const resolved = skillSyncPlanSchema.parse(
      await service.request({ ...input, choices: { example: "local" }, basedOn: again.id }),
    );
    const result = skillSyncResultSchema.parse(
      await service.request({ op: "sync-apply", id: resolved.id }),
    );
    expect(required(result.results[0]).error).toBeNull();
    await service.request({ op: "undo", hostId: "peer", id: required(result.results[0]).id });
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("B");
    expect(skillSyncPlanSchema.parse(await service.request(input)).conflicts).toHaveLength(1);
  });
  it("rejects changed conflict versions and target changes after preview", async () => {
    const { a, b, service } = await setup();
    await install(a.home, "example", "A");
    const target = await install(b.home, "example", "B");
    const input = {
      op: "sync-plan",
      skill: "example",
      mode: "sync",
      sourceHost: "local",
      to: ["peer"],
    };
    const conflict = skillSyncPlanSchema.parse(await service.request(input));
    await writeFile(path.join(target, "extra"), "changed");
    await expect(
      service.request({ ...input, choices: { example: "local" }, basedOn: conflict.id }),
    ).rejects.toThrow("stale_plan");
    const fresh = skillSyncPlanSchema.parse(await service.request(input));
    const resolved = skillSyncPlanSchema.parse(
      await service.request({ ...input, choices: { example: "local" }, basedOn: fresh.id }),
    );
    await writeFile(path.join(target, "another"), "new");
    const result = skillSyncResultSchema.parse(
      await service.request({ op: "sync-apply", id: resolved.id }),
    );
    expect(required(result.results[0]).error).toBe("stale_plan");
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("B");
  });
  it("streams large tarballs in bounded chunks and restores source metadata on undo", async () => {
    const { a, b, service } = await setup();
    const directory = await install(a.home, "large", "large source");
    await writeFile(path.join(directory, "asset.bin"), randomBytes(1200000));
    await writeFile(
      path.join(a.home, ".agents/.skill-lock.json"),
      JSON.stringify({
        skills: { large: { source: "owner/repo", sourceUrl: "https://github.com/owner/repo" } },
      }),
    );
    const plan = skillSyncPlanSchema.parse(
      await service.request({
        op: "sync-plan",
        skill: "large",
        mode: "sync",
        sourceHost: "local",
        to: ["peer"],
      }),
    );
    const result = skillSyncResultSchema.parse(
      await service.request({ op: "sync-apply", id: plan.id }),
    );
    expect(result.results[0]?.error).toBeNull();
    expect(await readFile(path.join(b.home, ".agents/skills/large/asset.bin"))).toEqual(
      await readFile(path.join(directory, "asset.bin")),
    );
    expect((await inventory(b.paths)).skills[0]?.source?.source).toBe("owner/repo");
    await service.request({ op: "undo", hostId: "peer", id: required(result.results[0]).id });
    expect((await inventory(b.paths)).skills).toEqual([]);
  });
  it("rejects arbitrary routes, paths, unauthenticated requests and unpreviewed apply", async () => {
    const { service, server } = await setup();
    expect(() =>
      parsePeerExecRequest({ route: "/v1/skills/read", body: { path: "/etc/passwd" } }),
    ).toThrow();
    expect(parsePeerExecRequest({ route: "/v1/skills/inventory" }).route).toBe(
      "/v1/skills/inventory",
    );
    const noAuth = await fetch(`${server.endpoint}/v1/skills/inventory`, {
      method: "POST",
      body: "{}",
    });
    expect(noAuth.status).toBe(401);
    const bad = await fetch(`${server.endpoint}/v1/skills/export`, {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
      body: JSON.stringify({ skill: "../../bad", expected: "0".repeat(64) }),
    });
    expect(bad.status).toBe(400);
    await expect(
      service.request({
        op: "link-apply",
        hostId: "peer",
        id: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("expired_plan");
  });
  it("CLI scripts confirm the exact prior preview and choose conflict winners explicitly", async () => {
    const { a, b, service } = await setup();
    await install(a.home, "example", "A");
    const target = await install(b.home, "example", "B");
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const args = ["sync", "example", "--to", "peer"];
    expect(
      await runSkillsCli({
        arguments: [...args, "--dry-run"],
        environment: {},
        output: stream,
        service,
      }),
    ).toBe(0);
    const confirmation = (JSON.parse(output) as { confirmation: string }).confirmation;
    output = "";
    expect(
      await runSkillsCli({
        arguments: [...args, "--confirm", "wrong", "--choose", "example=local"],
        environment: {},
        output: stream,
        service,
      }),
    ).toBe(1);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("B");
    output = "";
    expect(
      await runSkillsCli({
        arguments: [...args, "--confirm", confirmation, "--choose", "example=local"],
        environment: {},
        output: stream,
        service,
      }),
    ).toBe(0);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("A");
  });
  it("CLI dry runs require neither runtime-control reads nor mutations", async () => {
    const { a, b, service } = await setup();
    await install(a.home, "example", "A");
    await mkdir(path.join(a.home, ".claude"));
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    expect(
      await runSkillsCli({
        arguments: ["link", "--dry-run"],
        environment: {},
        output: stream,
        service,
        ask: async () => {
          throw new Error("must not ask");
        },
      }),
    ).toBe(0);
    expect(output).toContain('"kind": "link"');
    expect(
      await runSkillsCli({
        arguments: ["sync", "example", "--to", "peer", "--dry-run"],
        environment: {},
        output: stream,
        service,
      }),
    ).toBe(0);
    expect(
      await readFile(path.join(b.home, ".agents/skills/example/SKILL.md")).catch(() => null),
    ).toBeNull();
  });
});
