import type { DesktopProjectsCatalog, ProjectGroup } from "@codexhost/shared-contracts";

import { readBootstrapCatalog } from "./renderer-project-groups-bootstrap.js";
import {
  findProjectsSection,
  findProjectsShowMoreButton,
  newChatButton,
  probeProjectGroupsContract,
  projectRowForUnit,
  projectRowOutsideSection,
  projectUnitForId,
  readNativeProjectSnapshots,
  statusIconState,
  PROJECT_COLLAPSED_ATTRIBUTE,
  SECTION_COLLAPSED_ATTRIBUTE,
} from "./renderer-project-groups-dom.js";
import {
  buildProjectGroupViews,
  buildProjectIndex,
  mergeMachineState,
  projectGroupMachineSummary,
  projectHostKey,
  type MachineConnectionState,
  type ProjectGroupProjectView,
  type ProjectGroupView,
} from "./renderer-project-groups-model.js";
import {
  ProjectGroupHeaders,
  type ProjectGroupHeaderItem,
} from "./renderer-project-groups-header.js";
import {
  ProjectGroupLayoutStyle,
  type ProjectGroupLayoutGroup,
} from "./renderer-project-groups-layout.js";
import { ProjectGroupsDialog } from "./renderer-project-groups-dialog.js";
import { ProjectGroupNewChatPicker } from "./renderer-project-groups-new-chat.js";
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
  "pinned-project-ids",
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
        "[data-codexhost-project-groups-ui], [data-codexhost-project-groups-dialog], [data-codexhost-project-groups-new-chat], [data-codexhost-project-groups-toast]",
      ) !== null
    : false;
}

