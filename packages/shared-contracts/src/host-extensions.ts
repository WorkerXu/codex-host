import { z } from "zod";
import {
  desktopExtensionBackendMethodSchema,
  desktopExtensionHashSchema,
  desktopExtensionIdSchema,
  desktopExtensionManifestSchema,
  parseDesktopExtensionManifest,
  type DesktopExtensionBackendContext,
  type DesktopExtensionDefinitionV1,
} from "./desktop-extensions.js";
import { pluginRelativeResourceSchema } from "./harness-plugins.js";
import type { JsonObject, JsonValue } from "./json-value.js";

const reservedName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu;
export const HOST_EXTENSION_PAGE_API_VERSION = 1;
export const HOST_EXTENSION_MENTIONS_API_VERSION = 1;
export const HOST_EXTENSION_MENTION_SEARCH_METHOD = "mentions/search";
export const HOST_EXTENSION_MENTION_CANCEL_METHOD = "mentions/cancel";
export const HOST_EXTENSION_MENTION_EXPAND_METHOD = "mentions/expand";
export const HOST_EXTENSION_MENTION_MAX_SOURCES = 16;
export const HOST_EXTENSION_MENTION_MAX_QUERY_CHARS = 256;
export const HOST_EXTENSION_MENTION_MAX_RESULTS = 50;
export const HOST_EXTENSION_MENTION_MAX_EXPANDED_CHARS = 32_768;
export const HOST_EXTENSION_MENTION_MAX_TOTAL_EXPANDED_CHARS = 131_072;
const HOST_EXTENSION_MENTION_TOKEN_PREFIX = "codexhost-extension://mention/v1/";
const HOST_EXTENSION_MENTION_TOKEN_PREFIX_PATTERN = /codexhost-extension:\/\/mention\//gu;
export const hostExtensionIdSchema = desktopExtensionIdSchema.refine(
  (id) => !reservedName.test(id),
  "Reserved extension ID",
);
export const hostExtensionTargetSchema = z.enum(["desktop", "web"]);
export const hostExtensionDigestSchema = desktopExtensionHashSchema;
export const hostExtensionActivationIdSchema = z.uuid();
export const hostExtensionResourcePathSchema = pluginRelativeResourceSchema
  .refine(
    (resource) =>
      !/[\x00-\x1f\x7f<>"|*]/u.test(resource) &&
      resource.split("/").every((part) => !/[. ]$/u.test(part) && !reservedName.test(part)),
    "Expected a portable relative resource path",
  )
  .refine(
    (path) => path.split("/").length <= 32,
    "Extension resources may be at most 32 segments deep",
  );

export type HostExtensionTarget = z.infer<typeof hostExtensionTargetSchema>;
export type HostExtensionBackendContext = DesktopExtensionBackendContext;

const legacy = desktopExtensionManifestSchema.shape;
const localized = (max: number, min = 0) =>
  z.strictObject({
    en: z.string().trim().min(min).max(max),
    "zh-CN": z.string().trim().min(min).max(max),
  });
const resourceWithSuffix = (suffix: string) =>
  hostExtensionResourcePathSchema.refine(
    (path) => path.endsWith(suffix),
    `Expected a ${suffix} file`,
  );
const moduleEntry = resourceWithSuffix(".mjs");
const style = resourceWithSuffix(".css").optional();
export const hostExtensionCanonicalPath = (path: string) => path.normalize("NFC").toLowerCase();
const mentionText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Control characters are not allowed");
export const hostExtensionMentionSourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9._-]*$/u, "Expected a lowercase mention source ID");
export const hostExtensionMentionItemIdSchema = mentionText(512);
export const hostExtensionMentionLabelSchema = mentionText(256);
export const hostExtensionMentionSourceSchema = z.strictObject({
  id: hostExtensionMentionSourceIdSchema,
  label: localized(128, 1),
  picker: z.boolean().optional(),
});
export type HostExtensionMentionSource = z.infer<typeof hostExtensionMentionSourceSchema>;
export const hostExtensionMentionManifestSchema = z
  .strictObject({
    apiVersion: z.literal(HOST_EXTENSION_MENTIONS_API_VERSION),
    sources: z
      .array(hostExtensionMentionSourceSchema)
      .min(1)
      .max(HOST_EXTENSION_MENTION_MAX_SOURCES)
      .refine(
        (sources) => new Set(sources.map(({ id }) => id)).size === sources.length,
        "Duplicate mention source IDs",
      ),
  })
  .strict();
