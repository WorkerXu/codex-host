import { z } from "zod";

export const SKILLS_HUB_METHOD = "codexhost/skills/request";
export const skillKeySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
const host = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const skillHostSchema = z.object({ hostId: host, name: z.string() }).strict();
export type SkillHost = z.infer<typeof skillHostSchema>;
export const skillSourceSchema = z
  .object({
    source: z.string().max(8192),
    sourceUrl: z.string().max(8192).optional(),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .optional(),
    skillPath: z.string().max(1024).optional(),
  })
  .strict();
export const skillFileSchema = z.object({
  path: z.string(),
  hash,
  size: z.number(),
  executable: z.boolean(),
});
export const skillInventoryEntrySchema = z.object({
  key: skillKeySchema,
  name: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  fingerprint: hash,
  modifiedAt: z.string(),
  skillMd: z.string(),
  files: z.array(skillFileSchema),
  source: skillSourceSchema.nullable(),
});
export type SkillInventoryEntry = z.infer<typeof skillInventoryEntrySchema>;
export type SkillSource = z.infer<typeof skillSourceSchema>;
export const skillAgentStateSchema = z.enum(["linked", "missing", "conflict", "managed", "native"]);
export const skillAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  skillsDir: z.string(),
  native: z.boolean().nullable(),
  evidence: z.string(),
  linked: z.number(),
  conflicts: z.number(),
  managed: z.number(),
  missing: z.number(),
  /** Per-skill state for the library badges and the Agent page. */
  states: z.record(z.string(), skillAgentStateSchema),
});
export type SkillAgent = z.infer<typeof skillAgentSchema>;
export const skillInventorySchema = z.object({
  skills: z.array(skillInventoryEntrySchema),
  agents: z.array(skillAgentSchema),
  warnings: z.array(z.string()),
});
export type SkillInventory = z.infer<typeof skillInventorySchema>;
export const skillMachineSchema = z.object({
  hostId: host,
  name: z.string(),
  inventory: skillInventorySchema.nullable(),
  error: z.string().nullable(),
});
export type SkillMachine = z.infer<typeof skillMachineSchema>;
export const skillLinkActionSchema = z.object({
  kind: z.enum(["link", "unlink", "remove-dangling", "conflict", "adopt"]),
  agentId: z.string(),
  skill: skillKeySchema,
  path: z.string(),
  target: z.string(),
  fingerprint: z.string().nullable(),
  previousLink: z.string().nullable(),
});
export const skillLinkPlanSchema = z.object({
  id: z.string().uuid(),
  hostId: host,
  actions: z.array(skillLinkActionSchema),
  warnings: z.array(z.string()),
});
export type SkillLinkAction = z.infer<typeof skillLinkActionSchema>;
export type SkillLinkPlan = z.infer<typeof skillLinkPlanSchema>;
export const skillSyncConflictSchema = z.object({
  skill: skillKeySchema,
  versions: z.array(z.object({ hostId: host, name: z.string(), entry: skillInventoryEntrySchema })),
  diff: z.string(),
});
export const skillSyncActionSchema = z.object({
  skill: skillKeySchema,
  sourceHost: host,
  targetHost: host,
  fingerprint: hash,
  expected: hash.nullable(),
});
export const skillSyncPlanSchema = z.object({
  id: z.string().uuid(),
  actions: z.array(skillSyncActionSchema),
  conflicts: z.array(skillSyncConflictSchema),
});
export type SkillSyncPlan = z.infer<typeof skillSyncPlanSchema>;
export const skillsHubRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("hosts") }).strict(),
  z.object({ op: z.literal("status"), hostId: host.optional() }).strict(),
  z
    .object({
      op: z.literal("link-plan"),
      hostId: host,
      adopt: z
        .array(z.object({ agentId: z.string(), skill: skillKeySchema }))
        .max(100)
        .optional(),
      unlink: z
        .array(z.object({ agentId: z.string(), skill: skillKeySchema }))
        .max(100)
        .optional(),
      scope: z.object({ agentId: z.string(), skill: skillKeySchema }).strict().optional(),
    })
    .strict(),
  z.object({ op: z.literal("link-apply"), hostId: host, id: z.string().uuid() }).strict(),
  z.object({ op: z.literal("undo"), hostId: host, id: z.string().uuid() }).strict(),
  z
    .object({
      op: z.literal("sync-plan"),
      skill: z.union([skillKeySchema, z.literal("--all")]),
      mode: z.enum(["sync", "fill"]),
      sourceHost: host.optional(),
      to: z.array(host).min(1).max(100),
      choices: z.record(z.string(), host).optional(),
      basedOn: z.string().uuid().optional(),
    })
    .strict(),
  z.object({ op: z.literal("sync-apply"), id: z.string().uuid() }).strict(),
]);
export type SkillsHubRequest = z.infer<typeof skillsHubRequestSchema>;
export const skillChangeResultSchema = z.object({ id: z.string().uuid(), changed: z.number() });
export const skillSyncResultSchema = z.object({
  results: z.array(
    z.object({
      hostId: host,
      skill: skillKeySchema,
      id: z.string().uuid().optional(),
      error: z.string().nullable(),
    }),
  ),
});
export const skillBundleSchema = z
  .object({
    skill: skillKeySchema,
    fingerprint: hash,
    data: z.string().max(96 * 1024 * 1024),
    source: skillSourceSchema.nullable(),
    files: z.array(skillFileSchema).max(8192),
  })
  .strict();
export type SkillBundle = z.infer<typeof skillBundleSchema>;
export const skillImportSchema = z
  .object({
    bundle: skillBundleSchema,
    expected: hash.nullable(),
  })
  .strict();
