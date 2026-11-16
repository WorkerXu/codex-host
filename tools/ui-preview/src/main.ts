import previewCss from "./preview.css";
import {
  createDingTalkEntryRow,
  installRendererDingTalkEntry,
} from "../../../packages/renderer-extension/src/renderer-dingtalk-entry.js";
import {
  createJarvisEntryRow,
  installRendererJarvisMention,
} from "../../../packages/renderer-extension/src/renderer-jarvis-mention.js";
import { createWorkbenchSection } from "../../../packages/renderer-extension/src/renderer-native-at-menu.js";
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

/**
 * Mirror of the real `@` menu DOM captured on 2026-11-16: no listbox/option
 * roles, `data-mention-*` structure and the native row classes.
 */
const NATIVE_HEADER_CLASS =
  "text-codex-description shrink-0 h-[var(--suggestion-menu-header-height,auto)] px-row-x py-1 " +
  "text-sm sticky top-0 z-10 " +
  "bg-[var(--suggestion-menu-header-background,var(--color-surface-elevated-secondary))]";
const NATIVE_ROW_CLASS =
  "text-default outline-hidden focus:bg-secondary-ghost-hover cursor-interaction flex w-full " +
  "shrink-0 items-center overflow-hidden text-start min-h-[var(--app-menu-item-height,0px)] " +
  "rounded-[var(--suggestion-menu-item-radius,var(--radius-xl))] " +
  "p-[var(--suggestion-menu-item-padding,var(--app-menu-item-padding,var(--padding-row-y)_var(--padding-row-x)))] " +
  "text-sm [content-visibility:auto] [contain-intrinsic-block-size:auto_1lh]";
const NATIVE_ROW_CONTENT_CLASS =
  "flex w-full min-w-0 items-center gap-[var(--spacing-menu-item-content,calc(var(--spacing)*1.5))]";
const NATIVE_ROW_ACTIVE = "bg-secondary-ghost-hover opacity-100";
const NATIVE_ROW_IDLE = "menu-row-opacity";

function nativeRow(
  label: string,
  options: { active?: boolean; description?: string } = {},
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.setAttribute("data-list-navigation-item", "true");
  row.className = `${NATIVE_ROW_CLASS} ${options.active ? NATIVE_ROW_ACTIVE : NATIVE_ROW_IDLE}`;
  if (options.active) row.setAttribute("aria-current", "true");
  const content = document.createElement("div");
  content.setAttribute("data-menu-row-content", "true");
  content.className = NATIVE_ROW_CONTENT_CLASS;
  const labelSpan = document.createElement("span");
  labelSpan.className = "min-w-0 truncate";
  labelSpan.textContent = label;
  content.append(labelSpan);
  if (options.description) {
    const description = document.createElement("span");
    description.className = "min-w-0 flex-1 truncate text-sm text-codex-description";
    description.textContent = options.description;
    content.append(description);
  }
  row.append(content);
  return row;
}

function nativeSection(id: string, title: string, rows: HTMLElement[], first = false): HTMLElement {
  const section = document.createElement("div");
  section.setAttribute("data-mention-section-id", id);
  const header = document.createElement("div");
  header.className = first ? NATIVE_HEADER_CLASS : `${NATIVE_HEADER_CLASS} pt-2`;
  header.textContent = title;
  const items = document.createElement("div");
  items.setAttribute("data-mention-section-items", "true");
  items.append(...rows);
  section.append(header, items);
  return section;
}

/** Panel + the single native scroll container that owns every section. */
function nativeAtMenu(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "preview-at-menu suggestionMenu-Preview";
  const scroll = document.createElement("div");
  scroll.className = "vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto";
  scroll.setAttribute("data-mention-list-scroll-area", "");
  scroll.append(
    nativeSection("context-actions", "添加", [nativeRow("文件和文件夹"), nativeRow("图片")], true),
    nativeSection("agents", "智能体", [
      nativeRow("Codex", { description: "默认编码智能体", active: true }),
    ]),
  );
  panel.append(scroll);
  return panel;
}

