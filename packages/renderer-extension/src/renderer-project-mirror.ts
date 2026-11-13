import {
  DESKTOP_PROJECTS_CATALOG_METHOD,
  desktopProjectsCatalogSchema,
  type DesktopLocalProject,
  type DesktopProjectsCatalog,
  type ProjectGroupMember,
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
  appendMirrorToGroup,
  chooseMirrorDestination,
  isNameOnlyProject,
  mirrorDirectoryCandidates,
  planMirrorGroup,
  readComposerProject,
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

type HostRoute = {
  manager: { sendRequest(method: string, params: unknown): Promise<unknown> };
};

type ProjectSource = "composer" | "catalog";

type ProjectEligibilityReason =
  | "unknown"
  | "eligible"
  | "no-project"
  | "remote-project"
  | "missing-project"
  | "not-name-only"
  | "catalog-error";

export interface ProjectMirrorContext {
  catalog: DesktopProjectsCatalog;
  source: DesktopLocalProject;
  acknowledged: boolean;
  revision: number;
}

export interface ProjectMirrorStatus {
  pickerDetected: boolean;
  projectEligible: boolean;
  peersLoaded: number;
  lastError: string | null;
  projectSource: ProjectSource | null;
  projectReason: ProjectEligibilityReason;
  machineCount: number;
}

interface PendingHarness {
  agentId: string;
  createdAt: number;
  attemptedAt?: number;
}

export interface RendererProjectMirrorApi {
  openForAgentPicker(input: { composer: Element; picker: RendererAgentPickerControl }): void;
  /** Ready peers and Harnesses for the project-group add-machine section. */
  machineCatalog(): Promise<CrossHostHarnessCatalog>;
  /** Creates the mirror and appends it to an existing group. */
  addToGroup(input: {
    groupId: string;
    hostId: string;
    harnessId: string;
    machineLabel: string;
    harnessLabel: string;
  }): Promise<boolean>;
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
  reason: ProjectEligibilityReason;
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
    if (selected.type !== "local")
      return { context: null, source, reason: "remote-project", error: null };
    const project = catalog.localProjects[selected.projectId];
    if (!project)
      return {
        context: null,
        source,
        reason: "missing-project",
        error: `Project ${selected.projectId} is missing from the Desktop catalog`,
      };
    if (!isNameOnlyProject(project, catalog.defaultProjectParent))
      return { context: null, source, reason: "not-name-only", error: null };
    return {
      context: {
        catalog,
        source: project,
        acknowledged: registry.acknowledged.includes(project.id),
        revision: registry.revision,
      },
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

let harnessCatalogCache: {
  key: string;
  at: number;
  value: Promise<CrossHostHarnessCatalog>;
} | null = null;

function loadHarnessCatalog(catalog: DesktopProjectsCatalog): Promise<CrossHostHarnessCatalog> {
  const routing = window.__codexhostHostRoutingV1;
  const knownHostIds = routing?.knownHostIds?.() ?? [];
  const hostIds = [
    ...new Set([
      ...knownHostIds,
      ...catalog.codexManagedRemoteConnections.map(({ hostId }) => hostId),
      ...catalog.remoteProjects.map(({ hostId }) => hostId),
    ]),
  ].sort();
  const key = hostIds
    .map((hostId) => `${hostId}:${routing?.forHost(hostId) != null ? "1" : "0"}`)
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

async function appendGroupMirror(
  groups: ProjectGroupRpc,
  input: {
    groupId: string;
    mirror: { projectId: string; hostId: string; remotePath: string; label: string };
  },
): Promise<"appended" | "already-member" | "conflict" | "missing-group"> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await groups.list();
    const plan = appendMirrorToGroup({
      groups: current.groups,
      groupId: input.groupId,
      mirror: mirrorMember(input.mirror),
      now: new Date().toISOString(),
    });
    if (plan.action !== "appended") return plan.action;
    if (!plan.changed) return "already-member";
    try {
      await groups.replace({ revision: current.revision, groups: plan.groups });
      return "appended";
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  return "appended";
}

export function installRendererProjectMirror(): RendererProjectMirrorApi {
  const existing = window.__codexhostProjectMirrorV1;
  if (existing) return existing;

  const pending = new Map<string, PendingHarness>();
  const inFlight = new Set<string>();
  const announcedConflicts = new Set<string>();
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

  const acknowledge = async (
    context: ProjectMirrorContext,
    rpc: ProjectMirrorRpc,
  ): Promise<void> => {
    if (!(await confirmProjectMirror(document, context.source.name))) return;
    try {
      await upsertRegistry(rpc, { sourceProjectId: context.source.id, acknowledge: true });
      context.acknowledged = true;
      showProjectMirrorNotice(document, "已启用跨机对话，重新打开 Agent 菜单即可使用");
    } catch (error) {
      status.lastError = errorMessage(error);
      showProjectMirrorNotice(document, `启用跨机对话失败：${errorMessage(error)}`, "error");
    }
  };

  const runMirror = async (
    context: ProjectMirrorContext,
    selection: CrossHostAgentSelection,
    services: ProjectMirrorDesktopServices,
    rpc: ProjectMirrorRpc,
    options: { groupId?: string } = {},
  ): Promise<boolean> => {
    const sourceId = context.source.id;
    if (inFlight.has(sourceId)) return false;
    inFlight.add(sourceId);
    const hostId = selection.machine.hostId;
    const name = context.source.name.trim() || context.source.name;
    try {
      const route = hostRoute(hostId);
      if (!route) {
        showProjectMirrorNotice(document, `${selection.machine.label} 当前离线`, "error");
        return false;
      }
      const { homeDirectory } = await services.executionPaths.readHomeDirectory(hostId);
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
        return false;
      }
      const chosenPath = destination.path;
      let existingProjectId = destination.projectId;

      if (!existingProjectId) {
        if ((await directoryState(route, chosenPath)) === "missing") {
          await services.workspaceFiles.createDirectory({ hostId, path: chosenPath });
          if ((await directoryState(route, chosenPath)) !== "directory") {
            showProjectMirrorNotice(document, "远程目录创建失败", "error");
            return false;
          }
        }
        const created = await services.projects.createRemote({
          appearance: null,
          hostId,
          label: name,
          remotePath: chosenPath,
          reuseExisting: true,
        });
        if (!created) {
          showProjectMirrorNotice(document, "创建远程项目被取消", "error");
          return false;
        }
        existingProjectId = created.id;
      }

      const projectId = existingProjectId;
      if (!projectId) {
        showProjectMirrorNotice(document, "创建远程项目失败", "error");
        return false;
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
        return false;
      }
      const button = newChatButton(row);
      if (!button || button.disabled) {
        showProjectMirrorNotice(document, "该项目当前不可用（可能离线）", "error");
        return false;
      }
      pending.set(hostId, { agentId: selection.harness.id, createdAt: Date.now() });
      button.click();

      const manager = localManager();
      if (manager) {
        try {
          const result = options.groupId
            ? await appendGroupMirror(createProjectGroupRpc(manager), {
                groupId: options.groupId,
                mirror: {
                  projectId,
                  hostId,
                  remotePath: chosenPath,
                  label: name,
                },
              })
            : await joinMirrorGroup(createProjectGroupRpc(manager), {
                source: context.source,
                mirror: {
                  projectId,
                  hostId,
                  remotePath: chosenPath,
                  label: name,
                },
              });
          if (result === "skipped") {
            const key = `${sourceId}\u0000${hostId}\u0000${projectId}`;
            if (!announcedConflicts.has(key)) {
              announcedConflicts.add(key);
              showProjectMirrorNotice(document, "该项目已在其他项目组，已跳过自动分组");
            }
          } else if (result === "conflict") {
            showProjectMirrorNotice(document, "该项目已在其他项目组，未加入当前分组", "error");
          } else if (result === "missing-group") {
            showProjectMirrorNotice(document, "目标项目组已不存在", "error");
          }
        } catch (error) {
          showProjectMirrorNotice(
            document,
            `项目已创建，但自动分组失败：${errorMessage(error)}`,
            "error",
          );
          return false;
        }
      }
    } catch (error) {
      status.lastError = errorMessage(error);
      showProjectMirrorNotice(document, `跨机对话创建失败：${errorMessage(error)}`, "error");
    } finally {
      inFlight.delete(sourceId);
    }
    return true;
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
        acknowledged: context.acknowledged,
        loading: true,
        onAcknowledge: () => {
          input.picker.close();
          void acknowledge(context, rpc);
        },
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
          loadHarnessCatalog(context.catalog),
        ]);
        if (disposed || !section.element.isConnected) return;
        services = loadedServices;
        if (!services) {
          status.lastError = "Desktop project services are unavailable";
          section.refresh({ machines: [], loadedPeers: 0 }, context.acknowledged, {
            loading: false,
            error: "Desktop 项目服务不可用",
          });
          return;
        }
        status.peersLoaded = catalog.loadedPeers;
        status.machineCount = catalog.machines.length;
        section.refresh(catalog, context.acknowledged, { loading: false, error: null });
      } catch (error) {
        if (disposed || !section.element.isConnected) return;
        status.lastError = errorMessage(error);
        section.refresh({ machines: [], loadedPeers: 0 }, context.acknowledged, {
          loading: false,
          error: `其他机器不可用：${errorMessage(error)}`,
        });
      }
    })().catch((error: unknown) => {
      if (disposed) return;
      status.lastError = errorMessage(error);
    });
  };

  const api: RendererProjectMirrorApi = {
    openForAgentPicker,
    async machineCatalog() {
      if (disposed) return { machines: [], loadedPeers: 0 };
      const manager = localManager();
      if (!manager) return { machines: [], loadedPeers: 0 };
      try {
        const value = await manager.sendRequest(DESKTOP_PROJECTS_CATALOG_METHOD, {});
        return await loadHarnessCatalog(desktopProjectsCatalogSchema.parse(value));
      } catch {
        return { machines: [], loadedPeers: 0 };
      }
    },
    async addToGroup(input) {
      if (disposed) return false;
      const manager = localManager();
      if (!manager) return false;
      try {
        const [config, catalogValue, services] = await Promise.all([
          createProjectGroupRpc(manager).list(),
          manager.sendRequest(DESKTOP_PROJECTS_CATALOG_METHOD, {}),
          loadProjectMirrorDesktopServices(window),
        ]);
        const catalog = desktopProjectsCatalogSchema.parse(catalogValue);
        const group = config.groups.find((candidate) => candidate.id === input.groupId);
        const member = group?.members.find((candidate) => candidate.projectKind === "local");
        if (!member) {
          showProjectMirrorNotice(document, "该分组没有本机项目，无法添加其他机器", "error");
          return false;
        }
        const source =
          catalog.localProjects[member.projectId] ??
          Object.values(catalog.localProjects).find(
            (project) =>
              project.rootPaths.length === member.rootPaths.length &&
              project.rootPaths.every((path, index) => path === member.rootPaths[index]),
          );
        if (!source) {
          showProjectMirrorNotice(document, "找不到分组对应的本机项目", "error");
          return false;
        }
        if (!services) {
          showProjectMirrorNotice(document, "Desktop 项目服务不可用", "error");
          return false;
        }
        return await runMirror(
          { catalog, source, acknowledged: true, revision: config.revision },
          {
            machine: {
              hostId: input.hostId,
              label: input.machineLabel,
              state: "ready",
              harnesses: [{ id: input.harnessId, label: input.harnessLabel }],
            },
            harness: { id: input.harnessId, label: input.harnessLabel },
          },
          services,
          createProjectMirrorRpc(manager),
          { groupId: input.groupId },
        );
      } catch (error) {
        status.lastError = errorMessage(error);
        showProjectMirrorNotice(document, `添加机器失败：${errorMessage(error)}`, "error");
        return false;
      }
    },
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
