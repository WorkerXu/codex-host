import { z } from "zod";

export const THREAD_FOLDERS_GET_METHOD = "codexhost/thread-folders/get";
export const THREAD_FOLDERS_SET_METHOD = "codexhost/thread-folders/set";
/** Private draft carrier, removed before forwarding to an app-server. */
export const THREAD_FOLDERS_PARAM = "codexhostWorkingFolders";

export const workingFoldersSchema = z
  .array(z.string().min(1).max(4096))
  .min(1)
  .max(64)
  .refine((paths) => new Set(paths).size === paths.length, "Folders must be unique");
export const threadFoldersGetParamsSchema = z
  .object({ threadId: z.string().min(1).optional(), harnessId: z.string().min(1).optional() })
  .strict();
export const threadFoldersSetParamsSchema = z
  .object({
    threadId: z.string().min(1),
    folders: workingFoldersSchema,
  })
  .strict();
export const threadFoldersSelectionSchema = z
  .object({
    folders: workingFoldersSchema,
    appliedFolders: workingFoldersSchema.nullable(),
    changedAt: z.string().datetime(),
    notes: z.array(z.object({ text: z.string(), at: z.string().datetime() })).max(100),
  })
  .strict();
export const threadFoldersGetResultSchema = z
  .object({
    selection: threadFoldersSelectionSchema.nullable(),
    recent: z.array(z.string()).max(64),
    additionalDirectories: z.boolean(),
  })
  .strict();
export type ThreadFoldersSelection = z.infer<typeof threadFoldersSelectionSchema>;
