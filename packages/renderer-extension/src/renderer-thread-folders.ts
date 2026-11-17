import {
  DESKTOP_PROJECTS_CATALOG_METHOD,
  THREAD_FOLDERS_GET_METHOD,
  THREAD_FOLDERS_SET_METHOD,
  desktopProjectsCatalogSchema,
  threadFoldersGetResultSchema,
  threadFoldersSelectionSchema,
} from "@codexhost/shared-contracts";
import { findScopedDraftModelBinding } from "@codexhost/desktop-control/renderer-bindings";
import {
  createThreadFoldersControl,
  updateThreadFoldersNote,
  type ThreadFoldersView,
} from "./renderer-thread-folders-control.js";
import { readComposerProject } from "./renderer-project-mirror-model.js";
import { pickDesktopFolders } from "./renderer-folder-picker.js";

interface FolderContext {
  hostId: string | null;
  target: readonly unknown[] | null;
  agent: string;
}
const drafts = new Map<string, string[]>();
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function mountRendererThreadFolders(composer: Element, context: () => FolderContext) {
  const d = composer.ownerDocument;
  let generation = 0;
  let currentKey = "";
  let disposed = false;
  const notes = d.createElement("div");
  notes.className = "codexhost-folders-note";
  notes.setAttribute("role", "status");
  notes.hidden = true;
  const identity = () => {
    const current = context();
    const id = typeof current.target?.[1] === "string" ? current.target[1] : null;
    if (!current.hostId || !id) throw new Error("无法确定当前对话与机器，请稍后重试");
    const route = window.__codexhostHostRoutingV1?.forHost(current.hostId);
    if (!route) throw new Error("这台机器尚未连接");
    return {
      ...current,
      hostId: current.hostId,
      id,
      route,
      existing: current.target?.[0] === "conversation",
      key: `${current.hostId}\0${id}`,
    };
  };
  const placeNote = () => {
    let scope = composer.parentElement;
    for (let depth = 0; scope && depth < 10; depth += 1, scope = scope.parentElement) {
      const turns = scope.querySelectorAll("[data-turn-key]");
      const last = turns.item(turns.length - 1);
      if (last) {
        last.after(notes);
        return;
      }
    }
    composer.before(notes);
  };
  const load = async (): Promise<ThreadFoldersView> => {
    const current = identity();
    const [state, catalog] = await Promise.all([
      Promise.resolve(
        current.route.manager.sendRequest(
          THREAD_FOLDERS_GET_METHOD,
          current.existing ? { threadId: current.id } : { harnessId: current.agent },
        ),
      ).then((value) => threadFoldersGetResultSchema.parse(value)),
      Promise.resolve(
        window.__codexhostHostRoutingV1
          ?.forHost("local")
          ?.manager.sendRequest(DESKTOP_PROJECTS_CATALOG_METHOD, {}),
      )
        .then((value) => desktopProjectsCatalogSchema.parse(value))
        .catch(() => null) ?? null,
    ]);
    const selected =
      readComposerProject(composer) ??
      (current.existing
        ? (() => {
            const assignment = catalog?.threadProjectAssignments[current.id];
            return assignment
              ? { type: assignment.projectKind, projectId: assignment.projectId }
              : null;
          })()
        : catalog?.selectedProject);
    const projectFolders = !selected
      ? []
      : selected.type === "local"
        ? (catalog?.localProjects[selected.projectId]?.rootPaths ?? [])
        : (() => {
            const p = catalog?.remoteProjects.find(
              (project) => project.id === selected.projectId && project.hostId === current.hostId,
            );
            return p ? [p.remotePath] : [];
          })();
    let folders = state.selection?.folders ?? drafts.get(current.key);
    if (!folders && current.existing) {
      const value = await current.route.manager.sendRequest("thread/read", {
        threadId: current.id,
        includeTurns: false,
      });
      const thread = record(value) && record(value.thread) ? value.thread : null;
      const environment =
        thread && Array.isArray(thread.environments) && record(thread.environments[0])
          ? thread.environments[0]
          : null;
      const cwd = environment?.cwd ?? thread?.cwd;
      const roots = environment?.runtimeWorkspaceRoots;
      if (typeof cwd === "string")
        folders = [
          cwd,
          ...(Array.isArray(roots)
            ? roots.filter((root): root is string => typeof root === "string" && root !== cwd)
            : []),
        ];
    }
    if (disposed || identity().key !== current.key)
      throw new Error("对话已切换，请重新打开工作文件夹");
    const workspaces: unknown = Reflect.get(window, "__codexhostDraftWorkspacesV1");
    const workspace = record(workspaces) ? workspaces[current.hostId] : null;
    folders ??= projectFolders.length
      ? [...projectFolders]
      : typeof workspace === "string"
        ? [workspace]
        : [];
    const lastNote = state.selection?.notes.at(-1);
    if (lastNote) updateThreadFoldersNote(notes, folders);
    notes.hidden = !lastNote;
    placeNote();
    return {
      folders,
      projectFolders,
      recent: state.recent,
      existing: current.existing,
      remote: current.hostId !== "local",
      machine:
        current.hostId === "local"
          ? "本机"
          : (catalog?.codexManagedRemoteConnections.find(
              (connection) => connection.hostId === current.hostId,
            )?.displayName ?? current.hostId),
      additionalDirectories: state.additionalDirectories,
    };
  };
  const control = createThreadFoldersControl({
    document: d,
    load,
    async pickLocal() {
      const current = identity();
      if (current.hostId !== "local") return [];
      const picked = await pickDesktopFolders(window);
      return disposed || identity().key !== current.key ? [] : picked;
    },
    async save(folders) {
      const current = identity();
      if (current.existing) {
        const selection = threadFoldersSelectionSchema.parse(
          await current.route.manager.sendRequest(THREAD_FOLDERS_SET_METHOD, {
            threadId: current.id,
            folders,
          }),
        );
        if (disposed || identity().key !== current.key) return;
        updateThreadFoldersNote(notes, selection.folders);
        notes.hidden = false;
        placeNote();
      } else {
        if (!current.route.policy.selectWorkingFolders)
          throw new Error("当前 Desktop 版本的工作文件夹绑定不可用");
        const binding = findScopedDraftModelBinding(composer, current.id);
        current.route.policy.selectWorkingFolders(current.id, folders, binding?.creationModes);
        drafts.set(current.key, [...folders]);
      }
    },
    async list(path) {
      const current = identity();
      const value = await current.route.manager.sendRequest("fs/readDirectory", { path });
      if (!record(value) || !Array.isArray(value.entries)) throw new Error("机器未返回目录列表");
      const separator = path.includes("\\") ? "\\" : "/";
      return value.entries
        .filter(
          (entry) =>
            record(entry) &&
            entry.isDirectory === true &&
            typeof entry.fileName === "string" &&
            !/[\\/]/u.test(entry.fileName),
        )
        .map(
          (entry) =>
            `${path.replace(/[\\/]+$/u, "")}${separator}${(entry as { fileName: string }).fileName}`,
        )
        .sort();
    },
    async validate(path) {
      const value = await identity().route.manager.sendRequest("fs/getMetadata", { path });
      if (!record(value) || value.isDirectory !== true) throw new Error("请选择存在的文件夹");
    },
  });
  return {
    refresh() {
      if (disposed) return;
      const above = composer.querySelector("[data-above-composer-portal]");
      if (!control.root.isConnected) {
        if (above) above.append(control.root);
        else composer.prepend(control.root);
      }
      if (!notes.isConnected) placeNote();
      const c = context();
      const key = JSON.stringify([c.hostId, c.target, c.agent]);
      if (key === currentKey) return;
      currentKey = key;
      control.reset();
      const attempt = ++generation;
      void load()
        .then((view) => {
          if (!disposed && attempt === generation)
            control.updateChip(view.folders, view.additionalDirectories);
        })
        .catch(() => {
          if (!disposed && attempt === generation)
            control.trigger.title = "无法读取工作文件夹，请检查连接后重试";
        });
    },
    dispose() {
      disposed = true;
      ++generation;
      control.dispose();
      notes.remove();
    },
  };
}