export type HostExtensionMentionManifest = z.infer<typeof hostExtensionMentionManifestSchema>;
export const hostExtensionMentionSearchParamsSchema = z.strictObject({
  requestId: z.uuid(),
  sourceId: hostExtensionMentionSourceIdSchema,
  query: z.string().max(HOST_EXTENSION_MENTION_MAX_QUERY_CHARS),
  limit: z.int().min(1).max(HOST_EXTENSION_MENTION_MAX_RESULTS),
  cursor: mentionText(2048).optional(),
});
export const hostExtensionMentionCandidateSchema = z.strictObject({
  itemId: hostExtensionMentionItemIdSchema,
  label: hostExtensionMentionLabelSchema,
  description: z.string().trim().max(1024).optional(),
});
export type HostExtensionMentionCandidate = z.infer<typeof hostExtensionMentionCandidateSchema>;
export const hostExtensionMentionSearchResultSchema = z.union([
  z.strictObject({
    items: z.array(hostExtensionMentionCandidateSchema).max(HOST_EXTENSION_MENTION_MAX_RESULTS),
  }),
  z.strictObject({
    pending: z.strictObject({
      cursor: mentionText(2048),
      retryAfterMs: z.int().min(100).max(5000).optional(),
    }),
  }),
]);
export const hostExtensionMentionCancelParamsSchema = z.strictObject({ requestId: z.uuid() });
export const hostExtensionMentionCancelResultSchema = z.strictObject({ cancelled: z.boolean() });
const mentionExpansionRequestSchema = z.strictObject({
  sourceId: hostExtensionMentionSourceIdSchema,
  itemId: hostExtensionMentionItemIdSchema,
  label: hostExtensionMentionLabelSchema,
});
export const hostExtensionMentionExpandParamsSchema = z.strictObject({
  mentions: z.array(mentionExpansionRequestSchema).min(1).max(256),
});
export const hostExtensionMentionExpandResultSchema = z.strictObject({
  expansions: z
    .array(
      z.strictObject({
        sourceId: hostExtensionMentionSourceIdSchema,
        itemId: hostExtensionMentionItemIdSchema,
        text: z.string().min(1).max(HOST_EXTENSION_MENTION_MAX_EXPANDED_CHARS),
      }),
    )
    .max(256),
});
export const hostExtensionMentionTokenSchema = z.strictObject({
  extensionId: hostExtensionIdSchema,
  sourceId: hostExtensionMentionSourceIdSchema,
  itemId: hostExtensionMentionItemIdSchema,
  label: hostExtensionMentionLabelSchema,
});
export type HostExtensionMentionToken = z.infer<typeof hostExtensionMentionTokenSchema>;
export interface HostExtensionMentionReference extends HostExtensionMentionToken {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
}
export interface HostExtensionMentionParseResult {
  readonly mentions: HostExtensionMentionReference[];
  readonly invalid: boolean;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function displayMentionLabel(label: string): string {
  return (
    label
      .replace(/[\u0000-\u001f\u007f[\]\\]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 256) || "mention"
  );
}

/** Markdown carrier whose visible text is the readable mention name. */
export function formatHostExtensionMentionToken(
  mention: Omit<HostExtensionMentionToken, "label"> & { label: string },
): string {
  const label = displayMentionLabel(mention.label);
  const payload = hostExtensionMentionTokenSchema.parse({ ...mention, label });
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `[@${label}](${HOST_EXTENSION_MENTION_TOKEN_PREFIX}${encoded})`;
}

export function hasHostExtensionMentionToken(text: string): boolean {
  return text.includes("codexhost-extension://mention/");
}

/**
 * Parse every valid carrier and flag malformed mentions so the Host can reject
 * a Turn instead of forwarding a partial or raw token.
 */
export function parseHostExtensionMentions(text: string): HostExtensionMentionParseResult {
  const mentions: HostExtensionMentionReference[] = [];
  const links = [
    ...text.matchAll(
      /\[@[^\]\r\n]{1,256}\]\((codexhost-extension:\/\/mention\/[^)\s]{1,4096})\)/gu,
    ),
  ];
  for (const match of links) {
    const url = match[1];
    if (!url?.startsWith(HOST_EXTENSION_MENTION_TOKEN_PREFIX)) continue;
    try {
      const payload = hostExtensionMentionTokenSchema.parse(
        JSON.parse(
          new TextDecoder().decode(
            decodeBase64Url(url.slice(HOST_EXTENSION_MENTION_TOKEN_PREFIX.length)),
          ),
        ),
      );
      mentions.push({
        ...payload,
        start: match.index,
        end: match.index + match[0].length,
        raw: match[0],
      });
    } catch {
      // The prefix count below reports malformed payloads together with broken links.
    }
  }
  const prefixes = [...text.matchAll(HOST_EXTENSION_MENTION_TOKEN_PREFIX_PATTERN)].length;
  return { mentions, invalid: prefixes !== mentions.length };
}

