import { z } from "zod";

/**
 * Jarvis mention carrier shared by the Renderer `@` menu and the Host.
 *
 * The Renderer inserts Codex Desktop's native mention chip, which Desktop
 * serializes into the prompt as a Markdown link with a `jarvis://` path. The
 * Host rewrites every carrier into fetched Jarvis details before the prompt
 * reaches a Harness, so the raw link never leaks into a model turn.
 */
export const JARVIS_MENTION_PATH_PREFIX = "jarvis://";

/** The `@` menu only carries bugs; projects, requirements and tasks are gone. */
export const JARVIS_KINDS = ["bug"] as const;
export type JarvisKind = (typeof JARVIS_KINDS)[number];

const JARVIS_ID = /^[1-9][0-9]{0,17}$/u;
const BUG_MENTION_LINK_PATTERN =
  /\[@([^\]\n]+)\]\(<?jarvis:\/\/bug\/([0-9]{1,18})\/([0-9]{1,18})>?\)/gu;

export interface JarvisMention {
  kind: "bug";
  /** Jarvis bug id. */
  id: number;
  projectId: number;
  label: string;
}

function positiveId(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid Jarvis ${name}: ${value}`);
  }
  return value;
}

/** Exact native mention path for one Jarvis bug. */
export function jarvisMentionPath(mention: {
  kind: "bug";
  id: number;
  projectId?: number;
}): string {
  const id = positiveId(mention.id, "bug id");
  const projectId = positiveId(mention.projectId ?? 0, "project id");
  return `${JARVIS_MENTION_PATH_PREFIX}bug/${projectId}/${id}`;
}

function sanitizeLabel(label: string): string {
  const cleaned = label
    .replace(/[[\]()\n\r]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "Jarvis";
}

/** Markdown carrier Desktop restores into a native mention chip. */
export function formatJarvisMentionLink(mention: JarvisMention): string {
  return `[@${sanitizeLabel(mention.label)}](${jarvisMentionPath(mention)})`;
}

export interface JarvisMentionRewrite {
  text: string;
  mentions: JarvisMention[];
}

/**
 * Replace each carrier link with its readable `@Label` form. Returns the
 * mentioned bugs in first-seen order, without duplicates.
 */
export function stripJarvisMentions(text: string): JarvisMentionRewrite {
  const mentions: JarvisMention[] = [];
  const seen = new Set<string>();
  const rewritten = text.replace(
    BUG_MENTION_LINK_PATTERN,
    (_match, label: string, first: string, second: string) => {
      const trimmed = label.trim();
      if (!JARVIS_ID.test(first) || !JARVIS_ID.test(second)) return _match;
      const item: JarvisMention = {
        kind: "bug",
        id: Number(second),
        projectId: Number(first),
        label: trimmed,
      };
      const key = `${item.projectId}:${item.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push(item);
      }
      return `@${trimmed}`;
    },
  );
  return { text: rewritten, mentions };
}

/** A bug row returned by the structured `@` search. */
export const jarvisBugSchema = z
  .object({
    id: z.number().int().positive(),
    projectId: z.number().int().positive(),
    projectName: z.string().max(1_024).optional(),
    title: z.string().min(1).max(4_096),
    status: z.number().int().optional(),
    priority: z.number().int().optional(),
    severity: z.number().int().optional(),
    creatorId: z.number().int().positive().optional(),
    assigneeId: z.number().int().positive().optional(),
    createdAt: z.string().max(64).optional(),
    updatedAt: z.string().max(64).optional(),
  })
  .strict();
export type JarvisBug = z.infer<typeof jarvisBugSchema>;

/** One parsed condition, rendered as a removable chip in the `@` popup. */
export const jarvisBugConditionSchema = z
  .object({
    key: z.string().min(1).max(64),
    kind: z.enum(["scope", "status", "priority", "severity", "order", "time", "project", "title"]),
    label: z.string().min(1).max(64),
  })
  .strict();
export type JarvisBugCondition = z.infer<typeof jarvisBugConditionSchema>;

