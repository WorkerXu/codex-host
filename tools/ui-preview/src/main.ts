import previewCss from "./preview.css";
import { createDingTalkEntrySection } from "../../../packages/renderer-extension/src/renderer-dingtalk-entry.js";
import { ProjectGroupNewChatPicker } from "../../../packages/renderer-extension/src/renderer-project-groups-new-chat.js";
import { createCodexAgentsSettingsPage } from "../../../packages/renderer-extension/src/settings/codex-agents-page.js";
import { createDingTalkSettingsPage } from "../../../packages/renderer-extension/src/settings/dingtalk-page.js";
import { rendererSettingsMessages } from "../../../packages/renderer-extension/src/settings/localization.js";
import { installRendererSettingsShell } from "../../../packages/renderer-extension/src/settings/shell.js";

import { createFakeCodexAgentsClient, createFakeDingTalkClient } from "./fake-clients.js";
import type {
  ProjectGroupAddMachineResult,
  ProjectGroupAddMachineTarget,
} from "../../../packages/renderer-extension/src/renderer-project-groups-model.js";
import { addMachineTargets, projectGroupView } from "./fixtures.js";

const parameters = new URLSearchParams(location.search);
const scenarioName = parameters.get("scenario") ?? "dingtalk-list";
const theme = parameters.get("theme") === "dark" ? "dark" : "light";
const locale = "zh-CN" as const;
const messages = rendererSettingsMessages(locale);

const style = document.createElement("style");
style.textContent = previewCss;
document.head.append(style);
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;

const root = document.getElementById("preview-root");
if (!root) throw new Error("Preview root is missing");

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