/** Public static resources are data, never executable modules or active markup. */
export function hostExtensionStaticAssetMimeType(path: string): string | undefined {
  switch (/\.([^./]+)$/u.exec(path)?.[1]?.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "woff2":
      return "font/woff2";
    case "json":
      return "application/json";
    default:
      return undefined;
  }
}

export const hostExtensionManifestV2Schema = z
  .strictObject({
    manifestVersion: z.literal(2),
    id: hostExtensionIdSchema,
    name: localized(128, 1),
    version: z.string().trim().min(1).max(128),
    description: localized(4096),
    details: localized(16384).optional(),
    author: legacy.author,
    repository: legacy.repository,
    icon: legacy.icon.refine(
      (path) => path === undefined || hostExtensionResourcePathSchema.safeParse(path).success,
    ),
    screenshots: legacy.screenshots.refine(
      (paths) =>
        paths === undefined ||
        paths.every((path) => hostExtensionResourcePathSchema.safeParse(path).success),
    ),
    categories: legacy.categories,
    settingsSchema: legacy.settingsSchema,
    slots: legacy.slots.removeDefault().optional(),
    page: z
      .strictObject({
        apiVersion: z.literal(HOST_EXTENSION_PAGE_API_VERSION),
        entry: moduleEntry,
        style,
        title: localized(128, 1).optional(),
      })
      .optional(),
    widget: z
      .strictObject({
        apiVersion: z.literal(HOST_EXTENSION_PAGE_API_VERSION),
        entry: moduleEntry,
        style,
      })
      .optional(),
    desktop: z
      .strictObject({ apiVersion: z.literal(1), script: resourceWithSuffix(".js"), style })
      .optional(),
    web: z
      .strictObject({ apiVersion: z.literal(1), entry: moduleEntry.optional(), style })
      .refine(
        ({ entry, style }) => entry !== undefined || style !== undefined,
        "Expected a Web entry or style",
      )
      .optional(),
    backend: z.strictObject({ apiVersion: z.literal(1), entry: moduleEntry }).optional(),
    mentions: hostExtensionMentionManifestSchema.optional(),
  })
  .refine(
    ({ page, widget, desktop, web, backend, mentions }) =>
      Boolean(page || widget || desktop || web || backend || mentions),
    "Expected at least one page, widget, desktop, web, backend, or mentions declaration",
  )
  .refine(({ backend, mentions }) => !mentions || backend !== undefined, {
    path: ["mentions"],
    message: "Mention sources require a backend entry",
  })
  .refine(
    ({ web, mentions }) =>
      !mentions?.sources.some((source) => source.picker) || Boolean(web?.entry),
    {
      path: ["mentions"],
      message: "Mention pickers require a Web entry",
    },
  )
  .refine(
    ({ page, widget, web, backend }) =>
      !backend ||
      [page?.entry, widget?.entry, web?.entry].every(
        (entry) =>
          entry === undefined ||
          hostExtensionCanonicalPath(entry) !== hostExtensionCanonicalPath(backend.entry),
      ),
    { path: ["backend", "entry"], message: "A backend entry cannot also be a frontend entry" },
  );

export type HostExtensionManifestV2 = z.infer<typeof hostExtensionManifestV2Schema>;
/** Both on-disk versions are exposed to consumers in canonical v2 form. */
export type HostExtensionManifest = HostExtensionManifestV2;
export type HostExtensionLocalizedText = HostExtensionManifest["name"];
export type HostExtensionCategory = NonNullable<HostExtensionManifest["categories"]>[number];
export type HostExtensionSettingField = NonNullable<
  HostExtensionManifest["settingsSchema"]
>[number];
export type HostExtensionManifestResult =
  | { state: "valid"; manifest: HostExtensionManifest }
  | { state: "invalid" | "incompatible"; error: string };

function normalizeText(
  value: string | { en: string; "zh-CN"?: string | undefined },
): HostExtensionLocalizedText {
  return typeof value === "string"
    ? { en: value, "zh-CN": value }
    : { en: value.en, "zh-CN": value["zh-CN"] ?? value.en };
}