export const jarvisUserSchema = z
  .object({ id: z.number().int().positive(), name: z.string().min(1).max(256) })
  .strict();
export type JarvisUser = z.infer<typeof jarvisUserSchema>;

export const jarvisStatusSchema = z
  .object({
    installed: z.boolean(),
    version: z.string().max(64).nullable(),
    platform: z.string().max(64).nullable(),
    authenticated: z.boolean(),
    userName: z.string().max(256).nullable(),
    userId: z.number().int().positive().nullable(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type JarvisStatus = z.infer<typeof jarvisStatusSchema>;

export const jarvisReleaseSchema = z
  .object({
    id: z.number().int().positive(),
    version: z.string().min(1).max(64),
    build: z.number().int().nonnegative(),
    platform: z.string().min(1).max(64),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    size: z.number().int().positive(),
    downloadUrl: z.string().url(),
  })
  .strict();
export type JarvisRelease = z.infer<typeof jarvisReleaseSchema>;

/** Local-only Host methods: the Gemini key never leaves the Desktop Host. */
export const JARVIS_SETTINGS_GET_METHOD = "codexhost/jarvis/settings/get";
export const JARVIS_SETTINGS_SET_METHOD = "codexhost/jarvis/settings/set";
export const JARVIS_SETTINGS_TEST_METHOD = "codexhost/jarvis/settings/test";
export const JARVIS_LOGIN_FORWARD_METHOD = "codexhost/jarvis/login/forward";
export const JARVIS_LOGIN_STOP_METHOD = "codexhost/jarvis/login/stop";

/** Methods every Host can serve from its own machine. */
export const JARVIS_STATUS_METHOD = "codexhost/jarvis/status";
/**
 * Legacy one-box search. Retained so older Renderers keep working; the current
 * `@` panel never calls it, because its model interpretation is the slow path.
 */
export const JARVIS_BUG_SEARCH_METHOD = "codexhost/jarvis/bug/search";
export const JARVIS_BUG_SEARCH_CANCEL_METHOD = "codexhost/jarvis/bug/search/cancel";
/** Two-step search: pick a project, then search bugs inside it. */
export const JARVIS_PROJECT_LIST_METHOD = "codexhost/jarvis/project/list";
/** Instant title-only preview in the chosen project; no model is involved. */
export const JARVIS_PROJECT_BUG_TITLE_METHOD = "codexhost/jarvis/project/bug/title";
/** Condition search inside the chosen project; the project is never resolved. */
export const JARVIS_PROJECT_BUG_SEARCH_METHOD = "codexhost/jarvis/project/bug/search";
export const JARVIS_INSTALL_METHOD = "codexhost/jarvis/install";
export const JARVIS_DOWNLOAD_START_METHOD = "codexhost/jarvis/download/start";
export const JARVIS_DOWNLOAD_CHUNK_METHOD = "codexhost/jarvis/download/chunk";
export const JARVIS_INSTALL_UPLOAD_METHOD = "codexhost/jarvis/install/upload";
export const JARVIS_LOGIN_START_METHOD = "codexhost/jarvis/login/start";

export const DEFAULT_JARVIS_THRESHOLD = 0.5;
export const JARVIS_MAX_SEARCH_BUGS = 200;
export const JARVIS_MAX_SEARCH_PROJECTS = 40;
export const JARVIS_MAX_PROJECT_ROWS = 40;
export const JARVIS_KEY_MAX_LENGTH = 512;

/** One project row in the `@` panel's first step. */
export const jarvisProjectSchema = z
  .object({ id: z.number().int().positive(), name: z.string().min(1).max(1_024) })
  .strict();
export type JarvisProject = z.infer<typeof jarvisProjectSchema>;

export const jarvisProjectListParamsSchema = z
  .object({ query: z.string().trim().max(56).optional() })
  .strict();
export type JarvisProjectListParams = z.infer<typeof jarvisProjectListParamsSchema>;

export const jarvisProjectListResultSchema = z
  .object({
    available: z.boolean(),
    errorCode: z.string().max(64).nullable(),
    projects: z.array(jarvisProjectSchema).max(JARVIS_MAX_PROJECT_ROWS),
    /** False when the CLI stopped at its own row limit. */
    complete: z.boolean(),
    /** Signed-in Jarvis user; the Renderer scopes its local cache by it. */
    userId: z.number().int().positive().nullable(),
  })
  .strict();
export type JarvisProjectListResult = z.infer<typeof jarvisProjectListResultSchema>;

/** Fast title preview: raw text becomes `bug list --title`, no interpretation. */
export const jarvisProjectBugTitleParamsSchema = z
  .object({
    projectId: z.number().int().positive(),
    title: z.string().trim().max(200),
  })
  .strict();
export type JarvisProjectBugTitleParams = z.infer<typeof jarvisProjectBugTitleParamsSchema>;

/** Parsed condition search limited to one project chosen in step 1. */
export const jarvisProjectBugSearchParamsSchema = z
  .object({
    projectId: z.number().int().positive(),
    query: z.string().trim().max(200),
    omit: z.array(z.string().min(1).max(64)).max(24).optional(),
    requestId: z.string().uuid().optional(),
  })
  .strict();
export type JarvisProjectBugSearchParams = z.infer<typeof jarvisProjectBugSearchParamsSchema>;

export const jarvisBugSearchParamsSchema = z
  .object({
    query: z.string().trim().max(200),
    omit: z.array(z.string().min(1).max(64)).max(24).optional(),
    requestId: z.string().uuid().optional(),
  })
  .strict();
export type JarvisBugSearchParams = z.infer<typeof jarvisBugSearchParamsSchema>;
export const jarvisBugSearchCancelParamsSchema = z.strictObject({ requestId: z.string().uuid() });

/** Model query conditions; timestamps are Unix milliseconds in Asia/Shanghai. */
export const jarvisBugQuerySchema = z
  .object({
    scope: z.enum(["assigned", "created", "both"]),
    statuses: z.array(z.number().int().min(1).max(3)).max(3),
    priorities: z.array(z.number().int().min(1).max(3)).max(3),
    severities: z.array(z.number().int().min(1).max(4)).max(4),
    order: z.enum(["newest", "oldest"]),
    timeWindow: z
      .object({
        since: z.number().int().min(0).max(8.64e15).nullable(),
        until: z.number().int().min(0).max(8.64e15).nullable(),
        field: z.enum(["create", "update"]),
      })
      .strict()
      .refine(
        ({ since, until }) =>
          (since !== null || until !== null) && (since === null || until === null || since < until),
      )
      .nullable(),
    titleKeywords: z.array(z.string().trim().min(1).max(200)).max(8),
    projectNames: z.array(z.string().trim().min(1).max(56)).max(8),
    unrecognized: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();
export type JarvisBugQuery = z.infer<typeof jarvisBugQuerySchema>;

export const jarvisBugSearchResultSchema = z
  .object({
    available: z.boolean(),
    errorCode: z.string().max(64).nullable(),
    conditions: z.array(jarvisBugConditionSchema).max(24),
    bugs: z.array(jarvisBugSchema).max(JARVIS_MAX_SEARCH_BUGS),
    total: z.number().int().nonnegative(),
    capped: z.boolean(),
    /** Optional for compatibility with older Hosts. */
    source: z.enum(["openai", "gemini", "model"]).optional(),
  })
  .strict();
export type JarvisBugSearchResult = z.infer<typeof jarvisBugSearchResultSchema>;

export const jarvisSettingsResultSchema = z
  .object({
    hasKey: z.boolean(),
    threshold: z.number().min(0).max(1),
  })
  .strict();
export type JarvisSettingsResult = z.infer<typeof jarvisSettingsResultSchema>;

export const jarvisSettingsSetParamsSchema = z
  .object({
    geminiApiKey: z.string().max(JARVIS_KEY_MAX_LENGTH).nullable().optional(),
    threshold: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((value) => value.geminiApiKey !== undefined || value.threshold !== undefined, {
    message: "Nothing to update",
  });
export type JarvisSettingsSetParams = z.infer<typeof jarvisSettingsSetParamsSchema>;

export const jarvisSettingsTestResultSchema = z
  .object({
    ok: z.boolean(),
    latencyMs: z.number().int().nonnegative().nullable(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type JarvisSettingsTestResult = z.infer<typeof jarvisSettingsTestResultSchema>;

export const jarvisInstallParamsSchema = z.object({ mode: z.enum(["auto"]).optional() }).strict();
export type JarvisInstallParams = z.infer<typeof jarvisInstallParamsSchema>;

export const jarvisInstallResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("installed"), status: jarvisStatusSchema }),
  z.strictObject({
    state: z.literal("relay-required"),
    release: jarvisReleaseSchema,
    reason: z.enum(["slow", "unavailable"]),
  }),
  z.strictObject({ state: z.literal("failed"), errorCode: z.string().max(64) }),
]);
export type JarvisInstallResult = z.infer<typeof jarvisInstallResultSchema>;

export const jarvisDownloadStartParamsSchema = z.object({ release: jarvisReleaseSchema }).strict();
export type JarvisDownloadStartParams = z.infer<typeof jarvisDownloadStartParamsSchema>;

export const jarvisDownloadStartResultSchema = z
  .object({ token: z.string().uuid(), size: z.number().int().positive() })
  .strict();
export type JarvisDownloadStartResult = z.infer<typeof jarvisDownloadStartResultSchema>;

export const jarvisDownloadChunkParamsSchema = z
  .object({
    token: z.string().uuid(),
    offset: z.number().int().nonnegative(),
    length: z.number().int().positive().max(1_048_576),
  })
  .strict();
export type JarvisDownloadChunkParams = z.infer<typeof jarvisDownloadChunkParamsSchema>;

export const jarvisDownloadChunkResultSchema = z
  .object({ data: z.string(), eof: z.boolean() })
  .strict();
export type JarvisDownloadChunkResult = z.infer<typeof jarvisDownloadChunkResultSchema>;

export const jarvisInstallUploadParamsSchema = z
  .object({
    uploadId: z.string().uuid(),
    index: z.number().int().nonnegative(),
    data: z.string(),
    totalSize: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    version: z.string().min(1).max(64),
    platform: z.string().min(1).max(64),
  })
  .strict();
export type JarvisInstallUploadParams = z.infer<typeof jarvisInstallUploadParamsSchema>;

export const jarvisInstallUploadResultSchema = z
  .object({
    state: z.enum(["uploading", "installed"]),
    received: z.number().int().nonnegative(),
    status: jarvisStatusSchema.optional(),
  })
  .strict();
export type JarvisInstallUploadResult = z.infer<typeof jarvisInstallUploadResultSchema>;

export const jarvisLoginStartResultSchema = z
  .object({
    authUrl: z.string().url(),
    callbackPort: z.number().int().min(1).max(65_535),
    expiresAt: z.string().max(64),
  })
  .strict();
export type JarvisLoginStartResult = z.infer<typeof jarvisLoginStartResultSchema>;

export const jarvisLoginForwardParamsSchema = z
  .object({
    targetHostId: z.string().min(1).max(1_024),
    callbackPort: z.number().int().min(1).max(65_535),
    authUrl: z.string().url(),
  })
  .strict();
export type JarvisLoginForwardParams = z.infer<typeof jarvisLoginForwardParamsSchema>;

export const jarvisLoginForwardResultSchema = z
  .object({
    forwarded: z.boolean(),
    authUrl: z.string().url(),
    forwardId: z.string().uuid().nullable(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type JarvisLoginForwardResult = z.infer<typeof jarvisLoginForwardResultSchema>;

export const jarvisLoginStopParamsSchema = z.object({ forwardId: z.string().uuid() }).strict();
export type JarvisLoginStopParams = z.infer<typeof jarvisLoginStopParamsSchema>;
