import css from "./renderer-thread-folders.css";
import { folderIcon, mountFolderBrowser } from "./renderer-folder-browser.js";
export { folderIcon } from "./renderer-folder-browser.js";

export interface ThreadFoldersView {
  folders: string[];
  projectFolders: string[];
  recent: string[];
  remote: boolean;
  machine: string;
  existing: boolean;
  additionalDirectories: boolean;
}
export interface ThreadFoldersControlOptions {
  document: Document;
  load(): Promise<ThreadFoldersView>;
  save(folders: string[]): Promise<void>;
  list(path: string): Promise<string[]>;
  validate(path: string): Promise<void>;
  pickLocal?(): Promise<string[] | null>;
  fromRepository?(add: (path: string) => Promise<void>): Promise<void>;
}

function folderName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function folderPathLabel(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/u, "~");
}

function folderLabel(d: Document, path: string): HTMLElement {
  const text = d.createElement("span");
  text.className = "codexhost-folders-label";
  const name = d.createElement("span");
  name.textContent = folderName(path);
  const detail = d.createElement("span");
  detail.className = "codexhost-folders-detail";
  const abbreviated = folderPathLabel(path);
  const split = Math.max(abbreviated.lastIndexOf("/"), abbreviated.lastIndexOf("\\")) + 1;
  const parent = d.createElement("span");
  parent.className = "codexhost-folders-path-parent";
  parent.textContent = abbreviated.slice(0, Math.max(0, split - 1));
  const leaf = d.createElement("span");
  leaf.className = "codexhost-folders-path-leaf";
  leaf.textContent = abbreviated.slice(Math.max(0, split - 1));
  detail.append(parent, leaf);
  text.append(name, detail);
  return text;
}

export function updateThreadFoldersNote(note: HTMLElement, folders: string[]): void {
  const label = note.ownerDocument.createElement("span");
  label.className = "codexhost-folders-note-label";
  label.textContent = `工作文件夹已改为 ${folders.map((path, index) => `${folderName(path)}${index === 0 ? "（主要）" : ""}`).join("、")}`;
  note.replaceChildren(label);
  note.title = folders.join("\n");
}

