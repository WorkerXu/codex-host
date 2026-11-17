import type { ModelServiceSettings } from "@codexhost/shared-contracts";
import { modelServiceErrorText, type RendererModelServiceClient } from "../model-service-client.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import { createPreferenceGroup, createPreferenceItem } from "./preference-ui.js";

function button(document: Document, text: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.className =
    "shrink-0 rounded-md border border-settings-border bg-transparent px-3 py-1.5 text-xs leading-[18px] text-settings-text transition-colors hover:bg-settings-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:cursor-default disabled:opacity-40";
  return element;
}

export function mountModelServiceSection(
  context: RendererSettingsPageMountContext,
  client: RendererModelServiceClient | null,
): void {
  const document = context.content.ownerDocument;
  const view = document.defaultView;
  if (!view) return;
  const { group: section, card } = createPreferenceGroup(document, "模型服务");
  section.classList.add("settings-model-service");
  card.classList.add("settings-model-service__card");
  section.id = "model-service";
  context.content.append(section);
  let settings: ModelServiceSettings | null = null;
  let readFailed = false;
  const controls: (() => void)[] = [];
  const alive = () => !context.signal.aborted;
  const refresh = () => controls.forEach((render) => render());
  for (const provider of ["openai", "gemini"] as const) {
    const wrapper = document.createElement("div");
    wrapper.className = "border-t border-settings-divider first:border-t-0";
    wrapper.dataset.provider = provider;
    const name = provider === "openai" ? "OpenAI" : "Gemini";
    const row = createPreferenceItem(document, {
      title: `${name} API Key`,
      description: "正在读取…",
      controlId: `model-service-edit-${provider}`,
    });
    row.item.classList.remove("border-t", "first:border-t-0");
    row.description.classList.add("settings-model-service__status");
    row.description.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "flex shrink-0 items-center gap-2";
    const test = button(document, "测试");
    const edit = button(document, "添加");
    edit.id = `model-service-edit-${provider}`;
    const clear = button(document, "清除");
    clear.className =
      "shrink-0 rounded-md border-0 bg-transparent px-2 py-1.5 text-xs leading-[18px] text-settings-muted hover:bg-settings-hover hover:text-settings-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:opacity-40";
    actions.append(test, edit, clear);
    row.item.append(actions);
    const editor = document.createElement("form");
    editor.className = "flex items-center gap-2 px-4 pb-4";
    editor.hidden = true;
    editor.id = `model-service-editor-${provider}`;
    edit.setAttribute("aria-controls", editor.id);
    const input = document.createElement("input");
    input.id = `model-service-${provider}`;
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = 512;
    input.placeholder = "输入新的 API Key";
    input.setAttribute("aria-label", `${name} API Key`);
    input.className =
      "h-8 w-full min-w-0 rounded-md border border-settings-border bg-settings-panel px-3 text-[13px] text-settings-text placeholder:text-settings-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus";
    const save = button(document, "保存");
    save.type = "submit";
    const cancel = button(document, "取消");
    editor.append(input, save, cancel);
    wrapper.append(row.item, editor);
    card.append(wrapper);
    let editing = false;
    let busy: "save" | "clear" | "test" | null = null;
    let error: string | null = null;
    let latency: number | null = null;
    const render = () => {
      const key = settings?.[provider];
      const base = key?.configured ? `已配置 ···${key.lastFour ?? ""}` : "未配置";
      row.description.textContent =
        error ??
        (readFailed
          ? "无法连接本地模型服务，请稍后重试"
          : !settings
            ? "正在读取…"
            : `${base}${busy === "test" ? " · 正在测试…" : latency !== null ? ` · 连接成功 ${latency} 毫秒` : ""}`);
      row.description.dataset.invalid = String(error !== null || readFailed);
      edit.textContent = key?.configured ? "更换" : "添加";
      edit.setAttribute("aria-label", `${edit.textContent} ${name} API Key`);
      edit.hidden = editing;
      edit.disabled = !settings || busy !== null;
      edit.setAttribute("aria-expanded", String(editing));
      clear.hidden = !key?.configured || editing;
      clear.disabled = busy !== null;
      test.disabled = !key?.configured || editing || busy !== null;
      test.setAttribute("aria-busy", String(busy === "test"));
      editor.hidden = !editing;
      input.disabled = busy !== null;
      save.disabled = busy !== null || input.value.trim().length === 0;
      cancel.disabled = busy !== null;
    };
    controls.push(render);
    const cancelEdit = () => {
      editing = false;
      input.value = "";
      error = null;
      render();
      edit.focus();
    };
    edit.addEventListener("click", () => {
      editing = true;
      error = null;
      render();
      input.focus();
    });
    cancel.addEventListener("click", cancelEdit);
    input.addEventListener("input", render);
    view.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !editing || busy || !event.composedPath().includes(editor))
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelEdit();
      },
      { capture: true, signal: context.signal },
    );
    const run = async (action: "save" | "clear" | "test") => {
      if (busy || !client || !settings) return;
      busy = action;
      error = null;
      render();
      try {
        if (action === "test") {
          const result = await client.test(provider);
          if (!alive()) return;
          latency = result.ok ? (result.latencyMs ?? 0) : null;
          error = result.ok ? null : modelServiceErrorText(result.errorCode, provider);
        } else {
          const value = action === "clear" ? null : input.value.trim();
          if (value !== null && (value.length < 8 || /\s/u.test(value)))
            throw new Error("invalid_key");
          const result = await client.update({ key: { provider, value } });
          if (!alive()) return;
          settings = result;
          input.value = "";
          editing = false;
          latency = null;
        }
      } catch (caught) {
        if (alive())
          error = modelServiceErrorText(caught instanceof Error ? caught.message : null, provider);
      } finally {
        busy = null;
        if (alive()) {
          refresh();
          if (action === "save" && !editing) edit.focus();
          if (action === "clear" && !error) edit.focus();
        }
      }
    };
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      void run("save");
    });
    clear.addEventListener("click", () => {
      void run("clear");
    });
    test.addEventListener("click", () => {
      void run("test");
    });
    render();
  }

  const modelRow = createPreferenceItem(document, {
    title: "解析模型",
    description: "",
    controlId: "model-service-provider",
  });
  const modelLabel = modelRow.item.querySelector("label");
  modelLabel?.removeAttribute("for");
  modelLabel?.classList.remove("cursor-pointer");
  const model = document.createElement("span");
  model.id = "model-service-provider";
  model.className = "shrink-0 text-[13px] leading-5 text-settings-muted";
  model.textContent = "OpenAI · gpt-4.1-mini";
  context.signal.addEventListener(
    "abort",
    () => {
      inputCleanup();
    },
    { once: true },
  );
  const inputCleanup = () => {
    section.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
      input.value = "";
    });
  };
  modelRow.item.append(model);
  card.append(modelRow.item);
  void (client?.read() ?? Promise.reject(new Error("local_only")))
    .then((result) => {
      if (!alive()) return;
      settings = result;
      refresh();
    })
    .catch(() => {
      if (alive()) {
        readFailed = true;
        refresh();
      }
    });
}
