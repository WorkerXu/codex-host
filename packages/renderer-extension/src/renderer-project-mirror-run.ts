import type { DesktopProjectsCatalog, ProjectMirrorRecord } from "@codexhost/shared-contracts";

import type { CrossHostAgentSelection } from "./renderer-cross-host-agent-section.js";
import {
  chooseMirrorDestination,
  findNameOnlyLocalProject,
  mirrorDirectoryCandidates,
  type MirrorProjectSource,
} from "./renderer-project-mirror-model.js";
import { showProjectMirrorNotice } from "./renderer-project-mirror-notice.js";
import type { ProjectMirrorProgress } from "./renderer-project-mirror-progress.js";
import type { ProjectMirrorRpc } from "./renderer-project-mirror-rpc.js";
import { joinMirroredProjectSection } from "./renderer-project-mirror-section.js";
import type { ProjectMirrorDesktopServices } from "./renderer-project-mirror-services.js";

export interface ProjectMirrorHostRoute {
  manager: { sendRequest(method: string, params: unknown): unknown };
}

export interface ProjectMirrorRunContext {
  catalog: DesktopProjectsCatalog;
  source: MirrorProjectSource;
}

export interface ProjectMirrorPendingEntry {
  agentId: string;
  createdAt: number;
}

export type ProjectMirrorOpenResult =
  { ok: true } | { ok: false; reason: "missing-row" | "unavailable" };

export interface ProjectMirrorRunResult {
  ok: boolean;
  message: string | null;
}

export interface ProjectMirrorRunInput {
  document: Document;
  routing: { forHost(hostId: string): ProjectMirrorHostRoute | null } | undefined;
  context: ProjectMirrorRunContext;
  selection: CrossHostAgentSelection;
  services: ProjectMirrorDesktopServices;
  rpc: ProjectMirrorRpc;
  progress: ProjectMirrorProgress;
  inFlight: Set<string>;
  pending: Map<string, ProjectMirrorPendingEntry>;
  now?(): number;
  /** Test seam: the native section join. */
  joinSection?(input: Parameters<typeof joinMirroredProjectSection>[0]): Promise<unknown>;
  /** Test seam: waiting for the sidebar row and pressing its new-chat button. */
  openChat?(input: {
    projectId: string;
    hostId: string;
    agentId: string;
  }): Promise<ProjectMirrorOpenResult>;
  onBackgroundError?(error: unknown): void;
}

