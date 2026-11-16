import previewCss from "./preview.css";
import {
  createDingTalkEntrySection,
  installRendererDingTalkEntry,
} from "../../../packages/renderer-extension/src/renderer-dingtalk-entry.js";
import {
  createJarvisEntryRow,
  installRendererJarvisMention,
} from "../../../packages/renderer-extension/src/renderer-jarvis-mention.js";
import { ProjectGroupNewChatPicker } from "../../../packages/renderer-extension/src/renderer-project-groups-new-chat.js";
import { createCodexAgentsSettingsPage } from "../../../packages/renderer-extension/src/settings/codex-agents-page.js";
import { createDingTalkSettingsPage } from "../../../packages/renderer-extension/src/settings/dingtalk-page.js";
import { rendererSettingsMessages } from "../../../packages/renderer-extension/src/settings/localization.js";
import { installRendererSettingsShell } from "../../../packages/renderer-extension/src/settings/shell.js";

import {
  createFakeCodexAgentsClient,
  createFakeDingTalkClient,
  type FakeDingTalkStatus,
} from "./fake-clients.js";
import type {
  ProjectGroupAddMachineResult,
  ProjectGroupAddMachineTarget,
} from "../../../packages/renderer-extension/src/renderer-project-groups-model.js";
import { addMachineTargets, projectGroupView } from "./fixtures.js";
import type { JarvisBugSearchResult } from "@codexhost/shared-contracts";

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
  dingtalkStatus: FakeDingTalkStatus = "connected",
  agentsEmpty = false,
) {
  const dingtalkClient = createFakeDingTalkClient({
    empty: dingtalkEmpty,
    error: dingtalkError,
    status: dingtalkStatus,
    messageDelayMs: scenarioName === "dingtalk-scrolled-top" ? 1_500 : 120,
  });
  const agentsClient = createFakeCodexAgentsClient({ withAgents: !agentsEmpty });
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

async function openPageMenu(query: <T extends Element>(selector: string) => T | null) {
  const button = await waitFor(() =>
    query<HTMLButtonElement>(".dingtalk-sidebar .dingtalk-more-button"),
  );
  button.click();
  await waitFor(() => query(".dingtalk-page-menu:not([hidden])"));
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

/**
 * Native-DOM scenarios render in the light DOM of the Desktop window, which
 * uses the global Desktop stylesheet. Shadow-root workbench pages never load it.
 */
async function loadDesktopCss(): Promise<void> {
  if (document.querySelector("link[data-preview-desktop-css]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/codex-desktop.css";
  link.dataset.previewDesktopCss = "";
  const loaded = new Promise<void>((resolve) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
  });
  document.head.append(link);
  await loaded;
}

async function mountNativeAtMenu(open: boolean): Promise<void> {
  await loadDesktopCss();
  const stage = mountStage(`
    <main class="preview-canvas preview-canvas--composer">
      <div class="preview-composer-card">
        <div class="preview-composer-input" id="native-editor" contenteditable="true">@钉</div>
      </div>
      <div class="preview-at-menu" id="native-at-menu" role="listbox" aria-label="提及">
        <div class="preview-native-scroll vertical-scroll-fade-mask">
          <div class="preview-native-header">文件</div>
          <div class="preview-native-row" role="option" aria-selected="false">图片</div>
          <div class="preview-native-header">智能体</div>
          <div class="preview-native-row" role="option" aria-selected="true">Codex</div>
        </div>
      </div>
    </main>`);
  const editor = stage.querySelector<HTMLElement>("#native-editor");
  const menu = stage.querySelector<HTMLElement>("#native-at-menu");
  if (!editor || !menu) throw new Error("Native composer or menu is missing");
  const text = editor.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Editor text is missing");
  editor.focus();
  const range = document.createRange();
  range.setStart(text, (text.textContent ?? "").length);
  range.collapse(true);
  const selection = document.getSelection();
  if (!selection) throw new Error("Selection is unavailable");
  selection.removeAllRanges();
  selection.addRange(range);
  installRendererDingTalkEntry(document, {
    isComposerEditor: (element) => element === editor,
    anchorForEditor: () => menu,
    open: () => {
      document.body.dataset.entryOpened = "true";
      return true;
    },
  });
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  const section = await waitFor(() => menu.querySelector("[data-codexhost-dingtalk-section]"));
  const scroller = menu.querySelector(".vertical-scroll-fade-mask");
  const entryRow = section.querySelector("[data-codexhost-dingtalk-entry]");
  document.body.dataset.entryNativeScroller = String(
    Boolean(scroller && section.parentElement === scroller),
  );
  document.body.dataset.entryLastGroup = String(scroller?.lastElementChild === section);
  document.body.dataset.entryRow = String(Boolean(entryRow));
  document.body.dataset.entryGroupTitle = String(section.textContent?.includes("工作台") ?? false);
  document.body.dataset.entryHelper = String(
    entryRow?.textContent?.includes("打开钉钉工作台") ?? false,
  );
  if (!open) {
    await delay(80);
    return;
  }
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await waitFor(() => document.body.dataset.entryOpened === "true");
}

interface JarvisPreviewResult {
  result: JarvisBugSearchResult;
  delayMs?: number;
  pending?: boolean;
}

function previewBug(
  id: number,
  projectId: number,
  projectName: string,
  title: string,
  overrides: Partial<JarvisBugSearchResult["bugs"][number]> = {},
): JarvisBugSearchResult["bugs"][number] {
  return {
    id,
    projectId,
    projectName,
    title,
    status: 1,
    priority: 3,
    severity: 3,
    updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    ...overrides,
  };
}

const jarvisPreviewResults: JarvisBugSearchResult = {
  available: true,
  errorCode: null,
  conditions: [
    { key: "scope:assigned", kind: "scope", label: "指派给我" },
    { key: "status:1", kind: "status", label: "未解决" },
    { key: "project:示例买", kind: "project", label: "示例买 ×2 个项目" },
    { key: "order:newest", kind: "order", label: "最新" },
  ],
  bugs: [
    previewBug(
      928,
      4029,
      "示例商城 · 迭代 A",
      "填写已查码的序列号给新的查码任务，无法进行下一步",
      { priority: 1, severity: 2, updatedAt: new Date(Date.now() - 3 * 60_000).toISOString() },
    ),
    previewBug(936, 4041, "示例后台 · 迭代 B", "加盟商鉴定任务的查码成本判断", {
      priority: 3,
      severity: 3,
      updatedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    }),
    previewBug(941, 4078, "示例买 · 消息通知", "示例买消息通知未送达", {
      priority: 2,
      severity: 1,
      updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
    }),
    previewBug(952, 4081, "示例买 · 标记迭代", "搜索结果列表未显示示例买标记", {
      status: 2,
      priority: 3,
      severity: 2,
      updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }),
  ],
  total: 4,
  capped: false,
};

const jarvisPreviewConditions: JarvisBugSearchResult = {
  ...jarvisPreviewResults,
  conditions: [
    { key: "scope:assigned", kind: "scope", label: "指派给我" },
    { key: "status:1", kind: "status", label: "未解决" },
    { key: "priority:1", kind: "priority", label: "高优先级" },
    { key: "severity:1", kind: "severity", label: "严重" },
    { key: "project:示例买", kind: "project", label: "示例买 ×2 个项目" },
    { key: "time", kind: "time", label: "最近 7 天" },
    { key: "title", kind: "title", label: "标题含「登录」" },
    { key: "order:newest", kind: "order", label: "最新" },
  ],
  bugs: jarvisPreviewResults.bugs.slice(0, 2),
  total: 2,
};

const jarvisPreviewEmpty: JarvisBugSearchResult = {
  available: true,
  errorCode: null,
  conditions: [
    { key: "scope:assigned", kind: "scope", label: "指派给我" },
    { key: "status:3", kind: "status", label: "已关闭" },
    { key: "severity:1", kind: "severity", label: "严重" },
  ],
  bugs: [],
  total: 0,
  capped: false,
};

async function mountJarvisSearch(
  preview: JarvisPreviewResult,
  query: string,
  clickEntry = true,
  ready?: (mode: HTMLElement) => boolean,
): Promise<void> {
  await loadDesktopCss();
  const stage = mountStage(`
    <main class="preview-canvas preview-canvas--composer">
      <div class="preview-composer-card" data-composer-body>
        <div class="preview-composer-editor" contenteditable="true">@</div>
        <div class="preview-at-menu vertical-scroll-fade-mask" role="listbox" aria-label="提及">
          <div class="preview-native-header">文件</div>
          <div class="preview-native-row">图片</div>
          <div class="preview-native-header">智能体</div>
          <div class="preview-native-row">Codex</div>
        </div>
      </div>
    </main>`);
  const editor = stage.querySelector<HTMLElement>(".preview-composer-editor");
  const card = stage.querySelector<HTMLElement>("[data-composer-body]");
  if (!editor || !card) throw new Error("Composer preview is missing");
  const previewWindow = window as Window & { __jarvisPreviewSearchCalls?: number };
  previewWindow.__jarvisPreviewSearchCalls = 0;
  const control = installRendererJarvisMention(document, {
    isComposerEditor: (element) => element === editor,
    readHostId: () => "local",
    readLocale: () => locale,
    anchorForEditor: () => card,
    search: async (_hostId, params) => {
      previewWindow.__jarvisPreviewSearchCalls =
        (previewWindow.__jarvisPreviewSearchCalls ?? 0) + 1;
      const result = {
        ...preview.result,
        conditions: preview.result.conditions.filter(
          (condition) => !params.omit?.includes(condition.key),
        ),
      };
      if (preview.pending) return new Promise(() => undefined);
      return await new Promise((resolve) => {
        setTimeout(() => resolve(result), preview.delayMs ?? 80);
      });
    },
  });
  control.refresh();
  editor.focus();
  const text = editor.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Editor text is missing");
  const range = document.createRange();
  range.setStart(text, text.textContent?.length ?? 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  const row = await waitFor(() =>
    document.querySelector<HTMLElement>("[data-codexhost-jarvis-entry-row]"),
  );
  if (!clickEntry) {
    await delay(80);
    return;
  }
  row.click();
  const mode = await waitFor(() =>
    document.querySelector<HTMLElement>("[data-codexhost-jarvis-mode]"),
  );
  const input = mode.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("Jarvis search field is missing");
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  if (preview.pending) {
    await waitFor(() => mode.getAttribute("aria-busy") === "true");
  } else {
    await waitFor(
      () =>
        (ready?.(mode) ?? Boolean(mode.querySelector("[data-codexhost-jarvis-bug]"))) ? mode : null,
      4_000,
    );
  }
  await delay(120);
}

const scenarios: Record<string, () => Promise<void>> = {
  async "dingtalk-list"() {
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await waitFor(() => query(".dingtalk-message"));
  },

  async "dingtalk-status-connected"() {
    const { query } = mountSettings("dingtalk", false, false, "connected");
    await waitFor(() => query(".dingtalk-conversation"));
    await waitFor(() => query(".dingtalk-menu-status-text")?.textContent?.includes("示例用户"));
    await openPageMenu(query);
  },

  async "dingtalk-status-not-logged-in"() {
    const { query } = mountSettings("dingtalk", false, false, "not-logged-in");
    await waitFor(() => query(".dingtalk-menu-status-text")?.textContent === "钉钉未登录");
    await openPageMenu(query);
  },

  async "dingtalk-status-unreachable"() {
    const { query } = mountSettings("dingtalk", false, false, "unreachable");
    await waitFor(() => query(".dingtalk-menu-status-text")?.textContent === "无法连接钉钉服务");
    await openPageMenu(query);
  },

  async "dingtalk-open"() {
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
  },

  async "dingtalk-direct"() {
    const { query, queryAll } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    const row = await waitFor(() =>
      queryAll<HTMLButtonElement>(".dingtalk-conversation").find(
        (item) => item.textContent?.includes("吴菁") && !item.textContent?.includes("群"),
      ),
    );
    row.click();
    await waitFor(() => query(".dingtalk-main-title")?.textContent === "吴菁");
    await waitFor(() => query(".dingtalk-message"));
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

  async "dingtalk-recent"() {
    const { query, queryAll } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    const button = queryAll<HTMLButtonElement>(".dingtalk-list-switch-button")[1];
    if (!button) throw new Error("Recent button is missing");
    button.click();
    await waitFor(
      () =>
        queryAll(".dingtalk-conversation").length > 0 &&
        query(".dingtalk-conversation-preview")?.textContent?.startsWith("我："),
    );
  },

  async "dingtalk-search"() {
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    const input = query<HTMLInputElement>(".dingtalk-search-input");
    if (!input) throw new Error("Search input is missing");
    input.value = "示例Sprint";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => query(".dingtalk-search-result"));
    await delay(260);
  },

  async "dingtalk-search-more"() {
    const { query, queryAll } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    const input = query<HTMLInputElement>(".dingtalk-search-input");
    if (!input) throw new Error("Search input is missing");
    input.value = "示例Sprint";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const more = await waitFor(() =>
      query<HTMLButtonElement>(".dingtalk-search-result--conversation")
        ? query<HTMLButtonElement>(".dingtalk-search-more")
        : null,
    );
    more.click();
    await waitFor(() => queryAll(".dingtalk-search-result--conversation").length >= 4);
    await delay(120);
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

  async "agents-cards"() {
    const { query } = mountSettings("codex-agents");
    await waitFor(() => query(".agent-card:not(.agent-card--skeleton):not(.agent-card--new)"));
    await waitFor(() => query(".agent-card-tag--dispatch"));
  },

  async "agents-cards-narrow"() {
    const { query } = mountSettings("codex-agents");
    await waitFor(() => query(".agent-card:not(.agent-card--skeleton):not(.agent-card--new)"));
    await waitFor(() => query(".agent-card-tag--dispatch"));
  },

  async "agents-empty"() {
    const { query } = mountSettings("codex-agents", false, false, "connected", true);
    await waitFor(() => query(".agent-card--new"));
    await waitFor(() => query(".agents-empty-copy:not([hidden])"));
  },

  async "agents-edit"() {
    const { query } = mountSettings("codex-agents");
    const card = await waitFor(() =>
      query<HTMLElement>(".agent-card:not(.agent-card--skeleton):not(.agent-card--new)"),
    );
    card.click();
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
    await loadDesktopCss();
    const stage = mountStage(`
      <main class="preview-canvas preview-canvas--composer">
        <div class="preview-composer-card">
          <div class="preview-composer-input">帮我把今天的发布进展整理一下…</div>
          <div class="preview-at-menu" role="listbox" aria-label="提及">
            <div class="preview-native-scroll vertical-scroll-fade-mask">
              <div class="preview-native-header">文件</div>
              <div class="preview-native-row">图片</div>
              <div class="preview-native-header">智能体</div>
              <div class="preview-native-row">Codex</div>
            </div>
          </div>
        </div>
      </main>`);
    const menu = stage.querySelector(".preview-native-scroll");
    if (!menu) throw new Error("At menu is missing");
    const workbench = createDingTalkEntrySection(document, locale).element;
    workbench.append(createJarvisEntryRow(document, locale));
    menu.append(workbench);
    await delay(80);
  },

  async "at-entry-native"() {
    await mountNativeAtMenu(true);
  },

  async "at-entry-native-visible"() {
    await mountNativeAtMenu(false);
  },

  async "jarvis-entry"() {
    await mountJarvisSearch({ result: jarvisPreviewResults, pending: true }, "", false);
  },

  async "jarvis-mode-loading"() {
    await mountJarvisSearch({ result: jarvisPreviewResults, pending: true }, "示例买的最近的bug");
  },

  async "jarvis-mode-results"() {
    await mountJarvisSearch({ result: jarvisPreviewResults, delayMs: 120 }, "我还没处理完成的bug");
  },

  async "jarvis-mode-empty"() {
    await mountJarvisSearch(
      { result: jarvisPreviewEmpty, delayMs: 80 },
      "已关闭的严重bug",
      true,
      (mode) => mode.textContent?.includes("没有符合条件的 Bug") === true,
    );
  },

  async "jarvis-mode-conditions"() {
    await mountJarvisSearch(
      { result: jarvisPreviewConditions, delayMs: 80 },
      "我还没处理完成的严重登录bug",
      true,
      (mode) => mode.querySelectorAll("[data-jarvis-chip]").length >= 6,
    );
  },

  async "jarvis-mode-chip-removed"() {
    await mountJarvisSearch(
      { result: jarvisPreviewConditions, delayMs: 80 },
      "我还没处理完成的严重登录bug",
      true,
      (mode) => mode.querySelectorAll("[data-jarvis-chip]").length >= 6,
    );
    const chip = document.querySelector<HTMLElement>('[data-jarvis-chip="status:1"]');
    if (!chip) throw new Error("Status chip is missing");
    chip.click();
    await waitFor(() => document.querySelector('[data-jarvis-chip="status:1"]') === null, 4_000);
    await delay(120);
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
