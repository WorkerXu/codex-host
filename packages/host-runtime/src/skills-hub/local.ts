import { setSource } from "./provenance.js";
import { SkillTransfers } from "./transfers.js";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  skillImportSchema,
  skillKeySchema,
  type SkillBundle,
  type SkillLinkPlan,
} from "@codexhost/shared-contracts";
import { exists, fail, fingerprint, inventoryEntry, readSkillFiles, safePath } from "./files.js";
import { inventory, library, type SkillPaths } from "./inventory.js";
import { applyLinks, planLinks, saveManifest, undoChanges } from "./links.js";
import { packSkill, unpackSkill } from "./archive.js";
import { reinstallSource } from "./source.js";

export const SKILL_PEER_OPERATIONS = [
  "export-chunk",
  "import-begin",
  "import-chunk",
  "import-finish",
  "inventory",
  "link-plan",
  "link-apply",
  "undo",
  "exclusions",
  "export",
  "import",
] as const;
export type SkillPeerOperation = (typeof SKILL_PEER_OPERATIONS)[number];
const empty = z.object({}).strict();
const idInput = z.object({ id: z.string().uuid() }).strict();
const adoptionInput = z
  .object({
    adopt: z
      .array(z.object({ agentId: z.string(), skill: skillKeySchema }).strict())
      .max(100)
      .optional(),
  })
  .strict();

