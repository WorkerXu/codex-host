import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalPageOpener } from "@codexhost/desktop-control";
import { discoverHarnessPlugins } from "@codexhost/harness-plugin-files";

import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { createLauncherUrlOpener } from "./launcher-url-opener.js";

export const HARNESS_PLUGIN_DIRECTORY_ENV = "CODEXHOST_PLUGIN_DIRECTORY";

/** The distribution owns the sibling plugins directory; never search a project cwd. */
export function installedHarnessPluginOptions(
  environment: NodeJS.ProcessEnv,
  managedRemoteHost = false,
  hostRuntimeUrl: string = import.meta.url,
): { pluginRoots: readonly string[]; pluginContext: HarnessPluginContext } {
  const opener = managedRemoteHost ? undefined : createLauncherUrlOpener(environment);
  const openLocalPage = managedRemoteHost ? undefined : createLocalPageOpener(environment);
  return {
    pluginRoots: [
      path.join(path.dirname(fileURLToPath(hostRuntimeUrl)), "plugins"),
      environment[HARNESS_PLUGIN_DIRECTORY_ENV] ??
        path.join(
          environment.CODEXHOST_DATA_DIR
            ? path.resolve(environment.CODEXHOST_DATA_DIR)
            : path.join(os.homedir(), ".codexhost"),
          "plugins",
        ),
    ],
    pluginContext: {
      environment,
      platform: process.platform,
      managedRemoteHost,
      ...(opener ? { openLocalUrl: (url: string) => opener(new URL(url)) } : {}),
      ...(openLocalPage ? { openLocalPage } : {}),
    },
  };
}

const installedIdsByRoots = new Map<string, Promise<ReadonlySet<string>>>();
/** Installed Harnesses change about monthly; read the plugin directory once per Host. */
export function installedHarnessIds(environment: NodeJS.ProcessEnv): Promise<ReadonlySet<string>> {
  const key = [
    environment[HARNESS_PLUGIN_DIRECTORY_ENV] ?? "",
    environment.CODEXHOST_DATA_DIR ?? environment.HOME ?? "",
  ].join("|");
  const cached = installedIdsByRoots.get(key);
  if (cached) return cached;
  const value = discoverHarnessPlugins(installedHarnessPluginOptions(environment).pluginRoots)
    .then((discovery) => discovery.enabledIds)
    .catch(() => new Set<string>());
  installedIdsByRoots.set(key, value);
  return value;
}
