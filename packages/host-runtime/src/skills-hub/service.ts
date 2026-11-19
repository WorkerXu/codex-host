import { required } from "./files.js";
import { z } from "zod";
import { skillExportSchema, skillChunkSchema, TRANSFER_CHARS } from "./transfers.js";
import { homedir, hostname } from "node:os";
import path from "node:path";
import {
  skillBundleSchema,
  skillChangeResultSchema,
  skillInventorySchema,
  skillLinkPlanSchema,
  skillsHubRequestSchema,
  type SkillMachine,
  type SkillSyncPlan,
} from "@codexhost/shared-contracts";
import { readPeerConfig, resolvePeerTarget } from "../peer-config.js";
import { requestPeerRoute } from "../peer-transport.js";
import { codexhostUserDirectory } from "../runtime-control-file.js";
import { fail } from "./files.js";
import { LocalSkillsHub, type SkillPeerOperation } from "./local.js";
import { installedHarnessIds } from "../installed-harness-plugins.js";
import { planSync } from "./sync.js";
export type SkillTransport = (
  hostId: string,
  op: SkillPeerOperation,
  body: Record<string, unknown>,
) => Promise<unknown>;
export function skillsError(error: unknown): string {
  const e = error as {
    code?: string;
    message?: string;
    details?: {
      reason?: string;
    };
  };
  if (e.code === "EACCES" || e.code === "EPERM") return "permission_denied";
  if (e.details?.reason === "peer_timeout" || e.message?.includes("timeout"))
    return "connection_timeout";
  if (e.code === "RUNTIME_UNREACHABLE") return "connection_failed";
  const known = [
    "permission_denied",
    "connection_timeout",
    "stale_plan",
    "expired_plan",
    "undo_conflict",
    "unknown_change",
    "skill_missing",
    "connection_failed",
    "fingerprint_mismatch",
    "skill_too_large",
    "symlink_path",
    "invalid_archive",
    "invalid_archive_path",
  ];
  return known.includes(e.message ?? "") ? required(e.message) : "skills_failed";
}
export class SkillsHubService {
  readonly local: LocalSkillsHub;
  readonly #transport: SkillTransport;
  readonly #canonicalHost: (hostId: string) => Promise<string>;
  readonly #hosts: () => Promise<
    {
      hostId: string;
      name: string;
    }[]
  >;
  readonly #plans = new Map<
    string,
    {
      plan: SkillSyncPlan;
      created: number;
      snapshot: SkillMachine[];
      scope: string;
    }
  >();
  constructor(
    environment: NodeJS.ProcessEnv,
    options: {
      local?: LocalSkillsHub;
      transport?: SkillTransport;
      hosts?: () => Promise<
        {
          hostId: string;
          name: string;
        }[]
      >;
      installedHarnessIds?: () => Promise<ReadonlySet<string>>;
    } = {},
  ) {
    this.local =
      options.local ??
      new LocalSkillsHub(
        {
          home: homedir(),
          state: path.join(codexhostUserDirectory(environment), "skills-hub"),
          searchPath: environment.PATH ?? "",
        },
        options.installedHarnessIds ? { installedHarnessIds: options.installedHarnessIds } : {},
      );
    this.#canonicalHost = async (hostId) => {
      if (hostId === "local" || options.hosts) return hostId;
      const target = resolvePeerTarget(await readPeerConfig(environment), hostId);
      if (!target) fail("connection_failed");
      return target === "local" ? "local" : target.name;
    };
    this.#transport =
      options.transport ??
      (async (hostId, op, body) => {
        const target = resolvePeerTarget(await readPeerConfig(environment), hostId);
        if (!target) fail("connection_failed");
        if (target === "local") return this.local.request(op, body);
        return requestPeerRoute({ environment, peer: target, route: `/v1/skills/${op}`, body });
      });
    this.#hosts =
      options.hosts ??
      (async () => [
        { hostId: "local", name: hostname() },
        ...Object.keys((await readPeerConfig(environment)).peers)
          .sort()
          .map((name) => ({ hostId: name, name })),
      ]);
  }
  async machineRequest(
    hostId: string,
    op: SkillPeerOperation,
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    return hostId === "local" ? this.local.request(op, body) : this.#transport(hostId, op, body);
  }
  async status(hostId?: string): Promise<{
    machines: SkillMachine[];
  }> {
    const hosts = await this.#hosts();
    const selected = hostId ? hosts.filter((machine) => machine.hostId === hostId) : hosts;
    if (hostId && !selected.length) selected.push({ hostId, name: hostId });
    return {
      machines: await Promise.all(
        selected.map(async (machine) => {
          try {
            return {
              ...machine,
              inventory: skillInventorySchema.parse(
                await this.machineRequest(machine.hostId, "inventory"),
              ),
              error: null,
            };
          } catch (error) {
            return { ...machine, inventory: null, error: skillsError(error) };
          }
        }),
      ),
    };
  }
  async request(value: unknown): Promise<unknown> {
    const input = skillsHubRequestSchema.parse(value);
    if (input.op === "status") return this.status(input.hostId);
    if (input.op === "sync-plan") {
      if (input.sourceHost) input.sourceHost = await this.#canonicalHost(input.sourceHost);
      input.to = [
        ...new Set(await Promise.all(input.to.map((hostId) => this.#canonicalHost(hostId)))),
      ];
      if (input.choices)
        for (const key of Object.keys(input.choices))
          input.choices[key] = await this.#canonicalHost(required(input.choices[key]));
      const scope = JSON.stringify([
        input.skill,
        input.mode,
        input.sourceHost ?? null,
        [...input.to].sort(),
      ]);
      const { machines } = await this.status();
      if (input.choices && Object.keys(input.choices).length) {
        const previous = input.basedOn ? this.#plans.get(input.basedOn) : undefined;
        if (!previous || Date.now() - previous.created > 600000) fail("expired_plan");
        if (previous.scope !== scope) fail("stale_plan");
        for (const [skill, winner] of Object.entries(input.choices)) {
          const conflict = previous.plan.conflicts.find((entry) => entry.skill === skill);
          if (!conflict || !conflict.versions.some((version) => version.hostId === winner))
            fail("invalid_choice");
          for (const machine of previous.snapshot) {
            const before =
              machine.inventory?.skills.find((entry) => entry.key === skill)?.fingerprint ?? null;
            const currentMachine = machines.find((entry) => entry.hostId === machine.hostId);
            if (Boolean(machine.inventory) !== Boolean(currentMachine?.inventory))
              fail("stale_plan");
            const after =
              currentMachine?.inventory?.skills.find((entry) => entry.key === skill)?.fingerprint ??
              null;
            if (before !== after) fail("stale_plan");
          }
        }
        this.#plans.delete(required(input.basedOn));
      }
      const plan = planSync(machines, input);
      for (const [id, stored] of this.#plans)
        if (Date.now() - stored.created > 600000) this.#plans.delete(id);
      if (this.#plans.size >= 100) fail("too_many_plans");
      this.#plans.set(plan.id, { plan, created: Date.now(), snapshot: machines, scope });
      return plan;
    }
    if (input.op === "sync-apply") {
      const stored = this.#plans.get(input.id);
      this.#plans.delete(input.id);
      if (!stored || Date.now() - stored.created > 600000) fail("expired_plan");
      if (stored.plan.conflicts.length) fail("unresolved_conflicts");
      const results: {
        hostId: string;
        skill: string;
        id?: string;
        error: string | null;
      }[] = [];
      for (const action of stored.plan.actions) {
        try {
          const exported = skillExportSchema.parse(
            await this.machineRequest(action.sourceHost, "export", {
              skill: action.skill,
              expected: action.fingerprint,
            }),
          );
          if (exported.skill !== action.skill || exported.fingerprint !== action.fingerprint)
            fail("fingerprint_mismatch");
          let imported: unknown;
          if (exported.token) {
            if (!exported.length) fail("invalid_transfer");
            const { token, length } = exported;
            const bundle = {
              skill: exported.skill,
              fingerprint: exported.fingerprint,
              source: exported.source,
              files: exported.files,
            };
            const incoming = z.object({ token: z.string().uuid() }).parse(
              await this.machineRequest(action.targetHost, "import-begin", {
                bundle,
                expected: action.expected,
                length,
              }),
            );
            for (let offset = 0; offset < length; offset += TRANSFER_CHARS) {
              const chunk = skillChunkSchema.parse(
                await this.machineRequest(action.sourceHost, "export-chunk", { token, offset }),
              );
              if (chunk.data.length !== Math.min(TRANSFER_CHARS, length - offset))
                fail("invalid_transfer");
              await this.machineRequest(action.targetHost, "import-chunk", {
                token: incoming.token,
                offset,
                data: chunk.data,
              });
            }
            imported = await this.machineRequest(action.targetHost, "import-finish", {
              token: incoming.token,
            });
          } else {
            const bundle = skillBundleSchema.parse(exported);
            imported = await this.machineRequest(action.targetHost, "import", {
              bundle,
              expected: action.expected,
            });
          }
          const changed = skillChangeResultSchema.parse(imported);
          results.push({
            hostId: action.targetHost,
            skill: action.skill,
            id: changed.id,
            error: null,
          });
        } catch (error) {
          results.push({
            hostId: action.targetHost,
            skill: action.skill,
            error: skillsError(error),
          });
        }
      }
      return { results };
    }
    if (input.op === "link-plan") {
      const result = skillLinkPlanSchema.parse(
        await this.machineRequest(input.hostId, "link-plan", {
          ...(input.adopt ? { adopt: input.adopt } : {}),
        }),
      );
      return { ...result, hostId: input.hostId };
    }
    if (input.op === "exclusions")
      return this.machineRequest(input.hostId, "exclusions", { agents: input.agents });
    return this.machineRequest(input.hostId, input.op, { id: input.id });
  }
}
const services = new Map<string, SkillsHubService>();
export function getSkillsHub(environment: NodeJS.ProcessEnv): SkillsHubService {
  const key = codexhostUserDirectory(environment);
  let service = services.get(key);
  if (!service) {
    service = new SkillsHubService(environment, {
      installedHarnessIds: () => installedHarnessIds(environment),
    });
    services.set(key, service);
  }
  return service;
}
