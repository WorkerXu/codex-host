import {
  harnessPluginAvailabilitySchema,
  harnessPluginDescriptorSchema,
  type HarnessPluginAvailability,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

import { rendererNewThreadPreferenceStorage } from "./renderer-new-thread-preference.js";

const KEY = "codexhost.harness-directory.v1";
const MAX_PLUGINS = 32;
const MAX_ICON_CHARS = 64 * 1024;
const MAX_SERIALIZED_CHARS = 512 * 1024;

interface StoredArtwork {
  key: string;
  plugin: HarnessPluginDescriptor;
}

export interface CachedHarnessDirectory {
  /** Fingerprint from the Host's conditional `plugins/list`. */
  fingerprint: string | null;
  plugins: readonly HarnessPluginDescriptor[];
  availability: Record<string, HarnessPluginAvailability>;
  /** Local-only `webUi.open` capability learned from full inspections. */
  webUi: Record<string, boolean>;
}

const keyByPlugin = new WeakMap<HarnessPluginDescriptor, string>();

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Artwork identity: a plugin that changes its image or styling gets a new key. */
export function harnessArtworkKey(plugin: HarnessPluginDescriptor): string {
  const known = keyByPlugin.get(plugin);
  if (known) return known;
  const key = `${plugin.id}@${plugin.version}#${hashText(
    `${plugin.icon ?? ""}\u0000${JSON.stringify(plugin.iconStyle ?? null)}`,
  )}`;
  keyByPlugin.set(plugin, key);
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The last Harness directory a Host reported, per Host. It lets the sidebar and
 * the Composer name their Harness before the background conditional fetch lands.
 * Presentation only: no Session content and no DingTalk data.
 */
export function readCachedHarnessDirectory(hostId: string): CachedHarnessDirectory | undefined {
  try {
    const raw = rendererNewThreadPreferenceStorage(hostId)?.getItem(KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.plugins)) {
      return undefined;
    }
    const plugins: HarnessPluginDescriptor[] = [];
    for (const entry of parsed.plugins) {
      if (!isRecord(entry) || typeof entry.key !== "string") continue;
      const plugin = harnessPluginDescriptorSchema.safeParse(entry.plugin);
      if (!plugin.success || harnessArtworkKey(plugin.data) !== entry.key) continue;
      plugins.push(plugin.data);
    }
    if (plugins.length === 0) return undefined;
    const availability: Record<string, HarnessPluginAvailability> = {};
    if (isRecord(parsed.availability)) {
      for (const [id, status] of Object.entries(parsed.availability)) {
        const parsedStatus = harnessPluginAvailabilitySchema.safeParse(status);
        if (parsedStatus.success) availability[id] = parsedStatus.data;
      }
    }
    const webUi: Record<string, boolean> = {};
    if (isRecord(parsed.webUi)) {
      for (const [id, available] of Object.entries(parsed.webUi)) {
        if (available === true) webUi[id] = true;
      }
    }
    return {
      fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : null,
      plugins,
      availability,
      webUi,
    };
  } catch {
    return undefined;
  }
}

export function writeCachedHarnessDirectory(
  hostId: string,
  directory: CachedHarnessDirectory,
): void {
  try {
    const stored: StoredArtwork[] = [];
    const pluginIds = new Set<string>();
    let serialized = 0;
    for (const source of directory.plugins) {
      if (source.kind === "usage" || stored.length >= MAX_PLUGINS) continue;
      const plugin =
        source.icon !== undefined && source.icon.length > MAX_ICON_CHARS
          ? { ...source, icon: undefined }
          : source;
      // Key the stored shape, not the live descriptor: an oversized icon is dropped.
      const entry: StoredArtwork = { key: harnessArtworkKey(plugin), plugin };
      const size = JSON.stringify(entry).length;
      if (stored.length > 0 && serialized + size > MAX_SERIALIZED_CHARS) continue;
      stored.push(entry);
      pluginIds.add(plugin.id);
      serialized += size;
    }
    const availability = Object.fromEntries(
      Object.entries(directory.availability).filter(
        ([id, status]) =>
          pluginIds.has(id) && harnessPluginAvailabilitySchema.safeParse(status).success,
      ),
    );
    const webUi = Object.fromEntries(
      Object.entries(directory.webUi).filter(
        ([id, available]) => pluginIds.has(id) && available === true,
      ),
    );
    rendererNewThreadPreferenceStorage(hostId)?.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        fingerprint: directory.fingerprint,
        availability,
        webUi,
        plugins: stored,
      }),
    );
  } catch {
    /* Storage is a convenience; a missing cache only delays the directory. */
  }
}
