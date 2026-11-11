import type { DesktopProjectsCatalog, ProjectGroup } from "@codexhost/shared-contracts";

import { readBootstrapCatalog } from "./renderer-project-groups-bootstrap.js";
import {
  findNativeThreadRow,
  findProjectsSection,
  probeProjectGroupsContract,
  projectListForUnit,
  projectRowForUnit,
  projectUnitForId,
  readNativeProjectSnapshots,
  readThreadSnapshots,
  sectionCollapsed,
  showAllToggle,
  statusIconState,
} from "./renderer-project-groups-dom.js";
import {
  buildProjectGroupViews,
  buildProjectIndex,
  projectHostKey,
  worseConnectionState,
  type MachineConnectionState,
  type ProjectGroupView,
  type ThreadSnapshot,
} from "./renderer-project-groups-model.js";
import { ProjectGroupHider } from "./renderer-project-groups-hide.js";
import { ProjectGroupView as ProjectGroupDomView } from "./renderer-project-groups-view.js";
import {
  createProjectGroupsRpc,
  localProjectGroupsManager,
  type ProjectGroupsRequestManager,
} from "./renderer-project-groups-rpc.js";

const PROJECT_STATE_KEYS = new Set([
  "local-projects",
  "remote-projects",
  "thread-project-assignments",
  "project-order",
  "selected-project",
]);
const HOST_FAILURE_GRACE_MS = 5_000;
const RETRY_DELAY_MS = 1_500;

export type RendererProjectGroupsState = "probing" | "active" | "disabled";

export interface RendererProjectGroupsStatus {
  state: RendererProjectGroupsState;
  reason: string | null;
  groupCount: number;
  projectCount: number;
  missingMembers: number;
  menu: "native" | "unavailable" | "unknown";
  lastError: string | null;
}

export interface RendererProjectGroupsHandle {
  status(): RendererProjectGroupsStatus;
  refresh(): Promise<void>;
  dispose(): void;
}

interface Routing {
  forHost(hostId: string): { manager: ProjectGroupsRequestManager } | null;
}

export interface RendererProjectGroupsOptions {
  document?: Document;
  window?: Window;
  routing?: () => Routing | undefined;
  now?: () => Date;
  onStatus?(status: RendererProjectGroupsStatus): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function insideOwnUi(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  return element
    ? element.closest(
        "[data-codexhost-project-groups-root], [data-codexhost-project-groups-toast]",
      ) !== null
    : false;
}

class RendererProjectGroups implements RendererProjectGroupsHandle {
  readonly #document: Document;
  readonly #window: Window;
  readonly #readRouting: () => Routing | undefined;
  readonly #now: () => Date;
  readonly #onStatus: ((status: RendererProjectGroupsStatus) => void) | undefined;
  readonly #hider: ProjectGroupHider;
  readonly #view: ProjectGroupDomView;
  #groups: ProjectGroup[] = [];
  #revision = 0;
  #catalog: DesktopProjectsCatalog | null = null;
  #bootstrapCatalog: DesktopProjectsCatalog | null = null;
  #views: ProjectGroupView[] = [];
  #collapsed = new Set<string>();
  #status: RendererProjectGroupsStatus = {
    state: "probing",
    reason: "starting",
    groupCount: 0,
    projectCount: 0,
    missingMembers: 0,
    menu: "unavailable",
    lastError: null,
  };
  #observer: MutationObserver | null = null;
  #retryTimer: number | null = null;
  #debounceTimer: number | null = null;
  #refreshing = false;
  #queued = false;
  #hostFailureAt: number | null = null;
  #disposed = false;

  constructor(options: RendererProjectGroupsOptions) {
    this.#document = options.document ?? document;
    this.#window = options.window ?? window;
    this.#readRouting =
      options.routing ??
      (() =>
        (this.#window as Window & { __codexhostHostRoutingV1?: Routing }).__codexhostHostRoutingV1);
    this.#now = options.now ?? (() => new Date());
    this.#onStatus = options.onStatus;
    this.#bootstrapCatalog = readBootstrapCatalog(this.#window, this.#now);
    this.#hider = new ProjectGroupHider(this.#document);
    this.#view = new ProjectGroupDomView(this.#document, {
      toggleGroup: (groupId) => this.#toggleGroup(groupId),
      openThread: (thread) => this.#openThread(thread),
      expandProject: (projectId) => this.#expandProject(projectId),
      showAll: (projectId) => this.#showAll(projectId),
    });
    this.#installListeners();
    this.#observe();
    this.#publishStatus();
    void this.refresh();
  }

