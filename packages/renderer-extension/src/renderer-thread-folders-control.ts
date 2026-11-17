import css from "./renderer-thread-folders.css";

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
}

const folderIcon =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true"><path d="M2.5 6V4.5a1 1 0 0 1 1-1h4L9 5h7.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6Z"/></svg>';

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
  let browseGeneration = 0;
  let errorText = "";
  let revision = 0;
  const position = () => {
    if (!popover.matches(":popover-open")) return;
    const rect = trigger.getBoundingClientRect();
    popover.style.left = `${Math.max(12, Math.min(rect.left, d.documentElement.clientWidth - popover.offsetWidth - 12))}px`;
    popover.style.top = `${Math.max(12, rect.top - popover.offsetHeight - 8)}px`;
  };
  const resize = new ResizeObserver(position);
  resize.observe(popover);
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
    popover.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
  };
  const render = () => {
    if (!view || disposed) return;
    popover.replaceChildren();
    const title = d.createElement("h3");
    title.textContent = "工作文件夹";
    const hint = d.createElement("div");
    hint.className = "codexhost-folders-hint";
    hint.textContent = `${view.machine} · ${view.existing ? "从下一轮开始生效" : "用于这次新对话"}`;
    popover.append(title, hint);
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
      popover.append(heading);
      for (const path of folders) {
        const row = d.createElement("div");
        row.className = "codexhost-folders-row";
        const label = d.createElement("label");
        const checkbox = d.createElement("input");
        checkbox.type = "checkbox";
        checkbox.disabled = busy;
        checkbox.checked = selected.includes(path);
        const text = d.createElement("span");
        text.textContent = path;
        text.title = path;
        checkbox.setAttribute("aria-label", path);
        checkbox.addEventListener("change", () => {
          selected = checkbox.checked
            ? [...selected, path]
            : selected.filter((item) => item !== path);
          render();
          popover.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
            if (input.getAttribute("aria-label") === path) input.focus();
          });
        });
        label.append(checkbox, text);
        row.append(label);
        if (path === selected[0]) {
          const main = d.createElement("span");
          main.className = "codexhost-folders-main";
          main.textContent = "主要";
          row.append(main);
        } else if (selected.includes(path))
          row.append(
            button("设为主要", () => {
              selected = [path, ...selected.filter((item) => item !== path)];
              render();
              popover.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
            }),
          );
        popover.append(row);
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
    const browse = d.createElement("div");
    const addPath = async (path: string) => {
      await options.validate(path);
      if (disposed) return;
      if (!selected.includes(path)) selected.push(path);
      errorText = "";
      render();
    };
    const openBrowser = async () => {
      if (!view) return;
      if (!view.remote && options.pickLocal) {
        try {
          const picked = await options.pickLocal();
          if (picked) {
            for (const path of picked) await addPath(path);
            return;
          }
        } catch (error) {
          errorText = error instanceof Error ? error.message : String(error);
          render();
          return;
        }
      }
      browse.replaceChildren();
      const form = d.createElement("form");
      form.className = "codexhost-folders-path";
      const input = d.createElement("input");
      input.setAttribute("aria-label", view.remote ? "远程文件夹路径" : "文件夹路径");
      input.placeholder = "输入绝对路径…";
      input.value = selected[0] ?? view.projectFolders[0] ?? "/";
      const suggestions = d.createElement("div");
      suggestions.setAttribute("aria-label", "子文件夹");
      const list = async () => {
        const generation = ++browseGeneration;
        const typed = input.value;
        const separator = Math.max(typed.lastIndexOf("/"), typed.lastIndexOf("\\"));
        const parent =
          typed.endsWith("/") || typed.endsWith("\\")
            ? typed
            : typed.slice(0, separator + 1) || "/";
        try {
          const children = await options.list(parent);
          if (generation !== browseGeneration || disposed) return;
          suggestions.replaceChildren();
          for (const path of children
            .filter((path) => path.toLowerCase().startsWith(typed.toLowerCase()))
            .slice(0, 40)) {
            const row = button(path, () => {
              input.value = path.replace(/[\\/]+$/u, "") + (path.includes("\\") ? "\\" : "/");
              void list();
              input.focus();
            });
            row.style.cssText =
              "display:block;text-align:left;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
            suggestions.append(row);
          }
        } catch (error) {
          if (generation === browseGeneration) {
            suggestions.textContent = `无法列出目录：${error instanceof Error ? error.message : String(error)}`;
          }
        }
      };
      input.addEventListener("input", () => {
        void list();
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const rawPath = input.value.trim();
        const folderPath = /^[A-Za-z]:[\\/]+$/u.test(rawPath)
          ? rawPath
          : rawPath.replace(/[\\/]+$/u, "") || "/";
        void addPath(folderPath).catch((error) => {
          errorText = error instanceof Error ? error.message : String(error);
          const line = browse.querySelector('[role="alert"]') ?? d.createElement("div");
          line.setAttribute("role", "alert");
          line.className = "codexhost-folders-error";
          line.textContent = errorText;
          browse.append(line);
        });
      });
      const add = button("添加", () => form.requestSubmit());
      form.append(input, add);
      browse.append(form, suggestions);
      input.focus();
      await list();
    };
    popover.append(
      button("添加文件夹…", () => {
        void openBrowser();
      }),
      browse,
    );
    if (errorText) {
      const error = d.createElement("div");
      error.className = "codexhost-folders-error";
      error.setAttribute("role", "alert");
      error.textContent = errorText;
      popover.append(error);
    }
    const footer = d.createElement("div");
    footer.className = "codexhost-folders-footer";
    const apply = button(
      busy ? "保存中…" : "应用",
      () => {
        if (busy || !selected.length) return;
        if (view && JSON.stringify(selected) === JSON.stringify(view.folders)) {
          close();
          return;
        }
        const attempt = revision;
        const saved = [...selected];
        const additional = view?.additionalDirectories ?? false;
        busy = true;
        errorText = "";
        render();
        void options
          .save(saved)
          .then(() => {
            if (!disposed && attempt === revision) {
              updateChip(saved, additional);
              close();
            }
          })
          .catch((error) => {
            if (attempt === revision)
              errorText = error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            if (attempt === revision) {
              busy = false;
              render();
            }
          });
      },
      "codexhost-folders-apply",
    );
    apply.disabled = busy || !selected.length;
    footer.append(button("取消", close), apply);
    popover.append(footer);
  };
  trigger.addEventListener("click", () => {
    if (popover.matches(":popover-open")) {
      close();
      return;
    }
    trigger.disabled = true;
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
        popover.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
      })
      .catch((error) => {
        trigger.title = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        trigger.disabled = false;
      });
  });
  // Keep Desktop's document listeners from treating a press inside this control as a Composer submission.
  popover.addEventListener("pointerdown", (event) => event.stopPropagation());
  popover.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  popover.addEventListener("toggle", () => {
    trigger.setAttribute("aria-expanded", String(popover.matches(":popover-open")));
  });
  return {
    root,
    trigger,
    updateChip,
    reset() {
      ++revision;
      busy = false;
      view = null;
      if (popover.matches(":popover-open")) popover.hidePopover();
    },
    dispose() {
      disposed = true;
      ++browseGeneration;
      ++revision;
      resize.disconnect();
      popover.remove();
      root.remove();
    },
  };
}
