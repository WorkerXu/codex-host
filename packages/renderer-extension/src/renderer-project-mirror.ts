import {
  DESKTOP_PROJECTS_CATALOG_METHOD,
  desktopProjectsCatalogSchema,
  type DesktopLocalProject,
  type DesktopProjectsCatalog,
  type ProjectGroupMember,
} from "@codexhost/shared-contracts";

import {
  loadCrossHostModelCatalog,
  type CrossHostModelCatalog,
} from "./renderer-cross-host-model-catalog.js";
import { observeNativeModelMenu } from "./renderer-cross-host-model-menu.js";
import {
  createCrossHostModelSection,
  type CrossHostModelSection,
} from "./renderer-cross-host-model-section.js";
import {
  chooseMirrorDestination,
  effectiveModelId,
  isNameOnlyProject,
  mirrorDirectoryCandidates,
  planMirrorGroup,
} from "./renderer-project-mirror-model.js";
import { confirmProjectMirror, showProjectMirrorNotice } from "./renderer-project-mirror-notice.js";
import {
  createProjectGroupRpc,
  createProjectMirrorRpc,
  localProjectMirrorManager,
  type ProjectGroupRpc,
  type ProjectMirrorRpc,
} from "./renderer-project-mirror-rpc.js";
import {
  loadProjectMirrorDesktopServices,
  type ProjectMirrorDesktopServices,
} from "./renderer-project-mirror-services.js";
import type { CrossHostMenuSelection } from "./renderer-cross-host-model-menu.js";

type HostRoute = {
  manager: { sendRequest(method: string, params: unknown): Promise<unknown> };
};

export interface ProjectMirrorContext {
  catalog: DesktopProjectsCatalog;
  source: DesktopLocalProject;
  acknowledged: boolean;
  revision: number;
}

export interface ProjectMirrorPendingSelection {
  modelId: string;
  reasoningEffort: string | null;
  createdAt: number;
}

export interface RendererProjectMirrorApi {
  prepare(composer: Element): void;
  openFor(input: {
    composer: Element;
    trigger: HTMLElement;
    agent: string;
    newThread: boolean;
  }): void;
  consumePending(input: {
    composer: Element;
    hostId: string;
    applyModel(composer: Element, modelId: string, reasoningEffort: string | null): boolean;
  }): boolean;
  dispose(): void;
}

declare global {
  interface Window {
    __codexhostProjectMirrorV1?: RendererProjectMirrorApi;
  }
}

const CONTEXT_TTL_MS = 2_000;
const PENDING_TTL_MS = 60_000;
const PENDING_RETRY_MS = 400;
const SIDEBAR_TIMEOUT_MS = 5_000;

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

async function readContext(): Promise<ProjectMirrorContext | null> {
  const manager = localManager();
  if (!manager) return null;
  try {
    const [registry, catalogValue] = await Promise.all([
      createProjectMirrorRpc(manager).list(),
      manager.sendRequest(DESKTOP_PROJECTS_CATALOG_METHOD, {}),
    ]);
    const catalog = desktopProjectsCatalogSchema.parse(catalogValue);
    const selected = catalog.selectedProject;
    if (!selected || selected.type !== "local") return null;
    const source = catalog.localProjects[selected.projectId];
    if (!source) return null;
    if (!isNameOnlyProject(source, catalog.defaultProjectParent)) return null;
    return {
      catalog,
      source,
      acknowledged: registry.acknowledged.includes(source.id),
      revision: registry.revision,
    };
  } catch {
    return null;
  }
}

