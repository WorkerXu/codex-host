import {
  harnessPluginDescriptorSchema,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

import { rendererNewThreadPreferenceStorage } from "./renderer-new-thread-preference.js";

const KEY = "codexhost.harness-artwork.v1";
const MAX_PLUGINS = 32;
const MAX_ICON_CHARS = 64 * 1024;
const MAX_SERIALIZED_CHARS = 512 * 1024;

interface StoredArtwork {
  key: string;
  plugin: HarnessPluginDescriptor;
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

/** Per Host, so artwork discovered on one machine is never shown for another. */
export function readCachedHarnessArtwork(hostId: string): HarnessPluginDescriptor[] {
  try {
    const raw = rendererNewThreadPreferenceStorage(hostId)?.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.plugins)) return [];
    const plugins: HarnessPluginDescriptor[] = [];
    for (const entry of parsed.plugins) {
      if (!isRecord(entry) || typeof entry.key !== "string") continue;
      const plugin = harnessPluginDescriptorSchema.safeParse(entry.plugin);
      if (!plugin.success || harnessArtworkKey(plugin.data) !== entry.key) continue;
      plugins.push(plugin.data);
    }
    return plugins;
  } catch {
    return [];
  }
}

export function writeCachedHarnessArtwork(
  hostId: string,
  plugins: readonly HarnessPluginDescriptor[],
): void {
  try {
    const stored: StoredArtwork[] = [];
    let serialized = 0;
    for (const source of plugins) {
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
      serialized += size;
    }
    rendererNewThreadPreferenceStorage(hostId)?.setItem(
      KEY,
      JSON.stringify({ version: 1, plugins: stored }),
    );
  } catch {
    /* Storage is a convenience; a missing cache only delays artwork. */
  }
}
