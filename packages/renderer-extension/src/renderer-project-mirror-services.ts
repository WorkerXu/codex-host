import { loadCodexNativeServices } from "./codex-native-services.js";

const RPC_MODULE = /\/rpc-[^/]+\.js$/u;

export interface DesktopRemoteProjectResult {
  id: string;
  hostId: string;
  remotePath: string;
  label: string;
}

/**
 * Subset of Desktop's renderer `appServices`. The methods stay on their real
 * nested service objects; the mirror calls `projects.createRemote`,
 * `workspaceFiles.createDirectory`, and `executionPaths.readHomeDirectory`.
 */
export interface ProjectMirrorDesktopServices {
  projects: {
    createRemote(input: {
      appearance: null;
      hostId: string;
      label: string;
      remotePath: string;
      reuseExisting?: boolean;
    }): Promise<DesktopRemoteProjectResult | null>;
  };
  workspaceFiles: {
    createDirectory(input: { hostId: string; path: string }): Promise<unknown>;
  };
  executionPaths: {
    readHomeDirectory(hostId: string): Promise<{ homeDirectory: string }>;
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isServices(value: unknown): value is ProjectMirrorDesktopServices {
  if (!record(value)) return false;
  try {
    const projects = value.projects as { createRemote?: unknown } | undefined;
    const workspaceFiles = value.workspaceFiles as { createDirectory?: unknown } | undefined;
    const executionPaths = value.executionPaths as { readHomeDirectory?: unknown } | undefined;
    return (
      typeof projects?.createRemote === "function" &&
      typeof workspaceFiles?.createDirectory === "function" &&
      typeof executionPaths?.readHomeDirectory === "function"
    );
  } catch {
    return false;
  }
}

function loadedModuleUrls(ownerWindow: Window): string[] {
  const catalog: unknown = Reflect.get(ownerWindow, "__codexhostLoadedModulesV1");
  if (record(catalog) && catalog.complete === true && Array.isArray(catalog.urls))
    return catalog.urls.filter((url): url is string => typeof url === "string");
  return [...ownerWindow.document.querySelectorAll('link[rel="modulepreload"][href]')]
    .map((link) => link.getAttribute("href"))
    .filter((href): href is string => typeof href === "string");
}

/**
 * Desktop publishes its renderer services as a live export of the `rpc` chunk.
 * The hash changes between releases, so resolve the module from the loaded
 * module catalog instead of hardcoding a filename.
 */
export async function loadProjectMirrorDesktopServices(
  ownerWindow: Window,
  importModule: (url: string) => Promise<Record<string, unknown>> = (url) => import(url),
): Promise<ProjectMirrorDesktopServices | null> {
  if (!ownerWindow.document || !ownerWindow.location) return null;
  const page = new URL(ownerWindow.location.href);
  const candidates = loadedModuleUrls(ownerWindow).filter((source) => {
    try {
      const url = new URL(source, page);
      return (
        url.protocol === page.protocol && url.host === page.host && RPC_MODULE.test(url.pathname)
      );
    } catch {
      return false;
    }
  });
  for (const source of candidates) {
    let module: Record<string, unknown>;
    try {
      module = await importModule(new URL(source, page).href);
    } catch {
      continue;
    }
    if (isServices(module.appServices)) return module.appServices;
  }
  // A future Desktop may split `rpc` into a different chunk name. The generic
  // scanner only reads already-instantiated exports and never executes lazily
  // loaded modules.
  try {
    return await loadCodexNativeServices(ownerWindow, isServices, importModule);
  } catch {
    return null;
  }
}
