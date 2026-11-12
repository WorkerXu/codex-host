import { stat } from "node:fs/promises";
import path from "node:path";

import { discoverHarnessPlugins } from "@codexhost/harness-plugin-files";

/**
 * Version + directory/file timestamp signature per installed plugin. Availability
 * entries are discarded when this changes, so install/remove/upgrade cannot
 * keep a stale `ready` or `notInstalled` result.
 */
export async function harnessPluginFingerprints(
  roots: readonly string[],
): Promise<Map<string, string>> {
  if (roots.length === 0) return new Map();
  const discovery = await discoverHarnessPlugins(roots);
  const fingerprints = new Map<string, string>();
  await Promise.all(
    discovery.plugins.map(async ({ root, manifest }) => {
      const [directory, manifestFile] = await Promise.all([
        stat(root).catch(() => undefined),
        stat(path.join(root, "manifest.json")).catch(() => undefined),
      ]);
      fingerprints.set(
        manifest.id,
        [
          manifest.version,
          directory?.mtimeMs ?? 0,
          directory?.size ?? 0,
          manifestFile?.mtimeMs ?? 0,
          manifestFile?.size ?? 0,
        ].join(":"),
      );
    }),
  );
  return fingerprints;
}
