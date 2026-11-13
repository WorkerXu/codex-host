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

export const JARVIS_KINDS = ["project", "requirement", "task", "bug"] as const;
export type JarvisKind = (typeof JARVIS_KINDS)[number];

const JARVIS_ID = /^[1-9][0-9]{0,17}$/u;
const MENTION_LINK_PATTERN =
  /\[@([^\]\n]+)\]\(<?jarvis:\/\/(project|requirement|task|bug)\/([0-9]{1,18})(?:\/([0-9]{1,18}))?>?\)/gu;

export interface JarvisMention {
  kind: JarvisKind;
  /** Jarvis business id: project, requirement, task or bug id. */
  id: number;
  /** Owning project; required for bugs and optional for derived items. */
  projectId?: number;
  label: string;
}

function positiveId(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid Jarvis ${name}: ${value}`);
  }
  return value;
}

/** Exact native mention path for one Jarvis item. */
export function jarvisMentionPath(mention: {
  kind: JarvisKind;
  id: number;
  projectId?: number;
}): string {
  const id = positiveId(mention.id, "item id");
  if (mention.kind === "bug") {
    const projectId = positiveId(mention.projectId ?? 0, "project id");
    return `${JARVIS_MENTION_PATH_PREFIX}bug/${projectId}/${id}`;
  }
  return `${JARVIS_MENTION_PATH_PREFIX}${mention.kind}/${id}`;
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
 * mentioned items in first-seen order, without duplicates.
 */
export function stripJarvisMentions(text: string): JarvisMentionRewrite {
  const mentions: JarvisMention[] = [];
  const seen = new Set<string>();
  const rewritten = text.replace(
    MENTION_LINK_PATTERN,
    (_match, label: string, kind: string, first: string, second?: string) => {
      const trimmed = label.trim();
      if (!JARVIS_KINDS.includes(kind as JarvisKind)) return _match;
      if (!JARVIS_ID.test(first)) return _match;
      if (kind === "bug" && (!second || !JARVIS_ID.test(second))) return _match;
      const item: JarvisMention =
        kind === "bug"
          ? {
              kind: "bug",
              id: Number(second),
              projectId: Number(first),
              label: trimmed,
            }
          : { kind: kind as JarvisKind, id: Number(first), label: trimmed };
      const key = `${item.kind}:${item.projectId ?? ""}:${item.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push(item);
      }
      return `@${trimmed}`;
    },
  );
  return { text: rewritten, mentions };
}

/** A candidate row, and the shape returned to the Renderer for the `@` menu. */
export const jarvisCandidateSchema = z
  .object({
    kind: z.enum(JARVIS_KINDS),
    id: z.number().int().positive(),
    projectId: z.number().int().positive().optional(),
    projectName: z.string().max(1_024).optional(),
    title: z.string().min(1).max(4_096),
    status: z.number().int().optional(),
    statusLabel: z.string().max(64).optional(),
    creatorId: z.number().int().positive().optional(),
    creatorName: z.string().max(256).optional(),
    assigneeId: z.number().int().positive().optional(),
    assigneeName: z.string().max(256).optional(),
    createdAt: z.string().max(64).optional(),
  })
  .strict();
export type JarvisCandidate = z.infer<typeof jarvisCandidateSchema>;

export const jarvisUserSchema = z
  .object({ id: z.number().int().positive(), name: z.string().min(1).max(256) })
  .strict();
export type JarvisUser = z.infer<typeof jarvisUserSchema>;

export const jarvisSuggestionSchema = jarvisCandidateSchema.extend({ score: z.number() });
export type JarvisSuggestion = z.infer<typeof jarvisSuggestionSchema>;

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
export const JARVIS_CLASSIFY_METHOD = "codexhost/jarvis/classify";
export const JARVIS_CANDIDATES_METHOD = "codexhost/jarvis/candidates";
export const JARVIS_RANK_METHOD = "codexhost/jarvis/rank";
export const JARVIS_INSTALL_METHOD = "codexhost/jarvis/install";
export const JARVIS_DOWNLOAD_START_METHOD = "codexhost/jarvis/download/start";
export const JARVIS_DOWNLOAD_CHUNK_METHOD = "codexhost/jarvis/download/chunk";
export const JARVIS_INSTALL_UPLOAD_METHOD = "codexhost/jarvis/install/upload";
export const JARVIS_LOGIN_START_METHOD = "codexhost/jarvis/login/start";

export const DEFAULT_JARVIS_THRESHOLD = 0.5;
export const JARVIS_MAX_RANK_CANDIDATES = 200;
export const JARVIS_MAX_SUGGESTIONS = 8;
export const JARVIS_MIN_SUGGESTION_SCORE = 1.05;
export const JARVIS_KEY_MAX_LENGTH = 512;

export const jarvisClassifyParamsSchema = z
  .object({ query: z.string().trim().min(1).max(200) })
  .strict();
export type JarvisClassifyParams = z.infer<typeof jarvisClassifyParamsSchema>;

export const jarvisClassifyResultSchema = z
  .object({
    available: z.boolean(),
    isJarvis: z.boolean(),
    kind: z.enum([...JARVIS_KINDS, "none"]),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type JarvisClassifyResult = z.infer<typeof jarvisClassifyResultSchema>;

export const jarvisCandidatesParamsSchema = z
  .object({
    kind: z.enum(JARVIS_KINDS),
    refresh: z.boolean().optional(),
  })
  .strict();
export type JarvisCandidatesParams = z.infer<typeof jarvisCandidatesParamsSchema>;

export const jarvisCandidatesResultSchema = z
  .object({
    available: z.boolean(),
    candidates: z.array(jarvisCandidateSchema).max(2_000),
    user: jarvisUserSchema.nullable(),
    fetchedAt: z.string().max(64).nullable(),
  })
  .strict();
export type JarvisCandidatesResult = z.infer<typeof jarvisCandidatesResultSchema>;

export const jarvisRankParamsSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    kind: z.enum(JARVIS_KINDS),
    candidates: z.array(jarvisCandidateSchema).max(JARVIS_MAX_RANK_CANDIDATES),
    user: jarvisUserSchema.nullable().optional(),
  })
  .strict();
export type JarvisRankParams = z.infer<typeof jarvisRankParamsSchema>;

export const jarvisSuggestionsResultSchema = z
  .object({
    available: z.boolean(),
    suggestions: z.array(jarvisSuggestionSchema).max(JARVIS_MAX_SUGGESTIONS),
  })
  .strict();
export type JarvisSuggestionsResult = z.infer<typeof jarvisSuggestionsResultSchema>;

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
