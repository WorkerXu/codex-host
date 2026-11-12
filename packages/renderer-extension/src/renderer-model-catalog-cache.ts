import { harnessModelCatalogSchema, type HarnessModelCatalog } from "@codexhost/shared-contracts";

import { rendererNewThreadPreferenceStorage } from "./renderer-new-thread-preference.js";

const KEY_PREFIX = "codexhost.model-catalog.v1.";

/**
 * The last Model Catalog a Host reported for a Harness, kept only so a reopened Thread can name
 * its Model before the Host answers after a Desktop restart or reconnect. It is presentation
 * only: the Composer stays in its loading state and the fresh inspection replaces it.
 */
export function readCachedModelCatalog(
  hostId: string,
  agent: string,
): HarnessModelCatalog | undefined {
  try {
    const raw = rendererNewThreadPreferenceStorage(hostId)?.getItem(KEY_PREFIX + agent);
    if (!raw) return undefined;
    const parsed = harnessModelCatalogSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeCachedModelCatalog(
  hostId: string,
  agent: string,
  catalog: HarnessModelCatalog,
): void {
  try {
    rendererNewThreadPreferenceStorage(hostId)?.setItem(
      KEY_PREFIX + agent,
      JSON.stringify(catalog),
    );
  } catch {
    /* Storage is a convenience; a missing cache only shows the loading label. */
  }
}