export function parseHostExtensionManifest(value: unknown): HostExtensionManifestResult {
  const header = z.object({ manifestVersion: z.int().positive() }).safeParse(value);
  if (!header.success) return { state: "invalid", error: z.prettifyError(header.error) };
  if (header.data.manifestVersion > 2)
    return {
      state: "incompatible",
      error: `Manifest version ${header.data.manifestVersion} requires a newer codexhost`,
    };
  if (header.data.manifestVersion === 1) {
    const legacy = parseDesktopExtensionManifest(value);
    if (legacy.state !== "valid") return legacy;
    const { desktopApi, name, description, details, desktop, backend, ...metadata } =
      legacy.manifest;
    value = {
      ...metadata,
      manifestVersion: 2,
      name: normalizeText(name),
      description: normalizeText(description ?? ""),
      ...(details ? { details: normalizeText(details) } : {}),
      ...(desktop ? { desktop: { apiVersion: desktopApi, ...desktop } } : {}),
      ...(backend ? { backend: { apiVersion: 1, entry: backend.script } } : {}),
    };
  }
  const manifest = hostExtensionManifestV2Schema.safeParse(value);
  return manifest.success
    ? { state: "valid", manifest: manifest.data }
    : { state: "invalid", error: z.prettifyError(manifest.error) };
}

type Entries = Pick<HostExtensionManifest, "page" | "widget" | "desktop" | "web" | "backend">;
export interface HostExtensionCapabilities {
  hasPage: boolean;
  hasWidget: boolean;
  hasDesktop: boolean;
  hasWeb: boolean;
  hasBackend: boolean;
}
export function hostExtensionCapabilities(manifest: Entries): HostExtensionCapabilities {
  return {
    hasPage: Boolean(manifest.page),
    hasWidget: Boolean(manifest.widget),
    hasDesktop: Boolean(manifest.desktop),
    hasWeb: Boolean(manifest.web),
    hasBackend: Boolean(manifest.backend),
  };
}
export function hostExtensionTargets(manifest: Entries): HostExtensionTarget[] {
  return targetsForCapabilities(hostExtensionCapabilities(manifest));
}
export function targetsForCapabilities({
  hasPage,
  hasWidget,
  hasDesktop,
  hasWeb,
  hasBackend,
}: HostExtensionCapabilities): HostExtensionTarget[] {
  if (hasPage || hasWidget || (hasBackend && !hasDesktop && !hasWeb)) return ["desktop", "web"];
  const targets: HostExtensionTarget[] = [];
  if (hasDesktop) targets.push("desktop");
  if (hasWeb) targets.push("web");
  return targets;
}

export const HOST_EXTENSION_PAGE_CSS_VARIABLES = {
  background: "--cx-page-bg",
  surface: "--cx-page-surface",
  text: "--cx-page-text",
  mutedText: "--cx-page-text-muted",
  border: "--cx-page-border",
  accent: "--cx-page-accent",
  danger: "--cx-page-danger",
  radius: "--cx-page-radius",
} as const;

export type HostExtensionPageColorScheme = "light" | "dark";
export interface HostExtensionPageApi {
  readonly id: string;
  readonly apiVersion: typeof HOST_EXTENSION_PAGE_API_VERSION;
  readonly hostTarget: HostExtensionTarget;
  readonly locale: string;
  onLocaleChange(listener: (locale: string) => void): () => void;
  readonly colorScheme: HostExtensionPageColorScheme;
  onColorSchemeChange(listener: (scheme: HostExtensionPageColorScheme) => void): () => void;
  readonly signal: AbortSignal;
  assets: { url(relativePath: string): Promise<string> };
  storage: {
    get(): Promise<JsonObject>;
    set(values: JsonObject): Promise<JsonObject>;
    onChange(listener: (values: JsonObject) => void): () => void;
  };
  backend: { invoke(method: string, params?: JsonValue): Promise<JsonValue> };
}
export interface HostExtensionPageModule {
  mount(
    root: HTMLElement,
    api: HostExtensionPageApi,
  ): ReturnType<DesktopExtensionDefinitionV1["activate"]>;
}

export const hostExtensionBackendMethodSchema = desktopExtensionBackendMethodSchema;
export const HOST_EXTENSION_ASSETS_PREFIX = "/api/extensions/assets/";
type AssetIdentity = { id: string; activationId: string; digest: string };
export function hostExtensionAssetBaseUrl({ id, activationId, digest }: AssetIdentity): string {
  return `${HOST_EXTENSION_ASSETS_PREFIX}${hostExtensionIdSchema.parse(id)}/${hostExtensionActivationIdSchema.parse(activationId)}/${hostExtensionDigestSchema.parse(digest)}/`;
}
export function hostExtensionAssetUrl({
  path,
  ...identity
}: AssetIdentity & { path: string }): string {
  const resource = hostExtensionResourcePathSchema.parse(path);
  return (
    hostExtensionAssetBaseUrl(identity) + resource.split("/").map(encodeURIComponent).join("/")
  );
}
