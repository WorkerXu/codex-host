import type { CodeRepositoriesClient } from "../code-repositories-client.js";
import { repositoryErrorText } from "../code-repositories-client.js";
import type { RepositorySettings } from "@codexhost/shared-contracts";
import type { RendererSettingsPageMountContext } from "./core.js";
import { createPreferenceGroup, createPreferenceItem } from "./preference-ui.js";

export function mountCodeRepositoriesSection(
  context: RendererSettingsPageMountContext,
  client: CodeRepositoriesClient | null,
) {
  const d = context.content.ownerDocument;
  const { group, card } = createPreferenceGroup(d, "代码仓库");
  group.id = "code-repositories";
  context.content.append(group);
  const button = (label: string) => {
    const b = d.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.className =
      "shrink-0 rounded-md border border-settings-border bg-transparent px-3 py-1.5 text-xs text-settings-text hover:bg-settings-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:opacity-40";
    return b;
  };
  const gitlab = createPreferenceItem(d, {
    title: "GitLab 访问令牌",
    description: "正在读取…",
    controlId: "repository-token-edit",
  });
  gitlab.description.setAttribute("role", "status");
  const actions = d.createElement("div");
  actions.className = "flex shrink-0 items-center gap-2";
  const test = button("测试"),
    edit = button("添加"),
    clear = button("清除");
  edit.id = "repository-token-edit";
  actions.append(test, edit, clear);
  gitlab.item.append(actions);
  card.append(gitlab.item);
  const editor = d.createElement("form");
  editor.className = "flex items-center gap-2 px-4 pb-4";
  editor.hidden = true;
  const input = d.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.maxLength = 512;
  input.spellcheck = false;
  input.setAttribute("aria-label", "GitLab 访问令牌");
  input.placeholder = "输入访问令牌";
  input.className =
    "h-8 w-full min-w-0 rounded-md border border-settings-border bg-settings-panel px-3 text-[13px] text-settings-text placeholder:text-settings-muted focus-visible:outline-2 focus-visible:outline-settings-focus";
  const save = button("保存"),
    cancel = button("取消");
  save.type = "submit";
  editor.append(input, save, cancel);
  card.append(editor);
  const github = createPreferenceItem(d, {
    title: "GitHub",
    description: "正在读取…",
    controlId: "repository-github",
  });
  github.item.querySelector("label")?.removeAttribute("for");
  card.append(github.item);
  let settings: RepositorySettings | null = null,
    busy = false,
    editing = false,
    error = "",
    tested = false;
  const alive = () => !context.signal.aborted;
  const render = () => {
    gitlab.description.textContent =
      error ||
      (!settings
        ? "正在读取…"
        : settings.gitlab.configured
          ? `已配置 ···${settings.gitlab.lastFour ?? ""}${tested ? " · 连接成功" : ""}`
          : "未配置 · gitlab.xianghuanji.com");
    gitlab.description.dataset.invalid = String(!!error);
    edit.textContent = settings?.gitlab.configured ? "更换" : "添加";
    edit.setAttribute("aria-label", `${edit.textContent} GitLab 访问令牌`);
    edit.disabled = !settings || busy;
    test.disabled = !settings?.gitlab.configured || busy || editing;
    clear.disabled = busy;
    clear.hidden = !settings?.gitlab.configured || editing;
    edit.hidden = editing;
    editor.hidden = !editing;
    input.disabled = busy;
    save.disabled = busy || input.value.trim().length < 8;
    cancel.disabled = busy;
    github.description.textContent = settings
      ? settings.github.login
        ? `已登录 · ${settings.github.login}`
        : "未登录"
      : error
        ? "无法读取登录状态"
        : "正在读取…";
  };
  const run = async (action: "save" | "clear" | "test") => {
    if (!client || busy) return;
    busy = true;
    error = "";
    tested = false;
    render();
    if (action === "test") gitlab.description.textContent = "正在测试连接…";
    try {
      if (action === "test") {
        const result = await client.test();
        if (!alive()) return;
        tested = result.ok;
        if (!result.ok) error = repositoryErrorText(result.errorCode);
      } else {
        const result = await client.setToken(action === "clear" ? null : input.value.trim());
        input.value = "";
        if (!alive()) return;
        settings = result;
        editing = false;
      }
    } catch (e) {
      if (alive()) error = repositoryErrorText(e);
    } finally {
      busy = false;
      if (alive()) {
        render();
        if (action !== "test") edit.focus();
      }
    }
  };
  edit.addEventListener("click", () => {
    editing = true;
    error = "";
    render();
    input.focus();
  });
  const cancelEdit = () => {
    editing = false;
    input.value = "";
    render();
    edit.focus();
  };
  cancel.addEventListener("click", cancelEdit);
  d.defaultView?.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && editing && !busy && event.composedPath().includes(editor)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelEdit();
      }
    },
    { capture: true, signal: context.signal },
  );
  input.addEventListener("input", render);
  editor.addEventListener("submit", (e) => {
    e.preventDefault();
    void run("save");
  });
  clear.addEventListener("click", () => {
    void run("clear");
  });
  test.addEventListener("click", () => {
    void run("test");
  });
  context.signal.addEventListener(
    "abort",
    () => {
      input.value = "";
    },
    { once: true },
  );
  render();
  void client
    ?.settings()
    .then((value) => {
      if (alive()) {
        settings = value;
        render();
      }
    })
    .catch(() => {
      if (alive()) {
        error = "无法连接本机代码仓库服务";
        render();
      }
    });
  if (!client) {
    error = "无法连接本机代码仓库服务";
    render();
  }
}