async function mountNativeAtMenu(open: boolean): Promise<void> {
  await loadDesktopCss();
  const stage = mountStage(`
    <main class="preview-canvas preview-canvas--composer">
      <div class="preview-composer-card">
        <div class="preview-composer-input" id="native-editor" contenteditable="true">@</div>
      </div>
    </main>`);
  const editor = stage.querySelector<HTMLElement>("#native-editor");
  if (!editor) throw new Error("Native composer is missing");
  const menu = nativeAtMenu();
  stage.querySelector(".preview-composer-card")?.append(menu);
  const scroll = menu.querySelector<HTMLElement>("[data-mention-list-scroll-area]");
  if (!scroll) throw new Error("Native scroll area is missing");
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
  installRendererJarvisMention(document, {
    isComposerEditor: (element) => element === editor,
    readHostId: () => "local",
    readLocale: () => locale,
    anchorForEditor: () => menu,
    search: async () => ({
      available: false,
      errorCode: "jarvis_failed",
      conditions: [],
      bugs: [],
      total: 0,
      capped: false,
    }),
  });
  document.dispatchEvent(new Event("selectionchange"));
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  const section = await waitFor(() => scroll.querySelector("[data-codexhost-workbench-section]"));
  section.scrollIntoView({ block: "nearest" });
  const dingtalkRow = section.querySelector<HTMLElement>("[data-codexhost-dingtalk-entry]");
  const jarvisRow = section.querySelector<HTMLElement>("[data-codexhost-jarvis-entry-row]");
  document.body.dataset.entryNativeScroller = String(section.parentElement === scroll);
  document.body.dataset.entryLastGroup = String(scroll.lastElementChild === section);
  document.body.dataset.entryRow = String(Boolean(dingtalkRow));
  document.body.dataset.entryGroupTitle = String(section.textContent?.includes("工作台") ?? false);
  document.body.dataset.entryHelper = String(
    dingtalkRow?.textContent?.includes("打开钉钉工作台") ?? false,
  );
  document.body.dataset.entrySharedSection = String(
    Boolean(
      jarvisRow &&
      jarvisRow.parentElement === dingtalkRow?.parentElement &&
      section.children.length === 2,
    ),
  );
  document.body.dataset.entryHeaderCount = String(
    [...section.children].filter((child) => child.textContent?.trim() === "工作台").length,
  );
  document.body.dataset.entryOverlay = String(
    Boolean(
      document.querySelector("[data-codexhost-dingtalk-panel],[data-codexhost-jarvis-panel]"),
    ),
  );
  document.body.dataset.entryNativeButtons = String(
    [...scroll.querySelectorAll('[data-list-navigation-item="true"]')]
      .filter((row) => !row.closest("[data-codexhost-workbench-section]"))
      .every((row) => row.tagName === "BUTTON"),
  );
  if (!open) {
    await delay(80);
    return;
  }
  const nativeRows = [
    ...scroll.querySelectorAll<HTMLElement>('[data-list-navigation-item="true"]'),
  ].filter((row) => !row.closest("[data-codexhost-workbench-section]"));
  const lastNative = nativeRows.at(-1);
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  document.body.dataset.entryKeyboardHandoff = String(
    dingtalkRow?.getAttribute("aria-current") === "true" &&
      lastNative?.getAttribute("aria-current") !== "true",
  );
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  const walkedToJarvis = jarvisRow?.getAttribute("aria-current") === "true";
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
  );
  document.body.dataset.entryWorkbenchWalk = String(
    walkedToJarvis &&
      dingtalkRow?.getAttribute("aria-current") === "true" &&
      jarvisRow?.getAttribute("aria-current") !== "true",
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
      priority: 3,
      severity: 2,
      updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }),
  ],
  total: 4,
  capped: false,
};

const jarvisPreviewProjectRecent: JarvisBugSearchResult = {
  ...jarvisPreviewResults,
  conditions: [
    { key: "scope:assigned", kind: "scope", label: "指派给我" },
    { key: "project:示例买", kind: "project", label: "示例买 ×2 个项目" },
    { key: "order:newest", kind: "order", label: "最新" },
  ],
  bugs: jarvisPreviewResults.bugs.map((bug, index) => (index === 3 ? { ...bug, status: 2 } : bug)),
};

const jarvisPreviewConditions: JarvisBugSearchResult = {
  available: true,
  errorCode: null,
  conditions: [
    { key: "scope:assigned", kind: "scope", label: "指派给我" },
    { key: "status:1", kind: "status", label: "未解决" },
    { key: "severity:2", kind: "severity", label: "严重" },
    { key: "title", kind: "title", label: "标题含「登录」" },
  ],
  bugs: [
    previewBug(928, 4029, "示例商城 · 迭代 A", "登录后无法进入工作台", {
      severity: 2,
    }),
    previewBug(936, 4041, "示例后台 · 迭代 B", "登录验证码不显示", {
      severity: 2,
      updatedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    }),
  ],
  total: 2,
  capped: false,
};

const jarvisPreviewEmpty: JarvisBugSearchResult = {
  available: true,
  errorCode: null,
  conditions: [
    { key: "scope:assigned", kind: "scope", label: "指派给我" },
    { key: "status:3", kind: "status", label: "已关闭" },
    { key: "severity:2", kind: "severity", label: "严重" },
  ],
  bugs: [],
  total: 0,
  capped: false,
};