class RendererProjectGroups implements RendererProjectGroupsHandle {
  readonly #document: Document;
  readonly #window: Window;
  readonly #readRouting: () => Routing | undefined;
  readonly #now: () => Date;
  readonly #onStatus: ((status: RendererProjectGroupsStatus) => void) | undefined;
  readonly #layout: ProjectGroupLayoutStyle;
  readonly #headers: ProjectGroupHeaders;
  readonly #picker: ProjectGroupNewChatPicker;
  readonly #dialog: ProjectGroupsDialog;
  #groups: ProjectGroup[] = [];
  #revision = 0;
  #catalog: DesktopProjectsCatalog | null = null;
  #bootstrapCatalog: DesktopProjectsCatalog | null = null;
  #views: ProjectGroupView[] = [];
  #placeholders = new Map<string, number>();
  #collapsed = new Set<string>();
  #status: RendererProjectGroupsStatus = {
    state: "probing",
    reason: "starting",
    groupCount: 0,
    projectCount: 0,
    missingMembers: 0,
    lastError: null,
  };
  #observer: MutationObserver | null = null;
  #retryTimer: number | null = null;
  #debounceTimer: number | null = null;
  #refreshing = false;
  #queued = false;
  #hostFailureAt: number | null = null;
  #disposed = false;
  #shownConfigWarnings = new Set<string>();

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
    this.#layout = new ProjectGroupLayoutStyle(this.#document);
    this.#headers = new ProjectGroupHeaders(this.#document, {
      toggleGroup: (groupId) => this.#toggleGroup(groupId),
      openNewChat: (groupId, anchor) => this.#openNewChat(groupId, anchor),
      openManager: (groupId) => this.#openManager(groupId),
      showMoreProjects: () => this.#showMoreProjects(),
    });
    this.#picker = new ProjectGroupNewChatPicker({
      document: this.#document,
      window: this.#window,
      onSelect: (project) => this.#startNewChat(project),
    });
    this.#dialog = new ProjectGroupsDialog({
      document: this.#document,
      window: this.#window,
      catalog: () => this.#catalog,
      groups: () => this.#groups,
      save: (groups) => this.#saveGroups(groups),
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
      if (
        config.warning?.kind === "quarantined" &&
        !this.#shownConfigWarnings.has(config.warning.backupName)
      ) {
        this.#shownConfigWarnings.add(config.warning.backupName);
        const message = `项目组配置无法读取，已备份为 ${config.warning.backupName}，已恢复为空配置`;
        this.#recordError(new Error(message));
        this.#notify(message);
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
    this.#picker.dispose();
    this.#dialog.close();
    this.#headers.dispose();
    this.#layout.dispose();
    const target = this.#window as Window & {
      __codexhostProjectGroupsV1?: RendererProjectGroupsHandle;
    };
    if (target.__codexhostProjectGroupsV1 === this) delete target.__codexhostProjectGroupsV1;
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
        PROJECT_COLLAPSED_ATTRIBUTE,
        "data-app-action-sidebar-project-show-all",
        SECTION_COLLAPSED_ATTRIBUTE,
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
    const catalog = this.#catalog;
    if (!catalog) return;
    const snapshots = readNativeProjectSnapshots(section);
    const projectStatus = new Map<string, MachineConnectionState>();
    for (const snapshot of snapshots) {
      const unit = projectUnitForId(section, snapshot.projectId);
      const row = unit ? projectRowForUnit(unit) : null;
      if (row) projectStatus.set(snapshot.projectId, statusIconState(row));
    }
    const index = buildProjectIndex(catalog, snapshots);
    const machineState = new Map<string, MachineConnectionState>();
    for (const snapshot of snapshots) {
      const entry = index.get(snapshot.projectId);
      if (!entry) continue;
      const key = projectHostKey(entry);
      const state =
        entry.kind === "local" ? "connected" : (projectStatus.get(snapshot.projectId) ?? "unknown");
      machineState.set(key, mergeMachineState(machineState.get(key), state));
    }
    this.#views = buildProjectGroupViews({
      groups: this.#groups,
      catalog,
      snapshots,
      machineState,
    });
    this.#placeholders = this.#computePlaceholders(section, this.#views);
    this.#paint();
    const missingMembers = this.#views.reduce(
      (count, view) =>
        count + view.projects.filter((project) => project.project.missing === "missing").length,
      0,
    );
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
    };
    this.#publishStatus();
  }

  #computePlaceholders(
    section: HTMLElement,
    views: readonly ProjectGroupView[],
  ): Map<string, number> {
    const placeholders = new Map<string, number>();
    if (!findProjectsShowMoreButton(section)) return placeholders;
    for (const view of views) {
      let count = 0;
      for (const project of view.projects) {
        if (project.project.missing !== "not-mounted") continue;
        const projectId = project.project.entry?.projectId ?? project.project.member.projectId;
        if (projectRowOutsideSection(this.#document, section, projectId)) continue;
        count += 1;
      }
      if (count > 0) placeholders.set(view.group.id, count);
    }
    return placeholders;
  }

  #paint(): void {
    const items: ProjectGroupHeaderItem[] = this.#views.map((view) => {
      const summary = projectGroupMachineSummary(view.machines);
      return {
        id: view.group.id,
        name: view.group.name,
        machineSummary: summary.text,
        machineSummaryTitle: summary.title,
        projectIds: view.projects.flatMap((project) =>
          project.project.entry?.native ? [project.project.entry.projectId] : [],
        ),
      };
    });
    const layoutGroups: ProjectGroupLayoutGroup[] = items.map((item) => ({
      id: item.id,
      collapsed: this.#collapsed.has(item.id),
      projectIds: item.projectIds,
    }));
    this.#layout.apply(layoutGroups);
    this.#headers.render(items, {
      collapsedGroups: this.#collapsed,
      placeholders: this.#placeholders,
    });
  }

  #toggleGroup(groupId: string): void {
    if (this.#collapsed.has(groupId)) this.#collapsed.delete(groupId);
    else this.#collapsed.add(groupId);
    this.#paint();
  }

  #notify(message: string): void {
    const toast = this.#document.createElement("div");
    toast.textContent = message;
    toast.setAttribute("role", "status");
    toast.setAttribute("data-codexhost-project-groups-toast", "");
    for (const [property, value] of Object.entries({
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      "z-index": "2147483001",
      background: "var(--color-surface, #222)",
      color: "var(--color-text, #fff)",
      border: "1px solid var(--color-border, #555)",
      "border-radius": "8px",
      padding: "8px 12px",
      "font-size": "12px",
      "box-shadow": "0 8px 24px rgba(0,0,0,0.25)",
      "max-width": "420px",
    }))
      toast.style.setProperty(property, value);
    this.#document.body.append(toast);
    this.#window.setTimeout(() => toast.remove(), 4_000);
  }

  #openManager(groupId?: string): void {
    if (!this.#catalog) {
      void this.refresh().then(() => this.#dialog.open(groupId));
      return;
    }
    this.#dialog.open(groupId);
  }

  async #saveGroups(groups: readonly ProjectGroup[]): Promise<{
    ok: boolean;
    conflict?: boolean;
    message?: string;
  }> {
    const manager = this.#manager();
    if (!manager) return { ok: false, message: "Host 暂不可用，无法保存项目组。" };
    const rpc = createProjectGroupsRpc(manager);
    try {
      const result = await rpc.replace({ revision: this.#revision, groups: [...groups] });
      this.#groups = result.groups;
      this.#revision = result.revision;
      this.#hostFailureAt = null;
      this.#scheduleRefresh(0);
      return { ok: true };
    } catch (error) {
      const message = errorMessage(error);
      if (/revision|changed/i.test(message)) {
        await this.refresh();
        return {
          ok: false,
          conflict: true,
          message: "项目组已在其他窗口修改，已重新加载，请重试。",
        };
      }
      this.#recordError(error);
      return { ok: false, message: "保存项目组失败，请稍后重试。" };
    }
  }

  #openNewChat(groupId: string, anchor: HTMLElement): void {
    const view = this.#views.find((candidate) => candidate.group.id === groupId);
    if (view) this.#picker.open(view, anchor);
  }

  #startNewChat(project: ProjectGroupProjectView): void {
    const projectId = project.project.entry?.projectId;
    if (!projectId) return;
    const section = findProjectsSection(this.#document);
    if (!section) return;
    const unit = projectUnitForId(section, projectId);
    const row = unit ? projectRowForUnit(unit) : null;
    const button = row ? newChatButton(row) : null;
    if (!button) {
      this.#notify("该项目当前未显示在侧边栏，无法新建对话。");
      void this.refresh();
      return;
    }
    if ((button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true") {
      this.#notify("该项目当前不可用（可能离线或缺少工作目录）。");
      return;
    }
    button.click();
    this.#scheduleRefresh(200);
  }

  #showMoreProjects(): void {
    const section = findProjectsSection(this.#document);
    const button = section ? findProjectsShowMoreButton(section) : null;
    if (!button) {
      this.#notify("原生 Projects 列表没有可用的展开按钮。");
      return;
    }
    button.click();
    this.#scheduleRefresh(300);
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
    this.#dialog.close();
    this.#picker.close();
    this.#headers.dispose();
    this.#layout.dispose();
    this.#placeholders.clear();
    this.#views = [];
    this.#status = {
      ...this.#status,
      state: "disabled",
      reason,
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