const SIDEBAR_TIMEOUT_MS = 5_000;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function listAppProjects(
  route: ProjectMirrorHostRoute,
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

async function directoryState(
  route: ProjectMirrorHostRoute,
  path: string,
): Promise<DirectoryState> {
  try {
    const metadata = await route.manager.sendRequest("fs/getMetadata", { path });
    return record(metadata) && metadata.isDirectory === true ? "directory" : "other";
  } catch (error) {
    return /No such file|os error 2|not found/iu.test(errorMessage(error)) ? "missing" : "other";
  }
}

function sidebarProjectRow(document: Document, projectId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-app-action-sidebar-project-id="${CSS.escape(projectId)}"]`,
  );
}

/** Resolve on the sidebar's own DOM change instead of polling a fixed interval. */
function waitForSidebarProject(document: Document, projectId: string): Promise<HTMLElement | null> {
  const existing = sidebarProjectRow(document, projectId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const view = document.defaultView;
    const timeout = view?.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, SIDEBAR_TIMEOUT_MS);
    const observer = new MutationObserver(() => {
      const row = sidebarProjectRow(document, projectId);
      if (!row) return;
      if (timeout !== undefined) view?.clearTimeout(timeout);
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

async function openDefaultChat(input: {
  document: Document;
  pending: Map<string, ProjectMirrorPendingEntry>;
  now: () => number;
  projectId: string;
  hostId: string;
  agentId: string;
}): Promise<ProjectMirrorOpenResult> {
  const row = await waitForSidebarProject(input.document, input.projectId);
  if (!row) return { ok: false, reason: "missing-row" };
  const button = newChatButton(row);
  if (!button || button.disabled) return { ok: false, reason: "unavailable" };
  input.pending.set(input.hostId, { agentId: input.agentId, createdAt: input.now() });
  button.click();
  return { ok: true };
}

/**
 * Create the mirror project, register it, join its section and open a blank
 * chat in it. Section join and registry write run alongside the chat opening:
 * only the project creation and the sidebar row gate the new conversation.
 */
export async function runProjectMirror(
  input: ProjectMirrorRunInput,
): Promise<ProjectMirrorRunResult> {
  const { document, context, selection, services, rpc, progress } = input;
  const now = input.now ?? Date.now;
  const fail = (message: string): ProjectMirrorRunResult => {
    progress.fail(message);
    return { ok: false, message };
  };
  const sourceId = context.source.id;
  if (input.inFlight.has(sourceId)) return fail("正在添加这台机器，请稍候。");
  input.inFlight.add(sourceId);
  const hostId = selection.machine.hostId;
  const name = context.source.name.trim() || context.source.name;
  try {
    const route = input.routing?.forHost(hostId) ?? null;
    if (!route) return fail(`${selection.machine.label} 当前离线`);
    // The card is already visible when this runs; every awaited step follows it.
    progress.step("prepare");
    const registryPromise = rpc.list();
    let projectId: string | null;
    let chosenPath: string;
    let known: ProjectMirrorRecord | undefined;

    if (hostId === "local") {
      // The mirror runs the other way: Desktop creates `~/Documents/ChatGPT/<name>`
      // here, so the Mac reuses its own same-name project when it exists.
      const registry = await registryPromise;
      known = registry.projects[sourceId];
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
        // Desktop only creates a folder here, but this is still the real create.
        progress.step("create");
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
      const [registry, appProjects, { homeDirectory }] = await Promise.all([
        registryPromise,
        listAppProjects(route).catch(() => []),
        services.executionPaths.readHomeDirectory(hostId),
      ]);
      known = registry.projects[sourceId];
      const parent = `${homeDirectory.replace(/\/+$/u, "")}/Documents/ChatGPT`;
      const remoteProjects = context.catalog.remoteProjects.filter(
        (project) => project.hostId === hostId,
      );
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
        // Trust is only asked by `createRemote`, and only when the project does
        // not exist yet; the hint belongs to this step, not to preparation.
        progress.step("create");
        // `chooseMirrorDestination` already probed this path; only create when
        // it reported the folder missing instead of probing it a second time.
        if (destination.state === "missing") {
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
        void Promise.resolve(
          route.manager.sendRequest("project/create", {
            name,
            roots: [{ path: chosenPath }],
            metadata: {},
            idempotencyKey: projectId,
          }),
        ).catch((error: unknown) =>
          console.warn("codexhost project mirror: project/create failed", error),
        );
      }
    }

    if (!projectId || !chosenPath) return fail("创建项目失败，请稍后重试");
    const nowIso = new Date(now()).toISOString();
    progress.step("section");
    // Neither the section nor the registry gates the new conversation; both
    // report their own failure after the chat is already open.
    void (input.joinSection ?? joinMirroredProjectSection)({
      services,
      sourceProjectId: sourceId,
      remoteProjectId: projectId,
      projectName: name,
      targetHostId: hostId,
    }).catch((error: unknown) => {
      input.onBackgroundError?.(error);
      showProjectMirrorNotice(document, "项目已创建，但未能自动加入同一分区", "error");
    });
    void upsertRegistry(rpc, {
      sourceProjectId: sourceId,
      record: {
        hostId,
        remoteProjectId: projectId,
        remotePath: chosenPath,
        label: name,
        createdAt: known?.createdAt ?? nowIso,
        updatedAt: nowIso,
      },
    }).catch((error: unknown) => input.onBackgroundError?.(error));

    progress.step("open");
    const openChat =
      input.openChat ??
      ((chat) => openDefaultChat({ ...chat, document, pending: input.pending, now }));
    const opened = await openChat({ projectId, hostId, agentId: selection.harness.id });
    if (!opened.ok) {
      return fail(
        opened.reason === "missing-row"
          ? "项目已创建，但侧栏尚未显示，请稍后手动打开"
          : "该项目当前不可用，可能已离线",
      );
    }
    progress.done();
    return { ok: true, message: null };
  } catch (error) {
    input.onBackgroundError?.(error);
    return fail("添加机器失败，请稍后重试。");
  } finally {
    input.inFlight.delete(sourceId);
  }
}