async function waitFor<T>(read: () => T | null | undefined, timeout = 4_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${scenarioName}`);
    await delay(50);
  }
}

function mountSettings(
  pageId: "dingtalk" | "codex-agents",
  dingtalkEmpty = false,
  dingtalkError = false,
) {
  const dingtalkClient = createFakeDingTalkClient({
    empty: dingtalkEmpty,
    error: dingtalkError,
    messageDelayMs: scenarioName === "dingtalk-scrolled-top" ? 1_500 : 120,
  });
  const agentsClient = createFakeCodexAgentsClient();
  const dingtalkPage = createDingTalkSettingsPage(messages, {
    createClient: () => dingtalkClient,
    readLocale: () => locale,
    embed: () => true,
  });
  const agentsPage = createCodexAgentsSettingsPage(messages, {
    createClient: () => agentsClient,
  });
  const shell = installRendererSettingsShell([dingtalkPage, agentsPage], messages);
  shell.openSettings(undefined, pageId);
  const shadow = shell.root.shadowRoot;
  if (!shadow) throw new Error("Settings shell shadow root is missing");
  const query = <T extends Element>(selector: string) => shadow.querySelector<T>(selector);
  const queryAll = <T extends Element>(selector: string) => [
    ...shadow.querySelectorAll<T>(selector),
  ];
  return { shell, query, queryAll };
}

async function openFirstConversation(query: <T extends Element>(selector: string) => T | null) {
  const row = await waitFor(() => query<HTMLButtonElement>(".dingtalk-conversation"));
  row.click();
  await waitFor(() => query(".dingtalk-message"));
  await delay(180);
}

function mountStage(html: string): HTMLElement {
  root!.classList.add("preview-stage-root");
  const stage = document.createElement("div");
  stage.className = "preview-stage";
  stage.innerHTML = html;
  root!.append(stage);
  return stage;
}

type AddMachineHandler = (
  groupId: string,
  target: ProjectGroupAddMachineTarget,
) => Promise<ProjectGroupAddMachineResult> | undefined;

function openProjectMenu(onAddMachine: AddMachineHandler): ProjectGroupNewChatPicker {
  const stage = mountStage(`
    <aside class="preview-projects">
      <div class="preview-projects-heading">Projects</div>
      <div class="preview-group-row">
        <span class="preview-group-icon"></span>
        <span class="preview-group-name">codex-host</span>
        <button type="button" class="preview-plus" aria-label="新建对话">+</button>
      </div>
      <div class="preview-project-row">codex-host</div>
      <div class="preview-project-row">gate-a</div>
    </aside>
    <main class="preview-canvas">
      <article class="preview-thread">
        <h1>工作台重构</h1>
        <p>项目组、钉钉与智能体页面正在按照同一套 Desktop 视觉语言收敛。</p>
        <div class="preview-composer">讨论工作台 UI 的下一步…</div>
      </article>
    </main>`);
  const anchor = stage.querySelector<HTMLButtonElement>(".preview-plus");
  if (!anchor) throw new Error("Plus anchor is missing");
  const picker = new ProjectGroupNewChatPicker({
    document,
    window,
    onSelect: () => undefined,
    loadAddTargets: async () => addMachineTargets,
    onAddMachine,
  });
  picker.open(projectGroupView, anchor);
  return picker;
}

async function openMachineMenu(onAddMachine: AddMachineHandler): Promise<void> {
  openProjectMenu(onAddMachine);
  const add = await waitFor(() =>
    document.querySelector<HTMLElement>("[data-codexhost-add-machine-row]"),
  );
  add.click();
  await waitFor(() => document.querySelector("[data-codexhost-add-machine-menu]"));
  await delay(160);
}

const scenarios: Record<string, () => Promise<void>> = {
  async "dingtalk-list"() {
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
  },

  async "dingtalk-open"() {
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
  },

  async "dingtalk-scrolled-top"() {
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    const list = query<HTMLElement>(".dingtalk-message-list");
    if (!list) throw new Error("Message list is missing");
    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll"));
    await waitFor(() => query(".dingtalk-loading-older:not([hidden])"));
    await delay(120);
  },

  async "dingtalk-search"() {
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    const input = query<HTMLInputElement>(".dingtalk-search-input");
    if (!input) throw new Error("Search input is missing");
    input.value = "预算";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => query(".dingtalk-search-result"));
    await delay(260);
  },

  async "dingtalk-select"() {
    const { query, queryAll } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    const checks = queryAll<HTMLInputElement>(".dingtalk-message-check");
    for (const check of checks.slice(-3)) {
      check.checked = true;
      check.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await waitFor(() => query(".dingtalk-selection-bar:not([hidden])"));
  },

  async "dingtalk-empty"() {
    const { query } = mountSettings("dingtalk", true, false);
    await waitFor(() => query(".dingtalk-empty-list"));
  },

  async "dingtalk-error"() {
    const { query } = mountSettings("dingtalk", false, true);
    await waitFor(() => query(".dingtalk-empty-list"));
  },

  async "agents-list"() {
    const { query } = mountSettings("codex-agents");
    await waitFor(() => query(".agent-row:not(.agent-row--skeleton)"));
  },

  async "agents-edit"() {
    const { query } = mountSettings("codex-agents");
    const row = await waitFor(() =>
      query<HTMLButtonElement>(".agent-row:not(.agent-row--skeleton)"),
    );
    row.click();
    await waitFor(() => query(".agent-editor:not([hidden])"));
  },

  async "agents-dingtalk-disabled"() {
    const { query, shell } = mountSettings("codex-agents");
    const toggle = await waitFor(() => {
      const input = query<HTMLInputElement>(".dingtalk-switch");
      return input?.checked ? input : null;
    });
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => query('.dingtalk-listener-body[data-disabled="true"]'));
    await waitFor(() => query(".dingtalk-listener-status")?.textContent === "已保存", 3_000);
    const page = shell.root.shadowRoot?.querySelector<HTMLElement>(".settings-page");
    if (!page) throw new Error("Settings page scroller is missing");
    page.scrollTop = page.scrollHeight;
    await delay(180);
  },

  async "agents-dingtalk-settings"() {
    const { query, shell } = mountSettings("codex-agents");
    await waitFor(() => query(".dingtalk-listener"));
    await waitFor(() => query(".dingtalk-agent-list .dingtalk-agent-name"));
    await waitFor(() => query<HTMLInputElement>(".dingtalk-switch")?.checked === true);
    const page = shell.root.shadowRoot?.querySelector<HTMLElement>(".settings-page");
    if (!page) throw new Error("Settings page scroller is missing");
    await delay(100);
    page.scrollTop = page.scrollHeight;
    await delay(100);
    page.scrollTop = page.scrollHeight;
    await delay(120);
  },

  async "group-plus-menu"() {
    openProjectMenu();
    await waitFor(() => document.querySelector("[data-codexhost-project-groups-new-chat]"));
  },

  async "group-add-machine"() {
    await openMachineMenu(() => undefined);
  },

  async "group-add-machine-busy"() {
    await openMachineMenu(() => new Promise(() => undefined));
    const row = await waitFor(() =>
      document.querySelector<HTMLElement>('[data-codexhost-add-machine-host="host-build"]'),
    );
    row.click();
    await waitFor(() => row.getAttribute("aria-busy") === "true");
    await delay(120);
  },

  async "group-add-machine-error"() {
    await openMachineMenu(async () => ({ ok: false, message: "创建目录失败：权限不足。" }));
    const row = await waitFor(() =>
      document.querySelector<HTMLElement>('[data-codexhost-add-machine-host="host-build"]'),
    );
    row.click();
    await waitFor(() =>
      document
        .querySelector("[data-codexhost-add-machine-menu]")
        ?.textContent?.includes("创建目录失败：权限不足。"),
    );
    await delay(120);
  },

  async "at-entry"() {
    const stage = mountStage(`
      <main class="preview-canvas preview-canvas--composer">
        <div class="preview-composer-card">
          <div class="preview-composer-input">帮我把今天的发布进展整理一下…</div>
          <div class="preview-at-menu" role="listbox" aria-label="提及">
            <div class="preview-native-header">文件</div>
            <div class="preview-native-row">图片</div>
            <div class="preview-native-header">智能体</div>
            <div class="preview-native-row">Codex</div>
          </div>
        </div>
      </main>`);
    const menu = stage.querySelector(".preview-at-menu");
    if (!menu) throw new Error("At menu is missing");
    menu.append(createDingTalkEntrySection(document, locale).element);
    await delay(80);
  },
};

async function main() {
  const run = scenarios[scenarioName];
  if (!run) throw new Error(`Unknown preview scenario: ${scenarioName}`);
  try {
    await run();
    await delay(250);
    document.body.dataset.scenario = scenarioName;
    document.body.dataset.theme = theme;
    document.body.dataset.ready = "true";
  } catch (error) {
    document.body.dataset.error = error instanceof Error ? error.message : String(error);
    document.body.dataset.ready = "true";
    throw error;
  }
}

void main();
