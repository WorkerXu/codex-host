export const folderIcon =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true"><path d="M2.5 6V4.5a1 1 0 0 1 1-1h4L9 5h7.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6Z"/></svg>';

/** The same bounded directory subview serves working-folder additions and clone destinations. */
export function mountFolderBrowser(
  container: HTMLElement,
  options: {
    path: string;
    remote: boolean;
    action?: string;
    active(): boolean;
    back(): void;
    list(path: string): Promise<string[]>;
    choose(path: string): Promise<void>;
  },
) {
  const d = container.ownerDocument;
  let generation = 0,
    busy = false;
  const form = d.createElement("form");
  form.className = "codexhost-folders-path";
  const back = d.createElement("button");
  back.type = "button";
  back.className = "codexhost-folders-back";
  back.setAttribute("aria-label", "返回工作文件夹");
  back.innerHTML =
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m11.5 5-5 5 5 5"/></svg>';
  back.addEventListener("click", () => {
    if (!busy) {
      ++generation;
      options.back();
    }
  });
  const input = d.createElement("input");
  input.value = options.path;
  input.placeholder = "输入绝对路径…";
  input.setAttribute("aria-label", options.remote ? "远程文件夹路径" : "文件夹路径");
  const add = d.createElement("button");
  add.type = "submit";
  add.className = "codexhost-folders-primary";
  add.textContent = options.action ?? "添加";
  const status = d.createElement("div");
  status.className = "codexhost-folders-hint";
  status.setAttribute("role", "status");
  const children = d.createElement("div");
  children.className = "codexhost-folders-children";
  children.setAttribute("aria-label", "子文件夹");
  const active = () => form.isConnected && options.active();
  const path = () => {
    const raw = input.value.trim();
    return /^[A-Za-z]:[\\/]+$/u.test(raw) ? raw : raw.replace(/[\\/]+$/u, "") || "/";
  };
  const list = async () => {
    const attempt = ++generation;
    children.replaceChildren();
    status.className = "codexhost-folders-hint";
    status.setAttribute("role", "status");
    add.disabled = !input.value.trim();
    status.textContent = add.disabled ? "输入文件夹的绝对路径" : "正在读取目录…";
    if (add.disabled) return;
    try {
      const paths = await options.list(path());
      if (!active() || attempt !== generation) return;
      status.textContent = paths.length ? "" : "此文件夹没有子文件夹";
      for (const child of paths) {
        const row = d.createElement("button");
        row.type = "button";
        row.className = "codexhost-folders-directory";
        row.title = child;
        row.setAttribute("aria-label", child);
        row.innerHTML = folderIcon;
        const name = d.createElement("span");
        name.textContent = child.split(/[\\/]/u).filter(Boolean).at(-1) ?? child;
        row.append(name);
        row.addEventListener("click", () => {
          input.value = child;
          void list();
          input.focus();
        });
        children.append(row);
      }
    } catch {
      if (active() && attempt === generation)
        status.textContent = "无法读取此目录，请检查路径与连接";
    }
  };
  input.addEventListener("input", () => {
    void list();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || add.disabled) return;
    busy = true;
    ++generation;
    input.disabled = add.disabled = back.disabled = true;
    children.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.disabled = true;
    });
    status.textContent = "正在确认文件夹…";
    void options
      .choose(path())
      .catch((error: unknown) => {
        if (active()) {
          status.className = "codexhost-folders-error";
          status.setAttribute("role", "alert");
          status.textContent =
            error instanceof Error ? error.message : "无法添加文件夹，请确认路径可用后重试";
        }
      })
      .finally(() => {
        busy = false;
        if (active()) {
          input.disabled = add.disabled = back.disabled = false;
          children.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
            b.disabled = false;
          });
          input.focus();
        }
      });
  });
  form.append(back, input, add);
  container.replaceChildren(form, status, children);
  input.focus();
  void list();
}
