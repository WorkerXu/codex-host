import type { ModelProvider, ModelServiceSettings } from "@codexhost/shared-contracts";
import { modelServiceErrorText, type RendererModelServiceClient } from "../model-service-client.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import { agentMenuFocusIndex, agentMenuPlacement } from "./agent-card-menu.js";
import { createRendererSettingsIcon } from "./icons.js";
import { createPreferenceGroup, createPreferenceItem } from "./preference-ui.js";

const MODELS = [
  { value: "openai", label: "OpenAI · gpt-4.1-mini" },
  { value: "gemini", label: "Gemini · gemini-3.5-flash-lite" },
] as const;

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
  modelRow.description.setAttribute("role", "status");
  const trigger = button(document, "");
  trigger.id = "model-service-provider";
  trigger.className =
    "flex min-w-0 shrink-0 items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-[13px] leading-5 text-settings-text hover:bg-settings-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:opacity-40";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "解析模型");
  const menu = document.createElement("div");
  menu.id = "model-service-model-menu";
  menu.className =
    "fixed z-[90] m-0 w-[296px] max-w-[calc(100vw-16px)] rounded-xl border border-settings-border bg-[var(--color-token-dropdown-background)] p-1 text-settings-text shadow-[var(--shadow-dropdown-overlay)]";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "解析模型");
  trigger.setAttribute("aria-controls", menu.id);
  section.append(menu);
  const choices = MODELS.map((model) => {
    const choice = button(document, model.label);
    choice.className =
      "flex h-9 w-full items-center justify-between gap-3 rounded-lg border-0 bg-transparent px-2 text-left text-[13px] text-settings-text hover:bg-settings-hover focus-visible:bg-settings-hover focus-visible:outline-none";
    choice.setAttribute("role", "menuitemradio");
    choice.dataset.value = model.value;
    choice.addEventListener("click", () => {
      closeMenu(true);
      void choose(model.value);
    });
    menu.append(choice);
    return choice;
  });
  let choosing = false;
  const renderModel = () => {
    const value = settings?.provider ?? "openai";
    trigger.replaceChildren(
      (MODELS.find((model) => model.value === value) ?? MODELS[0]).label,
      createRendererSettingsIcon("chevron-down", 14),
    );
    trigger.dataset.value = value;
    trigger.disabled = !settings || choosing;
    choices.forEach((choice, index) => {
      const model = MODELS[index];
      if (!model) return;
      const selected = model.value === value;
      choice.setAttribute("aria-checked", String(selected));
      choice.replaceChildren(model.label);
      if (selected) choice.append(createRendererSettingsIcon("check", 14));
    });
  };
  const closeMenu = (restoreFocus = false) => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  };
  const openMenu = () => {
    if (trigger.disabled) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const rect = menu.getBoundingClientRect();
    const placement = agentMenuPlacement({
      anchor: trigger.getBoundingClientRect(),
      viewport: { width: view.innerWidth, height: view.innerHeight },
      menu: rect,
    });
    menu.style.top = `${placement.top}px`;
    menu.style.left = `${placement.left}px`;
    choices.find((choice) => choice.dataset.value === settings?.provider)?.focus();
  };
  const choose = async (provider: ModelProvider) => {
    if (!client || choosing || settings?.provider === provider) return;
    choosing = true;
    modelRow.description.textContent = "";
    modelRow.description.dataset.invalid = "false";
    renderModel();
    try {
      const result = await client.update({ provider });
      if (alive()) settings = result;
    } catch {
      if (alive()) {
        modelRow.description.textContent = "模型选择未保存，请重试";
        modelRow.description.dataset.invalid = "true";
      }
    } finally {
      choosing = false;
      if (alive()) {
        refresh();
        trigger.focus();
      }
    }
  };
  trigger.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu();
    }
  });
  view.addEventListener(
    "keydown",
    (event) => {
      if (menu.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMenu(true);
      } else if (event.key === "Tab") closeMenu(true);
    },
    { capture: true, signal: context.signal },
  );
  menu.addEventListener("keydown", (event) => {
    const current = choices.indexOf(
      (menu.getRootNode() as ShadowRoot).activeElement as HTMLButtonElement,
    );
    const next = agentMenuFocusIndex(current, event.key, choices.length);
    if (next !== null) {
      event.preventDefault();
      choices[next]?.focus();
    }
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !menu.hidden &&
        !event.composedPath().includes(menu) &&
        !event.composedPath().includes(trigger)
      )
        closeMenu();
    },
    { capture: true, signal: context.signal },
  );
  document.addEventListener("scroll", () => closeMenu(), { capture: true, signal: context.signal });
  view.addEventListener("resize", () => closeMenu(), { signal: context.signal });
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
    menu.remove();
  };
  modelRow.item.append(trigger);
  card.append(modelRow.item);
  controls.push(renderModel);
  renderModel();
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
