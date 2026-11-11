import { z } from "zod";

/** Local-only Host methods used by the Renderer project-group companion. */
export const PROJECT_GROUPS_LIST_METHOD = "codexhost/project-groups/list";
export const PROJECT_GROUPS_REPLACE_METHOD = "codexhost/project-groups/replace";
export const DESKTOP_PROJECTS_CATALOG_METHOD = "codexhost/desktop-projects/catalog";

export const projectGroupKindSchema = z.enum(["local", "remote"]);

const projectIdSchema = z.string().min(1).max(1_024);
const projectPathSchema = z.string().min(1).max(4_096);
const projectLabelSchema = z.string().min(1).max(1_024);

export const projectGroupLocalMemberSchema = z
  .object({
    projectKind: z.literal("local"),
    projectId: projectIdSchema,
    rootPaths: z.array(projectPathSchema).max(64),
    label: projectLabelSchema,
  })
  .strict();

export const projectGroupRemoteMemberSchema = z
  .object({
    projectKind: z.literal("remote"),
    projectId: projectIdSchema,
    hostId: z.string().min(1).max(1_024),
    remotePath: projectPathSchema,
    label: projectLabelSchema,
  })
  .strict();

export const projectGroupMemberSchema = z.discriminatedUnion("projectKind", [
  projectGroupLocalMemberSchema,
  projectGroupRemoteMemberSchema,
]);

export const projectGroupSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    order: z.number().int().nonnegative(),
    collapsed: z.boolean(),
    members: z.array(projectGroupMemberSchema).min(1).max(64),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

function refineProjectGroups(
  groups: readonly z.infer<typeof projectGroupSchema>[],
  context: z.RefinementCtx,
): void {
  const groupIds = new Set<string>();
  const members = new Set<string>();
  for (const [groupIndex, group] of groups.entries()) {
    if (groupIds.has(group.id)) {
      context.addIssue({
        code: "custom",
        path: [groupIndex, "id"],
        message: "Project group IDs must be unique",
      });
    }
    groupIds.add(group.id);
    for (const [memberIndex, member] of group.members.entries()) {
      const key = `${member.projectKind}\u0000${member.projectId}`;
      if (members.has(key)) {
        context.addIssue({
          code: "custom",
          path: [groupIndex, "members", memberIndex, "projectId"],
          message: "A project can belong to only one group",
        });
      }
      members.add(key);
    }
  }
}

export const projectGroupsSchema = z
  .array(projectGroupSchema)
  .max(64)
  .superRefine(refineProjectGroups);

export const projectGroupsFileSchema = z
  .object({
    formatVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    groups: projectGroupsSchema,
  })
  .strict();

export const projectGroupsListParamsSchema = z.object({}).strict();

export const projectGroupWarningSchema = z
  .object({
    kind: z.literal("quarantined"),
    backupName: z.string().min(1).max(256),
  })
  .strict();

export const projectGroupsListResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    groups: projectGroupsSchema,
    warning: projectGroupWarningSchema.nullable().optional(),
  })
  .strict();

export const projectGroupsReplaceParamsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    groups: projectGroupsSchema,
  })
  .strict();

export const projectGroupsReplaceResultSchema = projectGroupsListResultSchema;

/** Read-only projection of the Desktop project state used by the companion. */
export const desktopLocalProjectSchema = z
  .object({
    id: projectIdSchema,
    name: projectLabelSchema,
    rootPaths: z.array(projectPathSchema).max(64),
  })
  .passthrough();

export const desktopRemoteProjectSchema = z
  .object({
    id: projectIdSchema,
    hostId: z.string().min(1).max(1_024),
    remotePath: projectPathSchema,
    label: projectLabelSchema,
  })
  .passthrough();

export const desktopRemoteConnectionSchema = z
  .object({
    hostId: z.string().min(1).max(1_024),
    displayName: projectLabelSchema,
    alias: z.string().max(1_024).nullable().optional(),
    hostname: z.string().max(4_096).nullable().optional(),
    source: z.string().min(1).max(64),
  })
  .passthrough();

export const threadProjectAssignmentSchema = z
  .object({
    projectKind: projectGroupKindSchema,
    projectId: projectIdSchema,
  })
  .passthrough();

export const desktopProjectsCatalogSchema = z
  .object({
    localProjects: z.record(z.string(), desktopLocalProjectSchema),
    remoteProjects: z.array(desktopRemoteProjectSchema).max(1_024),
    threadProjectAssignments: z.record(z.string(), threadProjectAssignmentSchema),
    codexManagedRemoteConnections: z.array(desktopRemoteConnectionSchema).max(1_024),
    projectOrder: z.array(z.string().min(1).max(1_024)).max(4_096),
    readAt: z.string().datetime(),
  })
  .strict();

export type ProjectGroupKind = z.infer<typeof projectGroupKindSchema>;
export type ProjectGroupLocalMember = z.infer<typeof projectGroupLocalMemberSchema>;
export type ProjectGroupRemoteMember = z.infer<typeof projectGroupRemoteMemberSchema>;
export type ProjectGroupMember = z.infer<typeof projectGroupMemberSchema>;
export type ProjectGroup = z.infer<typeof projectGroupSchema>;
export type ProjectGroupsFile = z.infer<typeof projectGroupsFileSchema>;
export type ProjectGroupWarning = z.infer<typeof projectGroupWarningSchema>;
export type ProjectGroupsListResult = z.infer<typeof projectGroupsListResultSchema>;
export type ProjectGroupsReplaceParams = z.infer<typeof projectGroupsReplaceParamsSchema>;
export type ProjectGroupsReplaceResult = z.infer<typeof projectGroupsReplaceResultSchema>;
export type DesktopLocalProject = z.infer<typeof desktopLocalProjectSchema>;
export type DesktopRemoteProject = z.infer<typeof desktopRemoteProjectSchema>;
export type DesktopRemoteConnection = z.infer<typeof desktopRemoteConnectionSchema>;
export type ThreadProjectAssignment = z.infer<typeof threadProjectAssignmentSchema>;
export type DesktopProjectsCatalog = z.infer<typeof desktopProjectsCatalogSchema>;
