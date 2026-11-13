import { z } from "zod";

/**
 * Codex custom agents are standalone TOML files under `$CODEX_HOME/agents`.
 * `name`, `description` and `developer_instructions` are required; every other
 * key belongs to Codex's own configuration schema, so the Host edits the three
 * required keys plus `model`/`model_reasoning_effort` and preserves the rest.
 */
export const CODEX_AGENT_LIST_METHOD = "codexhost/codex-agents/list";
export const CODEX_AGENT_READ_METHOD = "codexhost/codex-agents/read";
export const CODEX_AGENT_SAVE_METHOD = "codexhost/codex-agents/save";
export const CODEX_AGENT_DELETE_METHOD = "codexhost/codex-agents/delete";
export const CODEX_AGENT_CATALOG_METHOD = "codexhost/codex-agents/catalog";

/**
 * Codex refers to an agent by its `name` field. The loader only requires a
 * non-empty name, but a transport-safe identifier avoids prompts, file names
 * and shell-adjacent surfaces that cannot address the agent reliably.
 */
export const CODEX_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
export const CODEX_AGENT_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.toml$/u;
export const CODEX_AGENT_DESCRIPTION_MAX_LENGTH = 4_096;
export const CODEX_AGENT_INSTRUCTIONS_MAX_LENGTH = 200_000;
export const CODEX_AGENT_MODEL_MAX_LENGTH = 128;
export const CODEX_AGENT_EFFORT_MAX_LENGTH = 64;
export const CODEX_AGENT_MAX_FILES = 512;

export function isCodexAgentName(value: string): boolean {
  return CODEX_AGENT_NAME_PATTERN.test(value);
}

export function isCodexAgentFileName(value: string): boolean {
  return CODEX_AGENT_FILE_NAME_PATTERN.test(value) && !value.includes("..");
}

const nonBlankText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: "Value must not be blank" });

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: "Value must not be blank" })
    .nullable();

export const codexAgentNameSchema = z.string().regex(CODEX_AGENT_NAME_PATTERN, "Invalid name");
export const codexAgentFileNameSchema = z
  .string()
  .max(128)
  .regex(CODEX_AGENT_FILE_NAME_PATTERN, "Invalid file name")
  .refine((value) => !value.includes(".."), { message: "Invalid file name" });

/** `mtimeMs` and size identify the exact file version the editor started from. */
export const codexAgentRevisionSchema = z.string().regex(/^[0-9]+-[0-9]+$/u, "Invalid revision");

export const codexAgentSummarySchema = z
  .object({
    fileName: codexAgentFileNameSchema,
    /** Hand-written files may not match our stricter identifier rule. */
    name: nonBlankText(CODEX_AGENT_MODEL_MAX_LENGTH),
    description: z.string().max(CODEX_AGENT_DESCRIPTION_MAX_LENGTH),
    model: z.string().max(CODEX_AGENT_MODEL_MAX_LENGTH).nullable(),
    reasoningEffort: z.string().max(CODEX_AGENT_EFFORT_MAX_LENGTH).nullable(),
    revision: codexAgentRevisionSchema,
  })
  .strict();

export type CodexAgentSummary = z.infer<typeof codexAgentSummarySchema>;

export const codexAgentRecordSchema = codexAgentSummarySchema
  .extend({
    developerInstructions: z.string().max(CODEX_AGENT_INSTRUCTIONS_MAX_LENGTH),
  })
  .strict();

export type CodexAgentRecord = z.infer<typeof codexAgentRecordSchema>;

export const CODEX_AGENT_ISSUE_REASONS = ["invalid_toml", "missing_fields", "unreadable"] as const;

export type CodexAgentIssueReason = (typeof CODEX_AGENT_ISSUE_REASONS)[number];

export const codexAgentIssueSchema = z
  .object({
    fileName: z.string().min(1).max(128),
    reason: z.enum(CODEX_AGENT_ISSUE_REASONS),
  })
  .strict();

export type CodexAgentIssue = z.infer<typeof codexAgentIssueSchema>;

export const codexAgentListResultSchema = z
  .object({
    directory: z.string().min(1).max(4_096),
    agents: z.array(codexAgentSummarySchema).max(CODEX_AGENT_MAX_FILES),
    issues: z.array(codexAgentIssueSchema).max(CODEX_AGENT_MAX_FILES),
  })
  .strict();

export type CodexAgentListResult = z.infer<typeof codexAgentListResultSchema>;

export const codexAgentReadParamsSchema = z.object({ fileName: codexAgentFileNameSchema }).strict();

export type CodexAgentReadParams = z.infer<typeof codexAgentReadParamsSchema>;

export const codexAgentSaveParamsSchema = z
  .object({
    /** Null creates a new file named after the agent. */
    fileName: codexAgentFileNameSchema.nullable(),
    /** Required for an update; ignored for a create. */
    expectedRevision: codexAgentRevisionSchema.nullable(),
    name: codexAgentNameSchema,
    description: nonBlankText(CODEX_AGENT_DESCRIPTION_MAX_LENGTH),
    model: optionalText(CODEX_AGENT_MODEL_MAX_LENGTH),
    reasoningEffort: optionalText(CODEX_AGENT_EFFORT_MAX_LENGTH),
    developerInstructions: nonBlankText(CODEX_AGENT_INSTRUCTIONS_MAX_LENGTH),
  })
  .strict();

export type CodexAgentSaveParams = z.infer<typeof codexAgentSaveParamsSchema>;

export const codexAgentDeleteParamsSchema = z
  .object({
    fileName: codexAgentFileNameSchema,
    expectedRevision: codexAgentRevisionSchema,
  })
  .strict();

export type CodexAgentDeleteParams = z.infer<typeof codexAgentDeleteParamsSchema>;

export const codexAgentDeleteResultSchema = z
  .object({ fileName: codexAgentFileNameSchema })
  .strict();

export type CodexAgentDeleteResult = z.infer<typeof codexAgentDeleteResultSchema>;

export const codexAgentModelEffortSchema = z
  .object({
    id: z.string().min(1).max(CODEX_AGENT_EFFORT_MAX_LENGTH),
    description: z.string().max(256),
  })
  .strict();

export type CodexAgentModelEffort = z.infer<typeof codexAgentModelEffortSchema>;

export const codexAgentModelSchema = z
  .object({
    model: z.string().min(1).max(CODEX_AGENT_MODEL_MAX_LENGTH),
    displayName: z.string().min(1).max(256),
    efforts: z.array(codexAgentModelEffortSchema).max(32),
    isDefault: z.boolean(),
  })
  .strict();

export type CodexAgentModel = z.infer<typeof codexAgentModelSchema>;

/** `available: false` lets the form fall back to free-text model ids. */
export const codexAgentCatalogResultSchema = z
  .object({
    available: z.boolean(),
    models: z.array(codexAgentModelSchema).max(256),
    defaultModel: z.string().max(CODEX_AGENT_MODEL_MAX_LENGTH).nullable(),
  })
  .strict();

export type CodexAgentCatalogResult = z.infer<typeof codexAgentCatalogResultSchema>;

export const CODEX_AGENT_ERROR_CODES = [
  "invalid_params",
  "invalid_name",
  "invalid_file_name",
  "invalid_field",
  "name_taken",
  "not_found",
  "revision_conflict",
  "invalid_toml",
  "unavailable",
  "io_failed",
] as const;

export type CodexAgentErrorCode = (typeof CODEX_AGENT_ERROR_CODES)[number];
