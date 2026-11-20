import {
  DESKTOP_PROJECTS_CATALOG_METHOD,
  desktopProjectsCatalogSchema,
  type DesktopProjectsCatalog,
} from "@codexhost/shared-contracts";

import type { RendererAgentPickerControl } from "./renderer-agent-picker.js";
import { CODEX_COMPOSER_SELECTOR } from "./renderer-composer-dom.js";
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
  readComposerProject,
  resolveMirrorSource,
  type MirrorProjectSource,
  type ProjectEligibilityReason,
} from "./renderer-project-mirror-model.js";
import {
  createProjectMirrorProgress,
  projectMirrorProgressText,
  type ProjectMirrorProgressControl,
} from "./renderer-project-mirror-progress.js";
import { showProjectMirrorNotice } from "./renderer-project-mirror-notice.js";
import { runProjectMirror } from "./renderer-project-mirror-run.js";
import {
  createProjectMirrorRpc,
  localProjectMirrorManager,
} from "./renderer-project-mirror-rpc.js";
import {
  loadProjectMirrorDesktopServices,
  type ProjectMirrorDesktopServices,
} from "./renderer-project-mirror-services.js";

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
const HARNESS_CATALOG_TTL_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localManager(): ReturnType<typeof localProjectMirrorManager> {
  return localProjectMirrorManager(window.__codexhostHostRoutingV1);
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

  let activeProgress: ProjectMirrorProgressControl | null = null;
  /** The Composer may be rebuilt while the run waits on Desktop; re-find it. */
  const currentComposer = (): Element | null => {
    for (const candidate of document.querySelectorAll<HTMLElement>(CODEX_COMPOSER_SELECTOR)) {
      if (candidate.isConnected && candidate.getClientRects().length > 0) return candidate;
    }
    return null;
  };
  const showProgress = (
    composer: Element,
    selection: CrossHostAgentSelection,
  ): ProjectMirrorProgressControl => {
    activeProgress?.dispose();
    const progress = createProjectMirrorProgress({
      document,
      anchor: composer,
      resolveAnchor: currentComposer,
      text: projectMirrorProgressText({
        machineLabel: selection.machine.label,
        local: selection.machine.hostId === "local",
      }),
    });
    activeProgress = progress;
    return progress;
  };
  const startMirror = (
    composer: Element,
    context: ProjectMirrorContext,
    selection: CrossHostAgentSelection,
    services: ProjectMirrorDesktopServices,
    rpc: ReturnType<typeof createProjectMirrorRpc>,
  ): void => {
    if (inFlight.has(context.source.id)) {
      showProjectMirrorNotice(document, "正在添加这台机器，请稍候。");
      return;
    }
    const progress = showProgress(composer, selection);
    void runProjectMirror({
      document,
      routing: window.__codexhostHostRoutingV1,
      context,
      selection,
      services,
      rpc,
      progress,
      inFlight,
      pending,
      onBackgroundError: (error) => {
        status.lastError = errorMessage(error);
      },
    }).catch((error: unknown) => {
      status.lastError = errorMessage(error);
      progress.fail("添加机器失败，请稍后重试。");
    });
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
          input.picker.close();
          if (!services) {
            showProgress(input.composer, selection).fail("Desktop 项目服务尚未就绪，请稍后重试");
            return;
          }
          startMirror(input.composer, context, selection, services, rpc);
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
      activeProgress?.dispose();
      activeProgress = null;
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
