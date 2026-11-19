import {
  DESKTOP_PROJECTS_CATALOG_METHOD,
  desktopProjectsCatalogSchema,
  type DesktopProjectsCatalog,
} from "@codexhost/shared-contracts";

import type { RendererAgentPickerControl } from "./renderer-agent-picker.js";
import {
  loadCrossHostHarnessCatalog,
  type CrossHostHarnessCatalog,
} from "./renderer-cross-host-harness-catalog.js";
import {
  createCrossHostAgentSection,
  type CrossHostAgentSection,
  type CrossHostAgentSelection,
} from "./renderer-cross-host-agent-section.js";
import {
  chooseMirrorDestination,
  findNameOnlyLocalProject,
  mirrorDirectoryCandidates,
  readComposerProject,
  resolveMirrorSource,
  type MirrorProjectSource,
  type ProjectEligibilityReason,
} from "./renderer-project-mirror-model.js";
import { showProjectMirrorNotice } from "./renderer-project-mirror-notice.js";
import { joinMirroredProjectSection } from "./renderer-project-mirror-section.js";
import {
  createProjectMirrorRpc,
  localProjectMirrorManager,
  type ProjectMirrorRpc,
} from "./renderer-project-mirror-rpc.js";
import {
  loadProjectMirrorDesktopServices,
  type ProjectMirrorDesktopServices,
} from "./renderer-project-mirror-services.js";

type HostRoute = {
  manager: { sendRequest(method: string, params: unknown): Promise<unknown> };
};

type ProjectSource = "composer" | "catalog";

export interface ProjectMirrorContext {
  catalog: DesktopProjectsCatalog;
  source: MirrorProjectSource;
  revision: number;
}

type ProjectMirrorReason = "unknown" | "catalog-error" | ProjectEligibilityReason;

export interface ProjectMirrorStatus {
  pickerDetected: boolean;
  projectEligible: boolean;
  peersLoaded: number;
  lastError: string | null;
  projectSource: ProjectSource | null;
  projectReason: ProjectMirrorReason;
  machineCount: number;
}

interface PendingHarness {
  agentId: string;
  createdAt: number;
  attemptedAt?: number;
}

export interface RendererProjectMirrorApi {
  openForAgentPicker(input: { composer: Element; picker: RendererAgentPickerControl }): void;
  consumePending(input: {
    composer: Element;
    hostId: string;
    applyHarness(composer: Element, agentId: string): Promise<boolean>;
  }): boolean;
  status(): ProjectMirrorStatus;
  dispose(): void;
}

declare global {
  interface Window {
    __codexhostProjectMirrorV1?: RendererProjectMirrorApi;
  }
}

const PENDING_TTL_MS = 60_000;
const PENDING_RETRY_MS = 800;
const SIDEBAR_TIMEOUT_MS = 5_000;
const HARNESS_CATALOG_TTL_MS = 10_000;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localManager(): ReturnType<typeof localProjectMirrorManager> {
  return localProjectMirrorManager(window.__codexhostHostRoutingV1);
}

function hostRoute(hostId: string): HostRoute | null {
  return (window.__codexhostHostRoutingV1?.forHost(hostId) as HostRoute | null) ?? null;
}

interface ContextResult {
  context: ProjectMirrorContext | null;
  source: ProjectSource | null;
  reason: ProjectMirrorReason;
  error: string | null;
}

async function readContext(composer: Element): Promise<ContextResult> {
  const manager = localManager();
  if (!manager)
    return {
      context: null,
      source: null,
      reason: "catalog-error",
      error: "Host runtime is unavailable",
    };
  try {
    const [registry, catalogValue] = await Promise.all([
      createProjectMirrorRpc(manager).list(),
      manager.sendRequest(DESKTOP_PROJECTS_CATALOG_METHOD, {}),
    ]);
    const catalog = desktopProjectsCatalogSchema.parse(catalogValue);
    const composerProject = readComposerProject(composer);
    const selected = composerProject ?? catalog.selectedProject ?? null;
    const source: ProjectSource | null = composerProject ? "composer" : selected ? "catalog" : null;
    if (!selected) return { context: null, source, reason: "no-project", error: null };
    const resolved = resolveMirrorSource(catalog, selected);
    if (!resolved.source)
      return { context: null, source, reason: resolved.reason, error: resolved.error };
    return {
      context: { catalog, source: resolved.source, revision: registry.revision },
      source,
      reason: "eligible",
      error: null,
    };
  } catch (error) {
    return { context: null, source: null, reason: "catalog-error", error: errorMessage(error) };
  }
}