export class LocalSkillsHub {
  readonly plans = new Map<string, { plan: SkillLinkPlan; snapshot: string; created: number }>();
  readonly #transfers = new SkillTransfers();
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly paths: SkillPaths) {}
  /** Serialize mutations and previews within a machine, including requests arriving over peers. */
  request(op: SkillPeerOperation, body: unknown): Promise<unknown> {
    const operation = this.#tail.then(() => this.#request(op, body));
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
  async #request(op: SkillPeerOperation, body: unknown): Promise<unknown> {
    if (op === "export-chunk") return this.#transfers.chunk(body);
    if (op === "import-begin") return this.#transfers.begin(body);
    if (op === "import-chunk") return this.#transfers.append(body);
    if (op === "import-finish") return this.#import(this.#transfers.finish(body));
    if (op === "inventory") {
      empty.parse(body);
      return inventory(this.paths);
    }
    if (op === "link-plan") {
      const { adopt } = adoptionInput.parse(body);
      const plan = await planLinks(this.paths, adopt);
      // Fingerprints, exclusions, and every agent path participate in preview freshness.
      const snapshot = await this.#snapshot(plan);
      for (const [id, value] of this.plans)
        if (Date.now() - value.created > 600_000) this.plans.delete(id);
      if (this.plans.size >= 100) fail("too_many_plans");
      this.plans.set(plan.id, { plan, snapshot, created: Date.now() });
      return plan;
    }
    if (op === "link-apply") {
      const { id } = idInput.parse(body),
        stored = this.plans.get(id);
      this.plans.delete(id);
      if (!stored || Date.now() - stored.created > 600_000) fail("expired_plan");
      const adopt = stored.plan.actions
        .filter((a) => a.kind === "adopt")
        .map((a) => ({ agentId: a.agentId, skill: a.skill }));
      const fresh = await planLinks(this.paths, adopt);
      if ((await this.#snapshot(fresh)) !== stored.snapshot) fail("stale_plan");
      await this.#safeState();
      return applyLinks(this.paths, stored.plan);
    }
    if (op === "undo") {
      const { id } = idInput.parse(body);
      await this.#safeState();
      return undoChanges(this.paths, id);
    }
    if (op === "exclusions") {
      const { agents } = z
        .object({ agents: z.array(z.string().regex(/^[a-zA-Z0-9._-]+$/u)).max(100) })
        .strict()
        .parse(body);
      await this.#safeState();
      await this.#writeJson("exclusions.json", [...new Set(agents)]);
      return inventory(this.paths);
    }
    if (op === "export") {
      const { skill, expected } = z
        .object({ skill: skillKeySchema, expected: z.string() })
        .strict()
        .parse(body);
      const entry = (await inventory(this.paths)).skills.find((item) => item.key === skill);
      if (!entry || entry.fingerprint !== expected) fail("stale_plan");
      const files = await readSkillFiles(path.join(library(this.paths), skill));
      if (fingerprint(files) !== expected) fail("stale_plan");
      return this.#transfers.export({
        skill,
        fingerprint: expected,
        data: packSkill(files),
        source: entry.source,
        files: entry.files,
      } satisfies SkillBundle);
    }
    if (op === "import") return this.#import(skillImportSchema.parse(body));
    fail("unknown_operation");
  }
  async #snapshot(plan: SkillLinkPlan): Promise<string> {
    return JSON.stringify({ inventory: await inventory(this.paths), actions: plan.actions });
  }
  async #safeState(): Promise<void> {
    await safePath(this.paths.home, this.paths.state);
    await mkdir(this.paths.state, { recursive: true, mode: 0o700 });
  }
  async #writeJson(name: string, value: unknown): Promise<void> {
    const file = path.join(this.paths.state, name),
      temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }
  async #import({
    bundle,
    expected,
  }: z.infer<typeof skillImportSchema>): Promise<{ id: string; changed: number }> {
    // Even the source-reinstall path validates the tarball and its exact fingerprint first.
    const archived = unpackSkill(bundle.data);
    if (fingerprint(archived) !== bundle.fingerprint) fail("fingerprint_mismatch");
    inventoryEntry(bundle.skill, archived, bundle.source);
    const files = (await reinstallSource(bundle)) ?? archived;
    const destination = path.join(library(this.paths), bundle.skill);
    await safePath(this.paths.home, destination);
    const previousSource =
      (await inventory(this.paths)).skills.find((entry) => entry.key === bundle.skill)?.source ??
      null;
    const present = await exists(destination);
    if ((present ? fingerprint(await readSkillFiles(destination)) : null) !== expected)
      fail("stale_plan");
    await this.#safeState();
    const id = randomUUID(),
      staged = path.join(this.paths.state, `${id}.staged`);
    const backup = present ? path.join(this.paths.state, `${id}.backup`) : null;
    try {
      await mkdir(staged);
      for (const file of files) {
        const target = path.join(staged, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.data, { mode: file.executable ? 0o755 : 0o644, flag: "wx" });
      }
      // Source download may take time; compare again immediately before moving anything.
      await safePath(this.paths.home, destination);
      if (
        ((await exists(destination)) ? fingerprint(await readSkillFiles(destination)) : null) !==
        expected
      )
        fail("stale_plan");
      await mkdir(library(this.paths), { recursive: true });
      const manifest = {
        id,
        kind: "import" as const,
        undone: false,
        changes: [
          {
            action: {
              kind: "adopt" as const,
              agentId: "central",
              skill: bundle.skill,
              path: destination,
              target: destination,
              fingerprint: bundle.fingerprint,
              previousLink: null,
            },
            stage: "pending" as "pending" | "backed-up" | "done",
            backup,
            centralHash: expected,
            sourceBefore: previousSource,
            sourceAfter: bundle.source,
          },
        ],
      };
      await saveManifest(this.paths, manifest);
      if (backup) {
        await rename(destination, backup);
        manifest.changes[0]!.stage = "backed-up";
        await saveManifest(this.paths, manifest);
      }
      try {
        await rename(staged, destination);
      } catch (error) {
        if (backup) await rename(backup, destination);
        manifest.changes[0]!.stage = "pending";
        await saveManifest(this.paths, manifest);
        throw error;
      }
      await setSource(this.paths, bundle.skill, bundle.source);
      manifest.changes[0]!.stage = "done";
      await saveManifest(this.paths, manifest);
      return { id, changed: 1 };
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
}
