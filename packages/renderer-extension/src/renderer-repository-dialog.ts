import type {
  CodeRepository,
  RepositoryJob,
  RepositoryProvider,
} from "@codexhost/shared-contracts";
import { repositoryErrorText, type CodeRepositoriesClient } from "./code-repositories-client.js";
import css from "./renderer-repository-dialog.css";
import { mountFolderBrowser } from "./renderer-folder-browser.js";
import folderCss from "./renderer-thread-folders.css";

export interface RepositoryDialogOptions {
  document: Document;
  hostId: string;
  machine: string;
  client: CodeRepositoriesClient;
  pickLocal(): Promise<string[] | null>;
  add(path: string): Promise<void>;
}

export function openRepositoryDialog(options: RepositoryDialogOptions): Promise<void> {
  const d = options.document;
  const opener = d.activeElement as HTMLElement | null;
  if (!d.querySelector("[data-repository-dialog-style]")) {
    const style = d.createElement("style");
    style.dataset.repositoryDialogStyle = "";
    style.textContent = folderCss + css;
    d.head.append(style);
  }
  const dialog = d.createElement("dialog");
  dialog.className = "codexhost-repo-dialog";
  dialog.setAttribute("aria-label", "从仓库添加工作文件夹");
  d.body.append(dialog);
  let provider: RepositoryProvider = "github",
    generation = 0,
    disposed = false,
    busy = false;
  let repo: CodeRepository | null = null,
    parent = "",
    query = "",
    timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const button = (name: string, action: () => void, primary = false) => {
    const b = d.createElement("button");
    b.type = "button";
    b.textContent = name;
    b.className = primary ? "codexhost-repo-primary" : "codexhost-repo-quiet";
    b.addEventListener("click", action);
    return b;
  };
  const close = () => {
    if (busy) return;
    disposed = true;
    ++generation;
    clearTimeout(timer);
    clearTimeout(poll);
    dialog.close();
    dialog.remove();
    opener?.focus();
    finish();
  };
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  const header = (title: string) => {
    dialog.replaceChildren();
    const head = d.createElement("header"),
      heading = d.createElement("h2");
    heading.textContent = title;
    const cancel = button("关闭", close);
    cancel.disabled = busy;
    head.append(heading, cancel);
    dialog.append(head);
  };
  const message = (text: string, error = false) => {
    const node = d.createElement("p");
    node.className = "codexhost-repo-message";
    node.setAttribute("role", error ? "alert" : "status");
    node.textContent = text;
    dialog.append(node);
    return node;
  };
  const footer = (...buttons: HTMLButtonElement[]) => {
    const foot = d.createElement("footer");
    foot.append(...buttons);
    dialog.append(foot);
  };
  const showList = () => {
    clearTimeout(timer);
    ++generation;
    repo = null;
    header("从仓库添加");
    const tabs = d.createElement("div");
    tabs.className = "codexhost-repo-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "代码仓库来源");
    for (const name of ["github", "gitlab"] as const) {
      const tab = button(name === "github" ? "GitHub" : "GitLab", () => {
        provider = name;
        query = "";
        showList();
        tabsFor(name)?.focus();
      });
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(provider === name));
      tab.tabIndex = provider === name ? 0 : -1;
      tab.addEventListener("keydown", (e) => {
        if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
          e.preventDefault();
          provider = provider === "github" ? "gitlab" : "github";
          query = "";
          showList();
          tabsFor(provider)?.focus();
        }
      });
      tabs.append(tab);
    }
    dialog.append(tabs);
    const input = d.createElement("input");
    input.className = "codexhost-repo-search";
    input.type = "search";
    input.placeholder = "搜索我的仓库";
    input.setAttribute("aria-label", "搜索我的仓库");
    input.value = query;
    dialog.append(input);
    const list = d.createElement("div");
    list.className = "codexhost-repo-list";
    list.setAttribute("role", "region");
    list.setAttribute("aria-label", "仓库列表");
    dialog.append(list);
    const load = async () => {
      const attempt = ++generation;
      list.replaceChildren();
      list.setAttribute("aria-busy", "true");
      const status = d.createElement("p");
      status.className = "codexhost-repo-message";
      status.setAttribute("role", "status");
      status.textContent = "正在列出仓库…";
      list.append(status);
      try {
        const repos = await options.client.list(provider, query);
        if (disposed || attempt !== generation) return;
        list.replaceChildren();
        if (!repos.length) {
          status.textContent = query ? "没有找到匹配的仓库" : "暂无可添加的仓库";
          list.append(status);
        }
        for (const project of repos) {
          const row = button("", () => {
            repo = project;
            void showTarget();
          });
          row.className = "codexhost-repo-row";
          row.setAttribute("aria-label", `${project.namespace}/${project.name}`);
          const copy = d.createElement("span");
          copy.className = "codexhost-repo-copy";
          for (const [text, className] of [
            [project.name, "codexhost-repo-name"],
            [project.namespace, "codexhost-repo-meta"],
            [project.description, "codexhost-repo-description"],
          ] as const) {
            const line = d.createElement("span");
            line.className = className;
            line.textContent = text;
            line.title = text;
            copy.append(line);
          }
          const activity = d.createElement("time");
          const date = new Date(project.lastActivity);
          activity.textContent = Number.isNaN(date.getTime())
            ? ""
            : date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
          activity.title = `最近活动：${project.lastActivity}`;
          row.append(copy, activity);
          list.append(row);
        }
      } catch (error) {
        if (disposed || attempt !== generation) return;
        list.replaceChildren();
        status.textContent = repositoryErrorText(error);
        status.setAttribute("role", "alert");
        list.append(
          status,
          button("重试", () => {
            void load();
          }),
        );
      } finally {
        if (attempt === generation) list.removeAttribute("aria-busy");
      }
    };
    input.addEventListener("input", () => {
      query = input.value;
      clearTimeout(timer);
      ++generation;
      list.replaceChildren();
      list.setAttribute("aria-busy", "true");
      const searching = d.createElement("p");
      searching.className = "codexhost-repo-message";
      searching.setAttribute("role", "status");
      searching.textContent = "正在搜索仓库…";
      list.append(searching);
      timer = setTimeout(() => {
        void load();
      }, 250);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        list.querySelector<HTMLButtonElement>("button")?.focus();
      }
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(timer);
        void load();
      }
    });
    list.addEventListener("keydown", (e) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const rows = [...list.querySelectorAll<HTMLButtonElement>("button")];
      if (!rows.length) return;
      e.preventDefault();
      const current = rows.indexOf(d.activeElement as HTMLButtonElement);
      rows[
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? rows.length - 1
            : (current + (e.key === "ArrowUp" ? -1 : 1) + rows.length) % rows.length
      ]?.focus();
    });
    if (provider === "gitlab") message("gitlab.xianghuanji.com");
    void load();
  };
  const tabsFor = (name: string) =>
    [...dialog.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
      (tab) => tab.textContent === (name === "github" ? "GitHub" : "GitLab"),
    );
  const showTarget = async () => {
    if (!repo || disposed) return;
    const attempt = ++generation;
    header("选择克隆位置");
    message("正在读取目标位置…");
    try {
      const target = await options.client.target(options.hostId);
      if (disposed || attempt !== generation) return;
      parent = target.parent;
      renderTarget();
      if (options.hostId === "local") await chooseParent();
    } catch (error) {
      if (disposed || attempt !== generation) return;
      header("选择克隆位置");
      message(repositoryErrorText(error), true);
      footer(button("返回仓库", showList));
    }
  };
  const renderTarget = () => {
    if (!repo) return;
    header("选择克隆位置");
    const content = d.createElement("div");
    content.className = "codexhost-repo-target";
    const name = d.createElement("p");
    name.textContent = `${repo.namespace}/${repo.name}`;
    content.append(name);
    const pathRow = d.createElement("div");
    pathRow.className = "codexhost-repo-target-path";
    const path = d.createElement("span");
    path.textContent = parent;
    path.title = parent;
    pathRow.append(
      path,
      button("更改位置…", () => {
        void chooseParent();
      }),
    );
    content.append(pathRow);
    dialog.append(content);
    message(`将在${options.machine}创建 ${repo.name} 文件夹`);
    footer(
      button("返回仓库", showList),
      button(
        "克隆并添加",
        () => {
          void start();
        },
        true,
      ),
    );
    dialog.querySelector<HTMLButtonElement>(".codexhost-repo-target button")?.focus();
  };
  const chooseParent = async () => {
    if (options.hostId === "local") {
      try {
        const picked = await options.pickLocal();
        if (disposed) return;
        if (picked?.[0]) {
          parent = picked[0];
          renderTarget();
          return;
        }
        if (picked !== null) return;
      } catch {
        /* Native picker unavailable: use the directory browser. */
      }
    }
    header("选择文件夹");
    const container = d.createElement("div");
    container.className = "codexhost-repo-browser";
    dialog.append(container);
    const attempt = ++generation;
    mountFolderBrowser(container, {
      path: parent,
      remote: options.hostId !== "local",
      action: "选择",
      active: () => !disposed && attempt === generation,
      back: () => {
        ++generation;
        renderTarget();
      },
      list: async (path) => (await options.client.target(options.hostId, path)).children,
      async choose(path) {
        try {
          const result = await options.client.target(options.hostId, path);
          if (disposed || attempt !== generation) return;
          parent = result.parent;
          ++generation;
          renderTarget();
        } catch {
          throw new Error("无法读取此目录，请检查路径与连接");
        }
      },
    });
    container.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        ++generation;
        renderTarget();
      }
      if (
        ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
        !(event.target as Element).closest("input")
      ) {
        const items = [...container.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        if (!items.length) return;
        event.preventDefault();
        const i = items.indexOf(d.activeElement as HTMLButtonElement);
        items[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (i + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length
        ]?.focus();
      }
    });
  };
  const showProgress = (state: RepositoryJob["state"]) => {
    header("正在添加仓库");
    message(repo ? `${repo.namespace}/${repo.name}` : "");
    const steps = d.createElement("ol");
    steps.className = "codexhost-repo-progress";
    steps.setAttribute("role", "status");
    const current = state === "cloning" ? 1 : state === "transferring" ? 2 : 3;
    ["列出", "克隆", "传输", "完成"].forEach((text, index) => {
      const li = d.createElement("li");
      li.textContent = text;
      li.dataset.current = String(index === current);
      steps.append(li);
    });
    dialog.append(steps);
  };
  const finishJob = async (job: RepositoryJob) => {
    if (disposed) return;
    if (job.state === "conflict") {
      busy = false;
      header("目标目录已存在");
      message(job.path);
      message("是否直接使用已有文件夹？不会克隆或覆盖其中的内容。");
      footer(
        button("选择其他位置", renderTarget),
        button(
          "使用已有文件夹",
          () => {
            void add(job.path);
          },
          true,
        ),
      );
      return;
    }
    if (job.state === "error") {
      busy = false;
      header("未能添加仓库");
      message(repositoryErrorText(job.errorCode), true);
      footer(button("返回", renderTarget));
      return;
    }
    if (job.state === "complete") {
      await add(job.path);
      return;
    }
    showProgress(job.state);
    poll = setTimeout(() => {
      void options.client.job(job.id).then(finishJob).catch(failed);
    }, 500);
  };
  const failed = (error: unknown) => {
    if (disposed) return;
    busy = false;
    header("未能添加仓库");
    message(repositoryErrorText(error), true);
    footer(button("返回", renderTarget));
  };
  const add = async (path: string) => {
    busy = true;
    showProgress("complete");
    try {
      await options.add(path);
      busy = false;
      showProgress("complete");
      const title = dialog.querySelector("h2");
      if (title) title.textContent = "工作文件夹已添加";
      message(path);
      footer(button("完成", close, true));
      dialog.querySelector<HTMLButtonElement>(".codexhost-repo-primary")?.focus();
    } catch {
      busy = false;
      header("仓库已就绪");
      message("文件夹未能加入对话，请重试。仓库内容已保留。", true);
      footer(
        button(
          "重试添加",
          () => {
            void add(path);
          },
          true,
        ),
      );
    }
  };
  const start = async () => {
    if (!repo || busy) return;
    busy = true;
    showProgress("cloning");
    try {
      await finishJob(
        await options.client.clone({
          provider,
          repositoryId: repo.id,
          hostId: options.hostId,
          parent,
        }),
      );
    } catch (error) {
      failed(error);
    }
  };
  showList();
  dialog.showModal();
  return done;
}