async function upsertRegistry(
  rpc: ProjectMirrorRpc,
  input: {
    sourceProjectId: string;
    record?: {
      hostId: string;
      remoteProjectId: string;
      remotePath: string;
      label: string;
      createdAt: string;
      updatedAt: string;
    } | null;
  },
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await rpc.list();
    try {
      await rpc.upsert({ revision: current.revision, ...input });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

let harnessCatalogCache: {
  key: string;
  at: number;
  value: Promise<CrossHostHarnessCatalog>;
} | null = null;

function loadHarnessCatalog(
  catalog: DesktopProjectsCatalog,
  sourceHostId: string,
): Promise<CrossHostHarnessCatalog> {
  const routing = window.__codexhostHostRoutingV1;
  const knownHostIds = routing?.knownHostIds?.() ?? [];
  const hostIds = [
    ...new Set([
      ...knownHostIds,
      ...catalog.codexManagedRemoteConnections.map(({ hostId }) => hostId),
      ...catalog.remoteProjects.map(({ hostId }) => hostId),
    ]),
  ].sort();
  const includeLocal = sourceHostId !== "local";
  const key = hostIds
    .map((hostId) => `${hostId}:${routing?.forHost(hostId) != null ? "1" : "0"}`)
    .concat(`local:${includeLocal ? "1" : "0"}`, `source:${sourceHostId}`)
    .join("|");
  if (
    harnessCatalogCache &&
    harnessCatalogCache.key === key &&
    Date.now() - harnessCatalogCache.at < HARNESS_CATALOG_TTL_MS
  )
    return harnessCatalogCache.value;
  const probe = window.__codexhostRendererBindingProbeV1;
  const value = loadCrossHostHarnessCatalog({
    connections: catalog.codexManagedRemoteConnections,
    knownHostIds,
    remoteProjectHostIds: catalog.remoteProjects.map(({ hostId }) => hostId),
    includeLocal,
    excludeHostIds: [sourceHostId],
    isOnline: (hostId) => routing?.forHost(hostId) != null,
    directory: (hostId) =>
      probe?.harnessDirectory(hostId) ?? {
        plugins: null,
        availability: {},
        error: "Renderer binding probe is unavailable",
      },
    refresh: async (hostId) => {
      if (!probe?.refreshHarnessDirectory) throw new Error("Renderer binding probe is unavailable");
      await probe.refreshHarnessDirectory(hostId);
    },
  });
  harnessCatalogCache = { key, at: Date.now(), value };
  value.catch(() => {
    if (harnessCatalogCache?.value === value) harnessCatalogCache = null;
  });
  return value;
}

async function listAppProjects(
  route: HostRoute,
): Promise<Array<{ id: string; name: string; roots: Array<{ path: string }> }>> {
  const projects: Array<{ id: string; name: string; roots: Array<{ path: string }> }> = [];
  let cursor: string | null = null;
  do {
    const response = await route.manager.sendRequest("project/list", {
      cursor,
      limit: 100,
    });
    const rows = record(response) && Array.isArray(response.data) ? response.data : [];
    for (const row of rows) {
      if (!record(row) || typeof row.id !== "string" || typeof row.name !== "string") continue;
      const roots = Array.isArray(row.roots)
        ? row.roots
            .filter(
              (root): root is { path: string } => record(root) && typeof root.path === "string",
            )
            .map((root) => ({ path: root.path }))
        : [];
      projects.push({ id: row.id, name: row.name, roots });
    }
    cursor =
      record(response) && typeof response.nextCursor === "string" ? response.nextCursor : null;
  } while (cursor);
  return projects;
}

type DirectoryState = "directory" | "missing" | "other";

async function directoryState(route: HostRoute, path: string): Promise<DirectoryState> {
  try {
    const metadata = await route.manager.sendRequest("fs/getMetadata", { path });
    return record(metadata) && metadata.isDirectory === true ? "directory" : "other";
  } catch (error) {
    return /No such file|os error 2|not found/iu.test(errorMessage(error)) ? "missing" : "other";
  }
}

function sidebarProjectRow(projectId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-app-action-sidebar-project-id="${CSS.escape(projectId)}"]`,
  );
}

async function waitForSidebarProject(projectId: string): Promise<HTMLElement | null> {
  const existing = sidebarProjectRow(projectId);
  if (existing) return existing;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, SIDEBAR_TIMEOUT_MS);
    const observer = new MutationObserver(() => {
      const row = sidebarProjectRow(projectId);
      if (!row) return;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve(row);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

function newChatButton(row: HTMLElement): HTMLButtonElement | null {
  const buttons = [
    ...row.querySelectorAll<HTMLButtonElement>(
      "button:not([aria-haspopup]):not([data-app-action-sidebar-select-project])",
    ),
  ];
  return buttons.length === 1 ? (buttons[0] ?? null) : null;
}

export function installRendererProjectMirror(): RendererProjectMirrorApi {
  const existing = window.__codexhostProjectMirrorV1;
  if (existing) return existing;

  const pending = new Map<string, PendingHarness>();
  const inFlight = new Set<string>();
  const status: ProjectMirrorStatus = {
    pickerDetected: false,
    projectEligible: false,
    peersLoaded: 0,
    lastError: null,
    projectSource: null,
    projectReason: "unknown",
    machineCount: 0,
  };
  let disposed = false;

  const runMirror = async (
    context: ProjectMirrorContext,
    selection: CrossHostAgentSelection,
    services: ProjectMirrorDesktopServices,
    rpc: ProjectMirrorRpc,
  ): Promise<{ ok: boolean; message: string | null }> => {
    const fail = (message: string): { ok: false; message: string } => {
      showProjectMirrorNotice(document, message, "error");
      return { ok: false, message };
    };
    const sourceId = context.source.id;
    if (inFlight.has(sourceId)) {
      return { ok: false, message: "正在添加这台机器，请稍候。" };
    }
    inFlight.add(sourceId);
    const hostId = selection.machine.hostId;
    const name = context.source.name.trim() || context.source.name;
    try {
      const route = hostRoute(hostId);
      if (!route) return fail(`${selection.machine.label} 当前离线`);
      const registry = await rpc.list();
      const known = registry.projects[sourceId];
      const now = new Date().toISOString();
      let projectId: string | null;
      let chosenPath: string;

      if (hostId === "local") {
        // The mirror runs the other way: Desktop creates `~/Documents/ChatGPT/<name>`
        // here, so the Mac reuses its own same-name project when it exists.
        const existing =
          (known?.hostId === "local"
            ? context.catalog.localProjects[known.remoteProjectId]
            : undefined) ??
          findNameOnlyLocalProject(
            Object.values(context.catalog.localProjects),
            name,
            context.catalog.defaultProjectParent,
          );
        if (existing) {
          projectId = existing.id;
          chosenPath = existing.rootPaths[0] ?? "";
        } else {
          const created = await services.projects.createLocal({
            appearance: null,
            initializeDefaultWorkspaceGitRepository: false,
            name,
            setActive: false,
            sources: [],
          });
          if (!created) return fail("创建本机项目被取消");
          projectId = created.projectId;
          chosenPath = created.rootPaths[0] ?? "";
        }
      } else {
        const { homeDirectory } = await services.executionPaths.readHomeDirectory(hostId);
        const parent = `${homeDirectory.replace(/\/+$/u, "")}/Documents/ChatGPT`;
        const remoteProjects = context.catalog.remoteProjects.filter(
          (project) => project.hostId === hostId,
        );
        const appProjects = await listAppProjects(route).catch(() => []);
        const destination = await chooseMirrorDestination({
          name,
          hostId,
          candidates: mirrorDirectoryCandidates(parent, name),
          known:
            known && known.hostId === hostId
              ? {
                  hostId: known.hostId,
                  remotePath: known.remotePath,
                  remoteProjectId: known.remoteProjectId,
                }
              : null,
          desktopProjects: remoteProjects,
          appProjects,
          directoryState: (path) => directoryState(route, path),
        });
        if (!destination) return fail("找不到可用的远程目录名");
        chosenPath = destination.path;
        projectId = destination.projectId;

        if (!projectId) {
          if ((await directoryState(route, chosenPath)) === "missing") {
            await services.workspaceFiles.createDirectory({ hostId, path: chosenPath });
            if ((await directoryState(route, chosenPath)) !== "directory") {
              return fail("远程目录创建失败");
            }
          }
          const created = await services.projects.createRemote({
            appearance: null,
            hostId,
            label: name,
            remotePath: chosenPath,
            reuseExisting: true,
          });
          if (!created) return fail("创建远程项目被取消");
          projectId = created.id;
        }

        if (!projectId) return fail("创建远程项目失败");
        const appProject = appProjects.find((project) =>
          project.roots.some((root) => root.path === chosenPath),
        );
        if (!appProject) {
          void route.manager
            .sendRequest("project/create", {
              name,
              roots: [{ path: chosenPath }],
              metadata: {},
              idempotencyKey: projectId,
            })
            .catch((error: unknown) =>
              console.warn("codexhost project mirror: project/create failed", error),
            );
        }
      }

      if (!projectId || !chosenPath) return fail("创建项目失败，请稍后重试");
      await upsertRegistry(rpc, {
        sourceProjectId: sourceId,
        record: {
          hostId,
          remoteProjectId: projectId,
          remotePath: chosenPath,
          label: name,
          createdAt: known?.createdAt ?? now,
          updatedAt: now,
        },
      });

      try {
        await joinMirroredProjectSection({
          services,
          sourceProjectId: sourceId,
          remoteProjectId: projectId,
          projectName: name,
          targetHostId: hostId,
        });
      } catch (error) {
        // The remote conversation is still usable; only the shared section failed.
        status.lastError = errorMessage(error);
        showProjectMirrorNotice(document, "项目已创建，但未能自动加入同一分区", "error");
      }

      const row = await waitForSidebarProject(projectId);
      if (!row) return fail("项目已创建，但侧栏尚未显示，请稍后手动打开");
      const button = newChatButton(row);
      if (!button || button.disabled) return fail("该项目当前不可用，可能已离线");
      pending.set(hostId, { agentId: selection.harness.id, createdAt: Date.now() });
      button.click();
    } catch (error) {
      status.lastError = errorMessage(error);
      return { ok: false, message: "添加机器失败，请稍后重试。" };
    } finally {
      inFlight.delete(sourceId);
    }
    return { ok: true, message: null };
  };
  const openForAgentPicker: RendererProjectMirrorApi["openForAgentPicker"] = (input) => {
    if (disposed) return;
    status.pickerDetected = true;
    status.lastError = null;
    void (async () => {
      const result = await readContext(input.composer);
      if (disposed) return;
      status.projectEligible = result.context !== null;
      status.projectSource = result.source;
      status.projectReason = result.reason;
      if (result.error) status.lastError = result.error;
      const menu = input.picker.menu;
      const context = result.context;
      if (!context || !menu.isConnected) {
        menu.querySelector("[data-codexhost-cross-host-agent-menu]")?.remove();
        return;
      }
      const manager = localManager();
      if (!manager) {
        status.lastError = "Host runtime is unavailable";
        return;
      }
      const rpc = createProjectMirrorRpc(manager);
      menu.querySelector("[data-codexhost-cross-host-agent-menu]")?.remove();
      let services: ProjectMirrorDesktopServices | null = null;
      const section: CrossHostAgentSection = createCrossHostAgentSection({
        document,
        catalog: { machines: [], loadedPeers: 0 },
        loading: true,
        onClose: () => input.picker.close(),
        onSelect: (selection) => {
          if (!services) {
            showProjectMirrorNotice(document, "Desktop 项目服务尚未就绪，请稍后重试", "error");
            return;
          }
          input.picker.close();
          void runMirror(context, selection, services, rpc);
        },
      });
      menu.append(section.element);
      try {
        const [loadedServices, catalog] = await Promise.all([
          loadProjectMirrorDesktopServices(window),
          loadHarnessCatalog(context.catalog, context.source.hostId),
        ]);
        if (disposed || !section.element.isConnected) return;
        services = loadedServices;
        if (!services) {
          status.lastError = "Desktop project services are unavailable";
          section.refresh(
            { machines: [], loadedPeers: 0 },
            { loading: false, error: "Desktop 项目服务不可用" },
          );
          return;
        }
        status.peersLoaded = catalog.loadedPeers;
        status.machineCount = catalog.machines.length;
        section.refresh(catalog, { loading: false, error: null });
      } catch (error) {
        if (disposed || !section.element.isConnected) return;
        status.lastError = errorMessage(error);
        section.refresh(
          { machines: [], loadedPeers: 0 },
          { loading: false, error: `其他机器不可用：${errorMessage(error)}` },
        );
      }
    })().catch((error: unknown) => {
      if (disposed) return;
      status.lastError = errorMessage(error);
    });
  };

  const api: RendererProjectMirrorApi = {
    openForAgentPicker,
    consumePending(input) {
      if (disposed) return false;
      const entry = pending.get(input.hostId);
      if (!entry) return false;
      if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
        pending.delete(input.hostId);
        return false;
      }
      if (entry.agentId === "codex") {
        pending.delete(input.hostId);
        return true;
      }
      if (entry.attemptedAt && Date.now() - entry.attemptedAt < PENDING_RETRY_MS) return false;
      entry.attemptedAt = Date.now();
      void input
        .applyHarness(input.composer, entry.agentId)
        .then((applied) => {
          if (applied && pending.get(input.hostId) === entry) pending.delete(input.hostId);
        })
        .catch((error: unknown) => {
          status.lastError = errorMessage(error);
        });
      return true;
    },
    status() {
      return { ...status };
    },
    dispose() {
      disposed = true;
      pending.clear();
      delete window.__codexhostProjectMirrorV1;
    },
  };
  Object.defineProperty(window, "__codexhostProjectMirrorV1", {
    configurable: true,
    value: api,
  });
  return api;
}