async function upsertRegistry(
  rpc: ProjectMirrorRpc,
  input: {
    sourceProjectId: string;
    acknowledge?: true;
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

let crossHostCache: { key: string; at: number; value: Promise<CrossHostModelCatalog> } | null =
  null;

function loadCrossHostCatalog(catalog: DesktopProjectsCatalog): Promise<CrossHostModelCatalog> {
  const routing = window.__codexhostHostRoutingV1;
  const hostIds = (routing?.knownHostIds?.() ?? []).filter(
    (hostId) => hostId !== "local" && hostId !== "durable" && hostId.includes(":"),
  );
  const key = `${hostIds.join("|")}\u0000${catalog.codexManagedRemoteConnections.length}`;
  if (crossHostCache && crossHostCache.key === key && Date.now() - crossHostCache.at < 15_000)
    return crossHostCache.value;
  const value = loadCrossHostModelCatalog({
    hostIds,
    connections: catalog.codexManagedRemoteConnections,
    isOnline: (hostId) => routing?.forHost(hostId) != null,
    request: async (hostId, method, params) => {
      const route = hostRoute(hostId);
      if (!route) throw new Error("Host is offline");
      return route.manager.sendRequest(method, params);
    },
  });
  crossHostCache = { key, at: Date.now(), value };
  value.catch(() => {
    if (crossHostCache?.value === value) crossHostCache = null;
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

function sourceMember(source: DesktopLocalProject): ProjectGroupMember {
  return {
    projectKind: "local",
    projectId: source.id,
    rootPaths: [...source.rootPaths],
    label: source.name,
  };
}

function mirrorMember(input: {
  projectId: string;
  hostId: string;
  remotePath: string;
  label: string;
}): ProjectGroupMember {
  return {
    projectKind: "remote",
    projectId: input.projectId,
    hostId: input.hostId,
    remotePath: input.remotePath,
    label: input.label,
  };
}

async function joinMirrorGroup(
  groups: ProjectGroupRpc,
  input: {
    source: DesktopLocalProject;
    mirror: { projectId: string; hostId: string; remotePath: string; label: string };
  },
): Promise<"joined" | "skipped"> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await groups.list();
    const plan = planMirrorGroup({
      groups: current.groups,
      name: input.source.name,
      source: sourceMember(input.source),
      mirror: mirrorMember(input.mirror),
      createId: () => crypto.randomUUID(),
      now: new Date().toISOString(),
    });
    if (plan.action === "skipped-other-group") return "skipped";
    if (!plan.changed) return "joined";
    try {
      await groups.replace({ revision: current.revision, groups: plan.groups });
      return "joined";
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  return "joined";
}

export function installRendererProjectMirror(): RendererProjectMirrorApi {
  const existing = window.__codexhostProjectMirrorV1;
  if (existing) return existing;

  const contexts = new WeakMap<Element, { value: ProjectMirrorContext | null; at: number }>();
  const pending = new Map<string, ProjectMirrorPendingSelection & { attemptedAt?: number }>();
  const inFlight = new Set<string>();
  const announcedConflicts = new Set<string>();
  let disposed = false;

  const prepare = (composer: Element): void => {
    const cached = contexts.get(composer);
    if (cached && Date.now() - cached.at < CONTEXT_TTL_MS) return;
    contexts.set(composer, { value: null, at: Date.now() });
    void readContext().then((value) => {
      if (!disposed) contexts.set(composer, { value, at: Date.now() });
    });
  };

  const contextFor = async (composer: Element): Promise<ProjectMirrorContext | null> => {
    const cached = contexts.get(composer);
    // A null snapshot may predate the project selection that opened this
    // Composer; never let it hide the entry for the whole TTL.
    if (cached?.value && Date.now() - cached.at < CONTEXT_TTL_MS) return cached.value;
    const value = await readContext();
    if (!disposed) contexts.set(composer, { value, at: Date.now() });
    return value;
  };

  const acknowledge = async (
    section: CrossHostModelSection,
    context: ProjectMirrorContext,
    catalog: CrossHostModelCatalog,
    rpc: ProjectMirrorRpc,
  ): Promise<void> => {
    if (!(await confirmProjectMirror(document, context.source.name))) return;
    try {
      await upsertRegistry(rpc, { sourceProjectId: context.source.id, acknowledge: true });
      context.acknowledged = true;
      section.refresh(catalog, true);
    } catch (error) {
      showProjectMirrorNotice(document, `启用跨机对话失败：${errorMessage(error)}`, "error");
    }
  };

  const runMirror = async (
    context: ProjectMirrorContext,
    selection: CrossHostMenuSelection,
    services: ProjectMirrorDesktopServices,
    rpc: ProjectMirrorRpc,
  ): Promise<void> => {
    const sourceId = context.source.id;
    if (inFlight.has(sourceId)) return;
    inFlight.add(sourceId);
    const hostId = selection.machine.hostId;
    const name = context.source.name.trim() || context.source.name;
    try {
      const route = hostRoute(hostId);
      if (!route) {
        showProjectMirrorNotice(document, `${selection.machine.label} 当前离线`, "error");
        return;
      }
      const { homeDirectory } = await services.readHomeDirectory(hostId);
      const parent = `${homeDirectory.replace(/\/+$/u, "")}/Documents/ChatGPT`;
      const remoteProjects = context.catalog.remoteProjects.filter(
        (project) => project.hostId === hostId,
      );
      const appProjects = await listAppProjects(route).catch(() => []);
      const registry = await rpc.list();
      const known = registry.projects[sourceId];

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
      if (!destination) {
        showProjectMirrorNotice(document, "找不到可用的远程目录名", "error");
        return;
      }
      const chosenPath = destination.path;
      let existingProjectId = destination.projectId;

      if (!existingProjectId) {
        if ((await directoryState(route, chosenPath)) === "missing") {
          await services.createDirectory({ hostId, path: chosenPath });
          if ((await directoryState(route, chosenPath)) !== "directory") {
            showProjectMirrorNotice(document, "远程目录创建失败", "error");
            return;
          }
        }
        const created = await services.createRemote({
          appearance: null,
          hostId,
          label: name,
          remotePath: chosenPath,
          reuseExisting: true,
        });
        if (!created) {
          showProjectMirrorNotice(document, "创建远程项目被取消", "error");
          return;
        }
        existingProjectId = created.id;
      }

      const projectId = existingProjectId;
      if (!projectId) {
        showProjectMirrorNotice(document, "创建远程项目失败", "error");
        return;
      }
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

      const now = new Date().toISOString();
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

      const row = await waitForSidebarProject(projectId);
      if (!row) {
        showProjectMirrorNotice(document, "项目已创建，但侧栏尚未显示；请稍后手动打开", "error");
        return;
      }
      const button = newChatButton(row);
      if (!button || button.disabled) {
        showProjectMirrorNotice(document, "该项目当前不可用（可能离线）", "error");
        return;
      }
      pending.set(hostId, {
        modelId: effectiveModelId(
          selection.providerId,
          selection.model.id,
          selection.machine.defaultProviderId,
        ),
        reasoningEffort: selection.model.defaultReasoningEffort,
        createdAt: Date.now(),
      });
      button.click();

      const manager = localManager();
      if (manager) {
        try {
          const result = await joinMirrorGroup(createProjectGroupRpc(manager), {
            source: context.source,
            mirror: {
              projectId,
              hostId,
              remotePath: chosenPath,
              label: name,
            },
          });
          if (result === "skipped") {
            const key = `${sourceId}\u0000${hostId}\u0000${existingProjectId}`;
            if (!announcedConflicts.has(key)) {
              announcedConflicts.add(key);
              showProjectMirrorNotice(document, "该项目已在其他项目组，已跳过自动分组");
            }
          }
        } catch (error) {
          showProjectMirrorNotice(
            document,
            `项目已创建，但自动分组失败：${errorMessage(error)}`,
            "error",
          );
        }
      }
    } catch (error) {
      showProjectMirrorNotice(document, `跨机对话创建失败：${errorMessage(error)}`, "error");
    } finally {
      inFlight.delete(sourceId);
    }
  };

  const attachSection = (input: {
    composer: Element;
    menu: HTMLElement;
    trigger: HTMLElement;
    context: ProjectMirrorContext;
    catalog: CrossHostModelCatalog;
    services: ProjectMirrorDesktopServices;
    rpc: ProjectMirrorRpc;
  }): void => {
    input.menu.querySelector("[data-codexhost-cross-host-model-menu]")?.remove();
    let section: CrossHostModelSection | null = null;
    section = createCrossHostModelSection({
      document,
      catalog: input.catalog,
      acknowledged: input.context.acknowledged,
      onAcknowledge: () => {
        if (section) void acknowledge(section, input.context, input.catalog, input.rpc);
      },
      onClose: () => {
        input.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      },
      onSelect: (selection) => {
        void runMirror(input.context, selection, input.services, input.rpc);
      },
    });
    input.menu.append(section.element);
    const observer = new MutationObserver(() => {
      if (!input.menu.isConnected) {
        observer.disconnect();
        section?.dispose();
        return;
      }
      if (section && !section.element.isConnected) input.menu.append(section.element);
    });
    observer.observe(input.menu, { childList: true });
  };

  const openFor: RendererProjectMirrorApi["openFor"] = (input) => {
    if (disposed || input.agent !== "codex" || !input.newThread) return;
    void (async () => {
      const context = await contextFor(input.composer);
      if (!context) return;
      const [services, catalog] = await Promise.all([
        loadProjectMirrorDesktopServices(window),
        loadCrossHostCatalog(context.catalog),
      ]);
      if (!services) return;
      const manager = localManager();
      if (!manager) return;
      const rpc = createProjectMirrorRpc(manager);
      observeNativeModelMenu({
        document,
        window,
        trigger: input.trigger,
        timeoutMs: 2_000,
        onOpen(menu) {
          attachSection({
            composer: input.composer,
            menu,
            trigger: input.trigger,
            context,
            catalog,
            services,
            rpc,
          });
        },
      });
    })();
  };

  const api: RendererProjectMirrorApi = {
    prepare,
    openFor,
    consumePending(input) {
      if (disposed) return false;
      const entry = pending.get(input.hostId);
      if (!entry) return false;
      if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
        pending.delete(input.hostId);
        return false;
      }
      if (entry.attemptedAt && Date.now() - entry.attemptedAt < PENDING_RETRY_MS) return false;
      entry.attemptedAt = Date.now();
      const applied = input.applyModel(input.composer, entry.modelId, entry.reasoningEffort);
      if (applied) pending.delete(input.hostId);
      return applied;
    },
    dispose() {
      disposed = true;
      delete window.__codexhostProjectMirrorV1;
    },
  };
  Object.defineProperty(window, "__codexhostProjectMirrorV1", {
    configurable: true,
    value: api,
  });
  return api;
}