  status(): RendererProjectGroupsStatus {
    return { ...this.#status };
  }

  async refresh(): Promise<void> {
    if (this.#disposed) return;
    if (this.#refreshing) {
      this.#queued = true;
      return;
    }
    this.#refreshing = true;
    try {
      const section = findProjectsSection(this.#document);
      if (!section) {
        this.#setProbing("projects-section-missing");
        this.#scheduleRetry(2_000);
        return;
      }
      const contract = probeProjectGroupsContract(section);
      if (!contract.ok) {
        this.#failOpen(`contract-missing:${contract.missing.join(",")}`);
        this.#scheduleRetry(2_000);
        return;
      }

      const manager = this.#manager();
      if (!manager) {
        this.#setProbing("host-unavailable");
        this.#maybeFailOpenForHostFailure();
        this.#scheduleRetry(RETRY_DELAY_MS);
        return;
      }
      const rpc = createProjectGroupsRpc(manager);
      let config;
      try {
        config = await rpc.list();
      } catch (error) {
        this.#recordError(error);
        this.#setProbing("host-unavailable");
        this.#maybeFailOpenForHostFailure();
        this.#scheduleRetry(RETRY_DELAY_MS);
        return;
      }
      let catalog: DesktopProjectsCatalog | null = null;
      try {
        catalog = await rpc.readDesktopCatalog();
      } catch (error) {
        this.#recordError(error);
        catalog = this.#bootstrapCatalog;
      }
      if (!catalog) {
        this.#failOpen("desktop-catalog-unavailable");
        this.#scheduleRetry(RETRY_DELAY_MS);
        return;
      }

      this.#hostFailureAt = null;
      this.#groups = config.groups;
      this.#revision = config.revision;
      this.#catalog = catalog;
      this.#renderActive(section);
    } catch (error) {
      this.#recordError(error);
      this.#failOpen("refresh-failed");
      this.#scheduleRetry(RETRY_DELAY_MS);
    } finally {
      this.#refreshing = false;
      if (this.#queued) {
        this.#queued = false;
        this.#scheduleRefresh(0);
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#retryTimer !== null) this.#window.clearTimeout(this.#retryTimer);
    if (this.#debounceTimer !== null) this.#window.clearTimeout(this.#debounceTimer);
    this.#retryTimer = null;
    this.#debounceTimer = null;
    this.#window.removeEventListener("message", this.#onWindowMessage);
    this.#window.removeEventListener("focus", this.#onFocus);
    this.#document.removeEventListener("visibilitychange", this.#onFocus);
    this.#window.removeEventListener("codexhost:renderer-adapter-status", this.#onFocus);
    this.#hider.dispose();
    this.#view.dispose();
    delete this.#document.documentElement.dataset.codexhostProjectGroupsState;
  }

  #manager(): ProjectGroupsRequestManager | null {
    return localProjectGroupsManager(this.#readRouting());
  }

  #installListeners(): void {
    this.#window.addEventListener("message", this.#onWindowMessage);
    this.#window.addEventListener("focus", this.#onFocus);
    this.#document.addEventListener("visibilitychange", this.#onFocus);
    this.#window.addEventListener("codexhost:renderer-adapter-status", this.#onFocus);
  }

  readonly #onWindowMessage = (event: MessageEvent): void => {
    if (event.source != null && event.source !== this.#window) return;
    if (!record(event.data)) return;
    const type = event.data.type;
    if (type === "thread-project-memberships-updated") {
      this.#scheduleRefresh(80);
      return;
    }
    if (
      type === "global-state-updated" &&
      Array.isArray(event.data.keys) &&
      event.data.keys.some((key) => typeof key === "string" && PROJECT_STATE_KEYS.has(key))
    ) {
      this.#scheduleRefresh(80);
    }
  };

  readonly #onFocus = (): void => {
    this.#scheduleRefresh(0);
  };

  #observe(): void {
    const target = this.#document.body ?? this.#document.documentElement;
    this.#observer = new MutationObserver((mutations) => {
      if (
        mutations.every((mutation) => {
          if (insideOwnUi(mutation.target)) return true;
          if (
            mutation.target instanceof HTMLStyleElement &&
            mutation.target.hasAttribute("data-codexhost-project-groups")
          )
            return true;
          for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
            if (insideOwnUi(node)) return true;
            if (
              node instanceof HTMLStyleElement &&
              node.hasAttribute("data-codexhost-project-groups")
            )
              return true;
          }
          return false;
        })
      )
        return;
      this.#scheduleRefresh();
    });
    this.#observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-app-action-sidebar-project-collapsed",
        "data-app-action-sidebar-project-show-all",
        "data-app-action-sidebar-thread-title",
        "data-app-action-sidebar-thread-selected",
        "data-app-action-sidebar-thread-active",
        "data-app-action-sidebar-thread-pinned",
        "data-app-action-sidebar-section-collapsed",
        "aria-label",
      ],
    });
  }

  #scheduleRefresh(delay = 40): void {
    if (this.#disposed) return;
    if (this.#debounceTimer !== null) this.#window.clearTimeout(this.#debounceTimer);
    this.#debounceTimer = this.#window.setTimeout(() => {
      this.#debounceTimer = null;
      void this.refresh();
    }, delay);
  }

  #scheduleRetry(delay: number): void {
    if (this.#disposed || this.#retryTimer !== null) return;
    this.#retryTimer = this.#window.setTimeout(() => {
      this.#retryTimer = null;
      void this.refresh();
    }, delay);
  }

  #renderActive(section: HTMLElement): void {
    const snapshots = readNativeProjectSnapshots(section);
    const threadsByProject = new Map<string, readonly ThreadSnapshot[]>();
    const projectStatus = new Map<string, MachineConnectionState>();
    for (const snapshot of snapshots) {
      const unit = projectUnitForId(section, snapshot.projectId);
      const row = unit ? projectRowForUnit(unit) : null;
      const list = unit ? projectListForUnit(unit) : null;
      if (list) threadsByProject.set(snapshot.projectId, readThreadSnapshots(list));
      if (row) projectStatus.set(snapshot.projectId, statusIconState(row));
    }
    const index = buildProjectIndex(this.#catalog!, snapshots);
    const machineState = new Map<string, MachineConnectionState>();
    for (const snapshot of snapshots) {
      const entry = index.get(snapshot.projectId);
      if (!entry) continue;
      const key = projectHostKey(entry);
      const state =
        entry.kind === "local" ? "connected" : (projectStatus.get(snapshot.projectId) ?? "unknown");
      machineState.set(key, worseConnectionState(machineState.get(key) ?? "unknown", state));
    }
    this.#views = buildProjectGroupViews({
      groups: this.#groups,
      catalog: this.#catalog!,
      snapshots,
      threadsByProject,
      machineState,
    });
    const hidden = this.#views.flatMap((view) =>
      view.projects.flatMap((project) =>
        project.project.entry?.native ? [project.project.entry.projectId] : [],
      ),
    );
    this.#hider.apply(section, hidden);
    this.#view.render(this.#views, { collapsedGroups: this.#collapsed });
    const missingMembers = this.#views.reduce((count, view) => count + view.unresolved.length, 0);
    this.#status = {
      ...this.#status,
      state: "active",
      reason: null,
      groupCount: this.#groups.length,
      projectCount: new Set(
        this.#views.flatMap((view) =>
          view.projects.flatMap((project) =>
            project.project.entry ? [project.project.entry.projectId] : [],
          ),
        ),
      ).size,
      missingMembers,
      menu: "unavailable",
    };
    this.#publishStatus();
  }

  #toggleGroup(groupId: string): void {
    if (this.#collapsed.has(groupId)) this.#collapsed.delete(groupId);
    else this.#collapsed.add(groupId);
    this.#view.render(this.#views, { collapsedGroups: this.#collapsed });
  }

  #openThread(thread: ThreadSnapshot): void {
    const section = findProjectsSection(this.#document);
    const row = section ? findNativeThreadRow(section, thread.threadId, thread.hostId) : null;
    if (row) row.click();
    else void this.refresh();
  }

  #expandProject(projectId: string): void {
    const section = findProjectsSection(this.#document);
    if (!section) return;
    const unit = projectUnitForId(section, projectId);
    const button = unit ? projectRowForUnit(unit) : null;
    if (!button) return;
    if (sectionCollapsed(section)) {
      section.querySelector<HTMLElement>("[data-app-action-sidebar-section-toggle]")?.click();
      this.#window.setTimeout(() => {
        button.click();
        this.#scheduleRefresh(120);
      }, 120);
      return;
    }
    button.click();
    this.#scheduleRefresh(120);
  }

  #showAll(projectId: string): void {
    const section = findProjectsSection(this.#document);
    if (!section) return;
    const unit = projectUnitForId(section, projectId);
    const list = unit ? projectListForUnit(unit) : null;
    if (!list) return;
    showAllToggle(list)?.click();
    this.#scheduleRefresh(120);
  }

  #recordError(error: unknown): void {
    const message = errorMessage(error).slice(0, 500);
    this.#status = { ...this.#status, lastError: message };
    this.#publishStatus();
  }

  #setProbing(reason: string): void {
    this.#status = { ...this.#status, state: "probing", reason };
    this.#publishStatus();
  }

  #failOpen(reason: string): void {
    this.#hider.clear();
    this.#view.dispose();
    this.#views = [];
    this.#status = {
      ...this.#status,
      state: "disabled",
      reason,
      menu: "unavailable",
    };
    this.#publishStatus();
  }

  #maybeFailOpenForHostFailure(): void {
    const now = this.#now().getTime();
    this.#hostFailureAt ??= now;
    if (now - this.#hostFailureAt >= HOST_FAILURE_GRACE_MS) this.#failOpen("host-unavailable");
  }

  #publishStatus(): void {
    this.#document.documentElement.dataset.codexhostProjectGroupsState = this.#status.state;
    this.#onStatus?.({ ...this.#status });
  }
}

export function installRendererProjectGroups(
  options: RendererProjectGroupsOptions = {},
): RendererProjectGroupsHandle {
  const target = (options.window ?? window) as Window & {
    __codexhostProjectGroupsV1?: RendererProjectGroupsHandle;
  };
  target.__codexhostProjectGroupsV1?.dispose();
  const handle = new RendererProjectGroups(options);
  target.__codexhostProjectGroupsV1 = handle;
  return handle;
}
