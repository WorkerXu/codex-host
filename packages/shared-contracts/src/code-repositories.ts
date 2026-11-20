import { z } from "zod";

export const CODE_REPOSITORIES_PREFIX = "codexhost/code-repositories/";
export const repositoryProviderSchema = z.enum(["github", "gitlab"]);
export type RepositoryProvider = z.infer<typeof repositoryProviderSchema>;
export const codeRepositorySchema = z.strictObject({
  id: z.string().min(1).max(256),
  provider: repositoryProviderSchema,
  name: z.string().min(1).max(256),
  namespace: z.string().max(1024),
  description: z.string().max(2048),
  lastActivity: z.string(),
  cloneUrl: z.string().url(),
});
export type CodeRepository = z.infer<typeof codeRepositorySchema>;
export const repositorySettingsSchema = z.strictObject({
  gitlab: z.strictObject({ configured: z.boolean(), lastFour: z.string().max(4).nullable() }),
  github: z.strictObject({ login: z.string().nullable() }),
});
export type RepositorySettings = z.infer<typeof repositorySettingsSchema>;
export const repositoryListParamsSchema = z.strictObject({
  provider: repositoryProviderSchema,
  search: z.string().trim().max(200).default(""),
});
export const repositoryTokenParamsSchema = z.strictObject({
  token: z.string().trim().min(8).max(512).regex(/^\S+$/u).nullable(),
});
export const repositoryTargetParamsSchema = z.strictObject({
  hostId: z.string().min(1).max(256),
  parent: z.string().min(1).max(4096).optional(),
});
export const repositoryCloneParamsSchema = z.strictObject({
  provider: repositoryProviderSchema,
  repositoryId: z.string().min(1).max(256),
  hostId: z.string().min(1).max(256),
  parent: z.string().min(1).max(4096),
});
export type RepositoryCloneParams = z.infer<typeof repositoryCloneParamsSchema>;
export const repositoryTargetSchema = z.strictObject({
  parent: z.string(),
  children: z.array(z.string()),
});
export type RepositoryTarget = z.infer<typeof repositoryTargetSchema>;
export const repositoryJobSchema = z.strictObject({
  id: z.string(),
  state: z.enum(["cloning", "transferring", "complete", "conflict", "error"]),
  path: z.string(),
  errorCode: z.string().nullable(),
});
export type RepositoryJob = z.infer<typeof repositoryJobSchema>;
export const repositoryTestSchema = z.strictObject({
  ok: z.boolean(),
  errorCode: z.string().nullable(),
});
