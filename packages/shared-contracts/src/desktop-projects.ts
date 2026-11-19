import { z } from "zod";

export const DESKTOP_PROJECTS_CATALOG_METHOD = "codexhost/desktop-projects/catalog";
const projectKindSchema = z.enum(["local", "remote"]);
const projectIdSchema = z.string().min(1).max(1_024);
const projectPathSchema = z.string().min(1).max(4_096);
const projectLabelSchema = z.string().min(1).max(1_024);

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
    projectKind: projectKindSchema,
    projectId: projectIdSchema,
    hostId: z.string().min(1).optional(),
    projectOrigin: z.literal("chatgpt").optional(),
  })
  .passthrough();

export const desktopSelectedProjectSchema = z
  .object({
    type: projectKindSchema,
    projectId: projectIdSchema,
  })
  .strict();

export type DesktopSelectedProject = z.infer<typeof desktopSelectedProjectSchema>;

export const desktopProjectsCatalogSchema = z
  .object({
    localProjects: z.record(z.string(), desktopLocalProjectSchema),
    remoteProjects: z.array(desktopRemoteProjectSchema).max(1_024),
    threadProjectAssignments: z.record(z.string(), threadProjectAssignmentSchema),
    /** Desktop migration identities for this local CODEX_HOME; never match projects by path. */
    appServerProjectIds: z.record(z.string(), z.string()).optional(),
    codexManagedRemoteConnections: z.array(desktopRemoteConnectionSchema).max(1_024),
    projectOrder: z.array(z.string().min(1).max(1_024)).max(4_096),
    /**
     * Optional so older Hosts and test fixtures stay valid. The project-mirror
     * companion treats a missing value as "unknown" and stays disabled.
     */
    selectedProject: desktopSelectedProjectSchema.nullable().optional(),
    homeDirectory: z.string().min(1).max(4_096).optional(),
    defaultProjectParent: z.string().min(1).max(4_096).optional(),
    readAt: z.string().datetime(),
  })
  .strict();

export type DesktopLocalProject = z.infer<typeof desktopLocalProjectSchema>;
export type DesktopRemoteProject = z.infer<typeof desktopRemoteProjectSchema>;
export type DesktopRemoteConnection = z.infer<typeof desktopRemoteConnectionSchema>;
export type ThreadProjectAssignment = z.infer<typeof threadProjectAssignmentSchema>;
export type DesktopProjectsCatalog = z.infer<typeof desktopProjectsCatalogSchema>;
