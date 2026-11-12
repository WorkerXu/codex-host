import { z } from "zod";

/** Local-only Host methods used by the Renderer project-mirror companion. */
export const PROJECT_MIRROR_LIST_METHOD = "codexhost/project-mirror/list";
export const PROJECT_MIRROR_UPSERT_METHOD = "codexhost/project-mirror/upsert";

const projectIdSchema = z.string().min(1).max(1_024);
const hostIdSchema = z.string().min(1).max(1_024);
const remotePathSchema = z.string().min(1).max(4_096);
const labelSchema = z.string().min(1).max(1_024);
const timestampSchema = z.string().datetime();

/** One remote project created by codexhost for a local source project. */
export const projectMirrorRecordSchema = z
  .object({
    hostId: hostIdSchema,
    remoteProjectId: projectIdSchema,
    remotePath: remotePathSchema,
    label: labelSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export type ProjectMirrorRecord = z.infer<typeof projectMirrorRecordSchema>;

export const projectMirrorsFileSchema = z
  .object({
    formatVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    projects: z.record(projectIdSchema, projectMirrorRecordSchema),
    acknowledged: z.record(projectIdSchema, z.literal(true)),
  })
  .strict();

export type ProjectMirrorsFile = z.infer<typeof projectMirrorsFileSchema>;

export const projectMirrorListParamsSchema = z.object({}).strict();

export const projectMirrorListResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    projects: z.record(projectIdSchema, projectMirrorRecordSchema),
    acknowledged: z.array(projectIdSchema),
  })
  .strict();

export type ProjectMirrorListResult = z.infer<typeof projectMirrorListResultSchema>;

/**
 * `record: null` removes an existing mirror; omitting `record` keeps it.
 * `acknowledge` records that the user accepted the name-only classification
 * for this source project.
 */
export const projectMirrorUpsertParamsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    sourceProjectId: projectIdSchema,
    acknowledge: z.literal(true).optional(),
    record: projectMirrorRecordSchema.nullable().optional(),
  })
  .strict();

export type ProjectMirrorUpsertParams = z.infer<typeof projectMirrorUpsertParamsSchema>;

export const projectMirrorUpsertResultSchema = projectMirrorListResultSchema;

export type ProjectMirrorUpsertResult = z.infer<typeof projectMirrorUpsertResultSchema>;