export function createThreadFoldersControl(options: ThreadFoldersControlOptions) {
  const d = options.document;
  if (!d.querySelector("[data-codexhost-folders-style]")) {
    const style = d.createElement("style");
    style.dataset.codexhostFoldersStyle = "";
    style.textContent = css;
    d.head.append(style);
  }
  const root = d.createElement("div");
  root.dataset.codexhostThreadFolders = "";
  const trigger = d.createElement("button");
  trigger.type = "button";
  trigger.className = "codexhost-folders-chip";
  trigger.innerHTML = `${folderIcon}<span>工作文件夹</span>`;
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  root.append(trigger);
  const popover = d.createElement("div");
  popover.className = "codexhost-folders-popover";
  popover.popover = "auto";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "工作文件夹");
  d.body.append(popover);
  let view: ThreadFoldersView | null = null;
  let selected: string[] = [];
  let disposed = false;
  let busy = false;
  let browsing = false;
  let errorText = "";
  let revision = 0;
  const position = () => {
    if (!popover.matches(":popover-open")) return;
    const rect = trigger.getBoundingClientRect();
    popover.style.left = `${Math.max(12, Math.min(rect.left, d.documentElement.clientWidth - popover.offsetWidth - 12))}px`;
    popover.style.maxHeight = `min(420px, calc(100dvh - 120px), ${Math.max(0, rect.top - 20)}px)`;
    popover.style.top = `${Math.max(12, rect.top - popover.offsetHeight - 8)}px`;
  };
  const resize = new ResizeObserver(position);
  resize.observe(popover);
  d.defaultView?.addEventListener("resize", position);
  d.addEventListener("scroll", position, true);
  const button = (text: string, action: () => void, className = "codexhost-folders-action") => {
    const b = d.createElement("button");
    b.type = "button";
    b.className = className;
    b.textContent = text;
    b.disabled = busy;
    b.addEventListener("click", action);
    return b;
  };
  const updateChip = (folders: string[], additionalDirectories = true) => {
    const name = folders[0]?.split(/[\\/]/u).filter(Boolean).at(-1) ?? folders[0];
    const chipLabel = trigger.querySelector("span");
    if (chipLabel)
      chipLabel.textContent = `工作文件夹${name ? ` · ${name}${folders.length > 1 ? ` +${folders.length - 1}` : ""}` : ""}`;
    trigger.title = [
      ...folders,
      ...(!additionalDirectories ? ["此智能体仅使用主要文件夹，其他文件夹不会传给它。"] : []),
    ].join("\n");
  };
  const close = () => {
    browsing = false;
    ++revision;
    busy = false;
    popover.removeAttribute("aria-busy");
    popover.hidePopover();
    trigger.disabled = false;
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
  };
  const applySelection = async (folders: string[], focusPath?: string) => {
    if (busy || !view || !folders.length || disposed) return false;
    const attempt = revision;
    busy = true;
    trigger.disabled = true;
    popover.setAttribute("aria-busy", "true");
    errorText = "";
    render();
    try {
      await options.save([...folders]);
      if (disposed || attempt !== revision) return false;
      selected = [...folders];
      view.folders = [...folders];
      updateChip(folders, view.additionalDirectories);
      return true;
    } catch {
      if (attempt === revision) errorText = "未能保存工作文件夹，请重试";
      return false;
    } finally {
      if (!disposed && attempt === revision) {
        busy = false;
        trigger.disabled = false;
        popover.removeAttribute("aria-busy");
        render();
        if (focusPath) {
          const target = [
            ...popover.querySelectorAll<HTMLButtonElement>("[role=menuitemcheckbox]"),
          ].find((item) => item.getAttribute("aria-label") === focusPath);
          (target ?? popover.querySelector<HTMLButtonElement>(".codexhost-folders-add"))?.focus();
        }
      }
    }
  };
  const returnToMain = (path?: string) => {
    browsing = false;
    render();
    const target = path
      ? [...popover.querySelectorAll<HTMLButtonElement>("[role=menuitemcheckbox]")].find(
          (item) => item.getAttribute("aria-label") === path,
        )
      : popover.querySelector<HTMLButtonElement>(".codexhost-folders-add");
    if (target && !target.disabled) target.focus();
    else popover.querySelector<HTMLButtonElement>(".codexhost-folders-add")?.focus();
  };
  const render = () => {
    if (disposed || browsing) return;
    delete popover.dataset.codexhostFoldersBrowser;
    popover.replaceChildren();
    const title = d.createElement("h3");
    title.textContent = "工作文件夹";
    popover.append(title);
    if (!view) {
      const status = d.createElement("div");
      status.className = errorText ? "codexhost-folders-error" : "codexhost-folders-hint";
      status.setAttribute("role", errorText ? "alert" : "status");
      status.textContent = errorText || "正在读取文件夹…";
      popover.append(status);
      return;
    }
    if (!selected.length && !view.projectFolders.length && !view.recent.length) {
      const empty = d.createElement("div");
      empty.className = "codexhost-folders-hint";
      empty.textContent = "添加文件夹，开始这次对话";
      popover.append(empty);
    }
    if (!view.additionalDirectories) {
      const hint = d.createElement("div");
      hint.className = "codexhost-folders-hint";
      hint.textContent = "此智能体仅使用主要文件夹";
      popover.append(hint);
    }
    const section = (title: string, folders: string[]) => {
      if (!folders.length) return;
      const heading = d.createElement("div");
      heading.className = "codexhost-folders-heading";
      heading.textContent = title;
      const menu = d.createElement("div");
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", title);
      popover.append(heading, menu);
      for (const path of folders) {
        const row = d.createElement("div");
        row.className = "codexhost-folders-row";
        const checked = selected.includes(path);
        const choose = button(
          "",
          () => {
            void applySelection(
              checked ? selected.filter((item) => item !== path) : [...selected, path],
              path,
            );
          },
          "codexhost-folders-choice",
        );
        choose.setAttribute("role", "menuitemcheckbox");
        choose.setAttribute("aria-checked", String(checked));
        choose.setAttribute("aria-label", path);
        choose.disabled = busy || (checked && selected.length === 1);
        choose.title = path;
        const check = d.createElement("span");
        check.className = "codexhost-folders-check";
        if (checked)
          check.innerHTML =
            '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>';
        const text = folderLabel(d, path);
        choose.append(check, text);
        row.append(choose);
        if (path === selected[0]) {
          const main = d.createElement("span");
          main.className = "codexhost-folders-main";
          main.textContent = "主要";
          row.append(main);
        } else if (selected.includes(path))
          row.append(
            button("设为主要", () => {
              void applySelection([path, ...selected.filter((item) => item !== path)], path);
            }),
          );
        menu.append(row);
      }
    };
    section("当前文件夹", selected);
    section(
      "项目文件夹",
      view.projectFolders.filter((path) => !selected.includes(path)),
    );
    section(
      "最近使用",
      view.recent.filter(
        (path) => !selected.includes(path) && !view?.projectFolders.includes(path),
      ),
    );
    const openBrowser = async () => {
      if (!view || busy) return;
      const attempt = revision;
      const activeMenu = () =>
        !disposed && attempt === revision && popover.matches(":popover-open");
      if (!view.remote && options.pickLocal) {
        let picked: string[] | null = null;
        busy = true;
        trigger.disabled = true;
        render();
        try {
          picked = await options.pickLocal();
          if (!activeMenu()) return;
          if (picked !== null) {
            try {
              for (const path of picked) {
                await options.validate(path);
                if (!activeMenu()) return;
              }
            } catch {
              if (activeMenu()) errorText = "无法添加文件夹，请确认路径可用后重试";
              picked = [];
            }
          }
        } catch {
          // Unavailable native dialogs use the same browser as remote hosts.
        } finally {
          if (!disposed && attempt === revision) {
            busy = false;
            trigger.disabled = false;
            render();
          }
        }
        if (!activeMenu()) return;
        if (picked !== null) {
          const folders = [...new Set([...selected, ...picked])];
          if (folders.length !== selected.length) {
            const saved = await applySelection(folders, picked[0]);
            if (!saved && activeMenu())
              popover.querySelector<HTMLButtonElement>(".codexhost-folders-add")?.focus();
          } else popover.querySelector<HTMLButtonElement>(".codexhost-folders-add")?.focus();
          return;
        }
      }
      browsing = true;
      popover.dataset.codexhostFoldersBrowser = "";
      mountFolderBrowser(popover, {
        path: selected[0] ?? view.projectFolders[0] ?? "/",
        remote: view.remote,
        active: () => browsing && !disposed && attempt === revision,
        back: () => returnToMain(),
        list: options.list,
        async choose(path) {
          try {
            await options.validate(path);
          } catch {
            throw new Error("无法添加文件夹，请确认路径可用后重试");
          }
          if (disposed || attempt !== revision || !browsing) return;
          if (selected.includes(path) || (await applySelection([...selected, path], path)))
            returnToMain(path);
          else throw new Error(errorText);
        },
      });
    };
    const addFolder = button(
      "添加文件夹…",
      () => {
        void openBrowser();
      },
      "codexhost-folders-add",
    );
    addFolder.innerHTML = `${folderIcon}<span>添加文件夹…</span>`;
    popover.append(addFolder);
    if (options.fromRepository) {
      const addRepository = button(
        "从仓库添加…",
        () => {
          const folders = [...selected];
          const additionalDirectories = view?.additionalDirectories;
          close();
          void options.fromRepository?.(async (path) => {
            if (disposed) throw new Error("对话已关闭");
            const next = [...new Set([...folders, path])];
            await options.save(next);
            if (disposed) return;
            selected = next;
            updateChip(next, additionalDirectories);
          });
        },
        "codexhost-folders-add",
      );
      addRepository.innerHTML = `${folderIcon}<span>从仓库添加…</span>`;
      popover.append(addRepository);
    }
    if (errorText) {
      const error = d.createElement("div");
      error.className = "codexhost-folders-error";
      error.setAttribute("role", "alert");
      error.textContent = errorText;
      popover.append(error);
    }
  };
  trigger.addEventListener("click", () => {
    if (popover.matches(":popover-open")) {
      close();
      return;
    }
    trigger.disabled = true;
    view = null;
    errorText = "";
    render();
    popover.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    position();
    const attempt = ++revision;
    void options
      .load()
      .then((loaded) => {
        if (disposed || attempt !== revision) return;
        view = loaded;
        selected = [...loaded.folders];
        errorText = "";
        render();
        popover.showPopover();
        trigger.setAttribute("aria-expanded", "true");
        position();
        popover
          .querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]:not(:disabled)')
          ?.focus();
      })
      .catch(() => {
        if (disposed || attempt !== revision) return;
        errorText = "无法读取工作文件夹，请检查连接后重试";
        render();
      })
      .finally(() => {
        trigger.disabled = false;
      });
  });
  // Keep Desktop's document listeners from treating a press inside this control as a Composer submission.
  popover.addEventListener("pointerdown", (event) => event.stopPropagation());
  popover.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
      !(event.target as Element).closest("input")
    ) {
      const items = [...popover.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (!items.length) return;
      const current = items.indexOf(d.activeElement as HTMLButtonElement);
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      event.preventDefault();
      items[index]?.focus();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (browsing) returnToMain();
      else close();
    }
  });
  popover.addEventListener("toggle", () => {
    if (!popover.matches(":popover-open")) {
      browsing = false;
      ++revision;
      busy = false;
      popover.removeAttribute("aria-busy");
      trigger.disabled = false;
    }
    trigger.setAttribute("aria-expanded", String(popover.matches(":popover-open")));
  });
  return {
    root,
    trigger,
    updateChip,
    reset() {
      browsing = false;
      ++revision;
      busy = false;
      trigger.disabled = false;
      popover.removeAttribute("aria-busy");
      view = null;
      if (popover.matches(":popover-open")) popover.hidePopover();
    },
    dispose() {
      disposed = true;
      ++revision;
      resize.disconnect();
      d.defaultView?.removeEventListener("resize", position);
      d.removeEventListener("scroll", position, true);
      popover.remove();
      root.remove();
    },
  };
}
