import type { DesktopProjectsCatalog, ProjectGroup } from "@codexhost/shared-contracts";

import { readBootstrapCatalog } from "./renderer-project-groups-bootstrap.js";
import {
  findNativeThreadRow,
  findProjectsSection,
  findProjectsShowMoreButton,
  nativeThreadActionButton,
  newChatButton,
  probeProjectGroupsContract,
  projectListForUnit,
  projectRowForUnit,
  projectUnitForId,
  readNativeProjectSnapshots,
  readThreadSnapshots,
  restoreSidebarScrollAfterThreadClick,
  PROVIDER_ICON_LOADED_EVENT,
  sectionCollapsed,
  sidebarScrollContainer,
  showAllToggle,
  statusIconState,
} from "./renderer-project-groups-dom.js";
import {
  buildProjectGroupViews,
  buildProjectIndex,
  mergeMachineState,
  projectHostKey,
  type MachineConnectionState,
  type ProjectGroupProjectView,
  type ProjectGroupView,
  type ThreadSnapshot,
} from "./renderer-project-groups-model.js";
import { ProjectGroupHider } from "./renderer-project-groups-hide.js";
import { ProjectGroupMenuProxy } from "./renderer-project-groups-menu.js";
import { ProjectGroupsDialog } from "./renderer-project-groups-dialog.js";
import {
  collectNativeThreadMenuActions,
  ProjectGroupThreadMenu,
} from "./renderer-project-groups-thread-menu.js";
import { ProjectGroupNewChatPicker } from "./renderer-project-groups-new-chat.js";
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
  menu: "native-context" | "proxy-menu" | "unavailable" | "unknown";
  threadActions: "native" | "unavailable";
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
        "[data-codexhost-project-groups-root], [data-codexhost-project-groups-dialog], [data-codexhost-project-groups-new-chat], [data-codexhost-project-groups-thread-menu], [data-codexhost-project-groups-toast]",
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
  readonly #menu: ProjectGroupMenuProxy;
  readonly #threadMenu: ProjectGroupThreadMenu;
  readonly #picker: ProjectGroupNewChatPicker;
  readonly #dialog: ProjectGroupsDialog;
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
    threadActions: "unavailable",
    lastError: null,
  };
  #observer: MutationObserver | null = null;
  #retryTimer: number | null = null;
  #debounceTimer: number | null = null;
  #refreshing = false;
  #queued = false;
  #hostFailureAt: number | null = null;
  #disposed = false;
  #hasContextMenu = false;
  #hasThreadActions = false;
  #threadActionsUnsupported = false;
  #lastThreadActionNotice = false;
  #lastHasContextMenu = false;
  #lastSection: HTMLElement | null = null;
  #lastReprobedRevision = -1;
  #nativeContextUnsupported = false;
  #menuPending = false;
  #lastMenuMode: RendererProjectGroupsStatus["menu"] = "unknown";

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
    this.#threadMenu = new ProjectGroupThreadMenu(this.#document, this.#window);
    this.#menu = new ProjectGroupMenuProxy({
      document: this.#document,
      window: this.#window,
      onUnsupported: (reason) => this.#onNativeContextUnsupported(reason),
      onFailure: (reason) => this.#recordError(new Error(reason)),
      onClosed: () => this.#scheduleRefresh(0),
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
    this.#view = new ProjectGroupDomView(this.#document, {
      toggleGroup: (groupId) => this.#toggleGroup(groupId),
      openThread: (thread) => this.#openThread(thread),
      openThreadMenu: (thread, anchor, nativeFirst) =>
        void this.#openThreadMenu(thread, anchor, nativeFirst),
      toggleThreadPin: (thread) => void this.#proxyThreadAction(thread, "pin"),
      archiveThread: (thread) => void this.#proxyThreadAction(thread, "archive"),
      openNewChat: (groupId, anchor) => this.#openNewChat(groupId, anchor),
      openManager: (groupId) => this.#openManager(groupId),
      expandProject: (projectId) => this.#expandProject(projectId),
      showAll: (projectId) => this.#showAll(projectId),
      showMoreProjects: () => this.#showMoreProjects(),
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
      this.#hasContextMenu = contract.hasContextMenu;
      this.#hasThreadActions = contract.hasThreadActions;
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

      const sectionChanged = section !== this.#lastSection;
      const menuAppeared = contract.hasContextMenu && !this.#lastHasContextMenu;
      const revisionChanged = this.#revision !== this.#lastReprobedRevision;
      if (contract.hasContextMenu && (sectionChanged || menuAppeared || revisionChanged)) {
        this.#menu.reprobe();
        this.#nativeContextUnsupported = false;
        this.#threadActionsUnsupported = false;
        this.#lastMenuMode = "unknown";
        this.#lastReprobedRevision = this.#revision;
      }
      this.#lastSection = section;
      this.#lastHasContextMenu = contract.hasContextMenu;
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
    this.#window.removeEventListener(PROVIDER_ICON_LOADED_EVENT, this.#onFocus);
    this.#hider.dispose();
    this.#menu.dispose();
    const target = this.#window as Window & {
      __codexhostProjectGroupsV1?: RendererProjectGroupsHandle;
    };
    if (target.__codexhostProjectGroupsV1 === this) delete target.__codexhostProjectGroupsV1;
    this.#picker.dispose();
    this.#dialog.close();
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
    this.#window.addEventListener(PROVIDER_ICON_LOADED_EVENT, this.#onFocus);
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
      if (this.#menu.isOpen() || this.#menuPending) return;
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
    const catalog = this.#catalog;
    if (!catalog) return;
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
      threadsByProject,
      machineState,
    });
    const hidden = this.#views.flatMap((view) =>
      view.projects.flatMap((project) =>
        project.project.entry?.native ? [project.project.entry.projectId] : [],
      ),
    );
    this.#hider.apply(section, hidden);
    this.#view.render(this.#views, {
      collapsedGroups: this.#collapsed,
      menuAvailable: this.#menuEnabled(),
      threadActionsAvailable: this.#threadActionsEnabled(),
    });
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
      menu: this.#lastMenuMode === "unknown" ? this.#defaultMenuMode() : this.#lastMenuMode,
      threadActions: this.#threadActionsEnabled() ? "native" : "unavailable",
    };
    this.#publishStatus();
  }

  #toggleGroup(groupId: string): void {
    if (this.#collapsed.has(groupId)) this.#collapsed.delete(groupId);
    else this.#collapsed.add(groupId);
    this.#view.render(this.#views, {
      collapsedGroups: this.#collapsed,
      menuAvailable: this.#menuEnabled(),
      threadActionsAvailable: this.#threadActionsEnabled(),
    });
  }

  #openThread(thread: ThreadSnapshot): void {
    const section = findProjectsSection(this.#document);
    const row = section ? findNativeThreadRow(section, thread.threadId, thread.hostId) : null;
    if (!row) {
      void this.refresh();
      return;
    }
    const scroll = sidebarScrollContainer(this.#document);
    const top = scroll?.scrollTop ?? null;
    row.click();
    if (top !== null)
      restoreSidebarScrollAfterThreadClick({
        document: this.#document,
        window: this.#window,
        target: row,
        top,
      });
  }

  #menuEnabled(): boolean {
    return this.#hasThreadActions || this.#hasContextMenu;
  }

  #defaultMenuMode(): RendererProjectGroupsStatus["menu"] {
    if (this.#hasThreadActions) return "proxy-menu";
    if (this.#hasContextMenu) return "native-context";
    return "unavailable";
  }

  #setMenuMode(mode: RendererProjectGroupsStatus["menu"]): void {
    this.#lastMenuMode = mode;
    this.#status = { ...this.#status, menu: mode };
    this.#publishStatus();
  }

  #onNativeContextUnsupported(reason: string): void {
    if (this.#nativeContextUnsupported) return;
    this.#nativeContextUnsupported = true;
    this.#recordError(new Error(reason));
    this.#setMenuMode(this.#defaultMenuMode());
  }

  async #openThreadMenu(
    thread: ThreadSnapshot,
    anchor: HTMLElement,
    nativeFirst = false,
  ): Promise<void> {
    if (this.#menu.isOpen() || this.#threadMenu.isOpen()) return;
    const section = findProjectsSection(this.#document);
    const row = section ? findNativeThreadRow(section, thread.threadId, thread.hostId) : null;
    if (!row) {
      await this.refresh();
      return;
    }
    if (nativeFirst && !this.#nativeContextUnsupported) {
      this.#menuPending = true;
      try {
        if (await this.#menu.open(row, anchor)) {
          this.#setMenuMode("native-context");
          return;
        }
        this.#nativeContextUnsupported = true;
      } finally {
        this.#menuPending = false;
      }
    }
    const actions = collectNativeThreadMenuActions(row);
    if (actions.length === 0) {
      this.#setMenuMode("unavailable");
      this.#notify("该对话没有可用的原生操作。");
      return;
    }
    this.#threadMenu.open(anchor, actions, (action) => {
      action.button.click();
      this.#scheduleRefresh(200);
    });
    this.#setMenuMode("proxy-menu");
  }

  #threadActionsEnabled(): boolean {
    return !this.#threadActionsUnsupported && this.#hasThreadActions;
  }

  #onThreadActionsUnsupported(reason: string): void {
    if (this.#threadActionsUnsupported) return;
    this.#threadActionsUnsupported = true;
    this.#recordError(new Error(reason));
    this.#status = { ...this.#status, threadActions: "unavailable" };
    this.#publishStatus();
    this.#view.render(this.#views, {
      collapsedGroups: this.#collapsed,
      menuAvailable: this.#menuEnabled(),
      threadActionsAvailable: this.#threadActionsEnabled(),
    });
    if (!this.#lastThreadActionNotice) {
      this.#lastThreadActionNotice = true;
      this.#notify("该 Desktop 版本无法直接代理置顶/归档，已隐藏快捷按钮。");
    }
  }

  async #proxyThreadAction(thread: ThreadSnapshot, action: "pin" | "archive"): Promise<void> {
    const section = findProjectsSection(this.#document);
    const row = section ? findNativeThreadRow(section, thread.threadId, thread.hostId) : null;
    const button = row ? nativeThreadActionButton(row, action) : null;
    if (!button) {
      this.#onThreadActionsUnsupported("native-thread-action-missing");
      return;
    }
    button.click();
    this.#scheduleRefresh(200);
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

  #showAll(projectId: string): void {
    const section = findProjectsSection(this.#document);
    if (!section) return;
    const unit = projectUnitForId(section, projectId);
    if (!unit) return;
    const toggle = showAllToggle(unit);
    if (!toggle) {
      this.#notify("该项目没有原生的「查看全部」控制。");
      return;
    }
    toggle.click();
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
