import type { ModelProvider, ModelServiceSettings } from "@codexhost/shared-contracts";
import { modelServiceErrorText, type RendererModelServiceClient } from "../model-service-client.js";
import type { RendererSettingsPageMountContext } from "./core.js";

export function mountModelServiceSection(
  context: RendererSettingsPageMountContext,
  client: RendererModelServiceClient | null,
): void {
  const document = context.content.ownerDocument;
  const section = document.createElement("section");
  section.className = "settings-model-service mb-8";
  section.id = "model-service";
  const heading = document.createElement("h3");
  heading.textContent = "模型服务";
  heading.className = "m-0 mb-4 text-[13px] leading-5 font-semibold text-settings-text";
  const notice = document.createElement("p");
  notice.className =
    "settings-model-service__notice m-0 mt-1 min-h-5 text-xs leading-5 text-settings-muted empty:hidden";
  notice.setAttribute("role", "status");
  notice.textContent = "正在读取…";
  section.append(heading, notice);
  context.content.append(section);
  let settings: ModelServiceSettings | null = null;
  const controls: (() => void)[] = [];
  const alive = () => !context.signal.aborted;
  const refresh = () => controls.forEach((render) => render());
  const errorText = (error: unknown, provider: ModelProvider) =>
    modelServiceErrorText(error instanceof Error ? error.message : null, provider);
  for (const provider of ["openai", "gemini"] as const) {
    const row = document.createElement("div");
    row.className = "settings-model-service__key mb-3";
    row.dataset.provider = provider;
    const label = document.createElement("label");
    label.className = "mb-2 block text-[13px] leading-5 text-settings-text";
    label.textContent = provider === "openai" ? "OpenAI API Key" : "Gemini API Key";
    const input = document.createElement("input");
    input.id = `model-service-${provider}`;
    label.htmlFor = input.id;
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = 512;
    input.className =
      "settings-model-service__input h-9 w-full min-w-0 rounded-md border border-settings-border bg-settings-panel px-3 text-[13px] text-settings-text placeholder:text-settings-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus";
    const actions = document.createElement("div");
    actions.className =
      "settings-model-service__actions flex items-center gap-2 [&_button]:h-9 [&_button]:shrink-0 [&_button]:px-3";
    const button = (text: string) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = text;
      element.className = "settings-command-button settings-command-button--secondary";
      return element;
    };
    const save = button("保存");
    const clear = button("清除");
    const test = button("测试");
    const status = document.createElement("p");
    status.className =
      "settings-model-service__status m-0 mt-1 min-h-5 text-xs leading-5 text-settings-muted data-[error=true]:text-settings-danger";
    status.setAttribute("role", "status");
    actions.append(input, save, clear, test);
    row.append(label, actions, status);
    section.append(row);
    let busy = false;
    const render = () => {
      input.placeholder = settings?.[provider].configured
        ? `已配置 ····${settings[provider].lastFour ?? ""}`
        : "输入 API Key";
      input.disabled = busy || !settings;
      save.disabled = busy || !settings || !input.value.trim();
      clear.disabled = busy || !settings?.[provider].configured;
      test.disabled = busy || !settings?.[provider].configured || Boolean(input.value.trim());
    };
    controls.push(render);
    input.addEventListener("input", render);
    const run = async (action: "save" | "clear" | "test") => {
      if (busy || !client) return;
      busy = true;
      status.dataset.error = "false";
      status.textContent = action === "test" ? "正在测试…" : "正在保存…";
      render();
      try {
        if (action === "test") {
          const result = await client.test(provider);
          if (!alive()) return;
          status.dataset.error = String(!result.ok);
          status.textContent = result.ok
            ? `连接成功 · ${result.latencyMs ?? 0} 毫秒`
            : modelServiceErrorText(result.errorCode, provider);
        } else {
          const value = action === "clear" ? null : input.value.trim();
          if (value !== null && (value.length < 8 || /\s/u.test(value)))
            throw new Error("invalid_key");
          const result = await client.update({ key: { provider, value } });
          if (!alive()) return;
          settings = result;
          input.value = "";
          status.textContent = action === "clear" ? "已清除" : "已保存";
        }
      } catch (error) {
        if (alive()) {
          status.dataset.error = "true";
          status.textContent = errorText(error, provider);
        }
      } finally {
        busy = false;
        if (alive()) refresh();
      }
    };
    save.addEventListener("click", () => {
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
  const modelRow = document.createElement("div");
  modelRow.className = "settings-model-service__model mt-2 flex items-center gap-6";
  const label = document.createElement("label");
  label.textContent = "解析模型";
  label.className = "flex-1 text-[13px] leading-5 text-settings-text";
  const select = document.createElement("select");
  select.id = "model-service-provider";
  label.htmlFor = select.id;
  select.className =
    "settings-model-service__input h-9 w-[280px] min-w-0 rounded-md border border-settings-border bg-settings-panel px-3 text-[13px] text-settings-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus";
  for (const [value, text] of [
    ["openai", "OpenAI · gpt-4.1-mini"],
    ["gemini", "Gemini · gemini-3.5-flash-lite"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.disabled = true;
  modelRow.append(label, select);
  section.append(modelRow);
  select.addEventListener("change", () => {
    if (!client || !settings) return;
    const provider = select.value === "gemini" ? "gemini" : "openai";
    select.disabled = true;
    void client
      .update({ provider })
      .then((result) => {
        if (alive()) {
          settings = result;
          notice.textContent = "";
        }
      })
      .catch(() => {
        if (alive()) notice.textContent = "模型选择未保存，请重试";
      })
      .finally(() => {
        if (alive()) {
          select.value = settings?.provider ?? "openai";
          select.disabled = false;
        }
      });
  });
  void (client?.read() ?? Promise.reject(new Error("local_only")))
    .then((result) => {
      if (!alive()) return;
      settings = result;
      notice.textContent = "";
      select.value = result.provider;
      select.disabled = false;
      refresh();
    })
    .catch(() => {
      if (alive()) notice.textContent = "无法连接本地模型服务，请稍后重试";
    });
}