const jarvisPreviewError: JarvisBugSearchResult = {
  available: false,
  errorCode: "not_logged_in",
  conditions: [],
  bugs: [],
  total: 0,
  capped: false,
};

async function mountJarvisSearch(
  preview: JarvisPreviewResult,
  query: string,
  clickEntry = true,
  ready?: (mode: HTMLElement) => boolean,
  initialText = "@",
  prefill?: string,
): Promise<void> {
  await loadDesktopCss();
  const stage = mountStage(`
    <main class="preview-canvas preview-canvas--composer">
      <div class="preview-composer-card" data-composer-body>
        <div class="preview-composer-editor" contenteditable="true">@</div>
      </div>
    </main>`);
  const editor = stage.querySelector<HTMLElement>(".preview-composer-editor");
  const card = stage.querySelector<HTMLElement>("[data-composer-body]");
  if (!editor || !card) throw new Error("Composer preview is missing");
  editor.textContent = initialText;
  const menu = nativeAtMenu();
  card.append(menu);
  const previewWindow = window as Window & { __jarvisPreviewSearchCalls?: number };
  previewWindow.__jarvisPreviewSearchCalls = 0;
  const control = installRendererJarvisMention(document, {
    isComposerEditor: (element) => element === editor,
    readHostId: () => "local",
    readLocale: () => locale,
    anchorForEditor: () => card,
    openSettings: () => {
      document.body.dataset.jarvisSettingsOpened = "true";
    },
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
  if (prefill !== undefined) {
    await waitFor(() => input.value === prefill);
    document.body.dataset.jarvisPrefill = input.value;
    document.body.dataset.jarvisEditorText = editor.textContent ?? "";
    document.body.dataset.jarvisSearchCalls = String(previewWindow.__jarvisPreviewSearchCalls ?? 0);
    await waitFor(
      () =>
        (ready?.(mode) ?? Boolean(mode.querySelector("[data-codexhost-jarvis-bug]"))) ? mode : null,
      4_000,
    );
    await delay(120);
    return;
  }
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
        </div>
      </main>`);
    const menu = nativeAtMenu();
    stage.querySelector(".preview-composer-card")?.append(menu);
    const scroll = menu.querySelector<HTMLElement>("[data-mention-list-scroll-area]");
    if (!scroll) throw new Error("Native scroll area is missing");
    const workbench = createWorkbenchSection(document, locale);
    workbench.items.append(
      createDingTalkEntryRow(document, locale),
      createJarvisEntryRow(document, locale),
    );
    scroll.append(workbench.element);
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

  async "jarvis-entry-query"() {
    await mountJarvisSearch(
      { result: jarvisPreviewResults, pending: true },
      "",
      false,
      undefined,
      "@我还没处理完的bug",
    );
  },

  async "jarvis-mode-prefilled"() {
    await mountJarvisSearch(
      { result: jarvisPreviewProjectRecent, delayMs: 120 },
      "",
      true,
      undefined,
      "@示例买的最近的bug",
      "示例买的最近的bug",
    );
  },

  async "jarvis-mode-detached"() {
    await mountJarvisSearch({ result: jarvisPreviewResults, delayMs: 120 }, "我还没处理完成的bug");
    document.querySelector<HTMLInputElement>("[data-codexhost-jarvis-mode] input")?.focus();
    document.querySelector(".preview-at-menu")?.remove();
    await waitFor(() => document.querySelector("[data-codexhost-jarvis-detached]"), 4_000);
    await delay(120);
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

  async "jarvis-mode-error"() {
    await mountJarvisSearch(
      { result: jarvisPreviewError, delayMs: 80 },
      "我还没处理完的bug",
      true,
      (mode) => mode.textContent?.includes("Jarvis 未安装或未登录") === true,
    );
  },

  async "jarvis-mode-slow"() {
    await mountJarvisSearch({ result: jarvisPreviewResults, pending: true }, "我还没处理完的bug");
    await delay(8_200);
  },

  async "jarvis-mode-conditions"() {
    await mountJarvisSearch(
      { result: jarvisPreviewConditions, delayMs: 80 },
      "我还没处理完成的严重登录bug",
      true,
      (mode) => mode.querySelectorAll("[data-jarvis-chip]").length >= 4,
    );
  },

  async "jarvis-mode-chip-removed"() {
    await mountJarvisSearch(
      { result: jarvisPreviewConditions, delayMs: 80 },
      "我还没处理完成的严重登录bug",
      true,
      (mode) => mode.querySelectorAll("[data-jarvis-chip]").length >= 4,
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
