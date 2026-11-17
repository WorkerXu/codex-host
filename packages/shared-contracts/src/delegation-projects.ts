import { z } from "zod";

export const DELEGATION_PROJECTS_METHOD = "codexhost/delegation/project-assignments";
export const DELEGATION_PROJECTS_CHANGED_METHOD =
  "codexhost/delegation/project-assignments/changed";
export const delegationProjectSchema = z
  .object({
    threadId: z.string().min(1),
    /** Omitted when the parent lives on the Host serving this assignment. */
    sourceHostId: z.string().min(1).optional(),
    sourceThreadId: z.string().min(1).optional(),
    /** Omitted inherits on the Desktop; null explicitly chooses no project. */
    projectId: z.string().min(1).nullable().optional(),
  })
  .strict();
export const delegationProjectsResultSchema = z
  .object({ assignments: z.array(delegationProjectSchema) })
  .strict();
export type DelegationProject = z.infer<typeof delegationProjectSchema>;
