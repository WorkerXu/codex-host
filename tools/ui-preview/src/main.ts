import { nativeAtMenu } from "./native-at-menu.js";
import { createDefaultRendererSettingsPages } from "../../../packages/renderer-extension/src/settings/pages.js";
import type { ModelServiceSettings } from "@codexhost/shared-contracts";
import type { RendererModelServiceClient } from "../../../packages/renderer-extension/src/model-service-client.js";
import { mountThreadFoldersPreview } from "./thread-folders.js";
import { mountSidebarSectionsPreview } from "./sidebar-sections.js";
import { createRepositoryPreviewClient } from "./code-repositories.js";
import previewCss from "./preview.css";
import { applyDesktopTheme } from "./desktop-theme.js";
import {
  createDingTalkEntryRow,
  installRendererDingTalkEntry,
} from "../../../packages/renderer-extension/src/renderer-dingtalk-entry.js";
import {
  createJarvisEntryRow,
  installRendererJarvisMention,
} from "../../../packages/renderer-extension/src/renderer-jarvis-mention.js";
import { createWorkbenchSection } from "../../../packages/renderer-extension/src/renderer-native-at-menu.js";
import {
  mountRendererAgentPicker,
  renderRendererAgentPicker,
} from "../../../packages/renderer-extension/src/renderer-agent-picker.js";
import { createCodexAgentsSettingsPage } from "../../../packages/renderer-extension/src/settings/codex-agents-page.js";
import { createJarvisSettingsPage } from "../../../packages/renderer-extension/src/settings/jarvis-page.js";
import { createDingTalkSettingsPage } from "../../../packages/renderer-extension/src/settings/dingtalk-page.js";
import { rendererSettingsMessages } from "../../../packages/renderer-extension/src/settings/localization.js";
import { installRendererSettingsShell } from "../../../packages/renderer-extension/src/settings/shell.js";

import {
  createFakeCodexAgentsClient,
  createFakeDingTalkClient,
  createFakeJarvisClient,
  type FakeDingTalkOptions,
  type FakeDingTalkStatus,
} from "./fake-clients.js";
import type { JarvisBugCondition, JarvisBugSearchResult } from "@codexhost/shared-contracts";

const parameters = new URLSearchParams(location.search);
const scenarioName = parameters.get("scenario") ?? "dingtalk-list";
const theme = parameters.get("theme") === "dark" ? "dark" : "light";
const locale = "zh-CN" as const;
const messages = rendererSettingsMessages(locale);

const style = document.createElement("style");
style.textContent =
  scenarioName.startsWith("thread-folders-") || scenarioName.startsWith("sidebar-sections")
    ? ""
    : previewCss;
document.head.append(style);
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;

const root = document.getElementById("preview-root");
if (!root) throw new Error("Preview root is missing");

async function loadDesktopCss(): Promise<void> {
  if (document.querySelector("link[data-preview-desktop-css]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/codex-desktop.css";
  link.dataset.previewDesktopCss = "";
  const loaded = new Promise<void>((resolve, reject) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => reject(new Error("Desktop CSS unavailable")), {
      once: true,
    });
  });
  document.head.append(link);
  await loaded;
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

type PreviewInputAction = "click" | "hover" | "wheel" | "type" | "key";
interface PreviewInputBridge {
  request(
    element: Element,
    action: PreviewInputAction,
    options?: { text?: string; deltaY?: number; key?: string },
  ): Promise<void>;
}

const previewInput = (window as Window & { __codexhostPreviewInput?: PreviewInputBridge })
  .__codexhostPreviewInput;

/**
 * Every interaction scenario goes through a real pointer/keyboard input when
 * the Playwright capture runner is driving the page. A plain `element.click()`
 * hides focus, shadow-retargeting and popover problems, so it is only a
 * fallback for opening the page by hand.
 */
async function previewInputOn(
  element: Element,
  action: PreviewInputAction,
  options?: { text?: string; deltaY?: number; key?: string },
): Promise<void> {
  if (previewInput) {
    await previewInput.request(element, action, options);
    return;
  }
  if (action === "click") (element as HTMLElement).click();
}

const previewClick = (element: Element): Promise<void> => previewInputOn(element, "click");
const previewHover = (element: Element): Promise<void> => previewInputOn(element, "hover");
const previewType = (element: Element, text: string): Promise<void> =>
  previewInputOn(element, "type", { text });
const previewWheel = (element: Element, deltaY: number): Promise<void> =>
  previewInputOn(element, "wheel", { deltaY });
const previewKey = (element: Element, key: string): Promise<void> =>
  previewInputOn(element, "key", { key });

async function waitFor<T>(read: () => T | null | undefined, timeout = 4_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${scenarioName}`);
    await delay(50);
  }
}

function prepareSettings(
  pageId: "dingtalk" | "codex-agents" | "jarvis",
  dingtalkEmpty = false,
  dingtalkError = false,
  dingtalkStatus: FakeDingTalkStatus = "connected",
  agentsEmpty = false,
  dingtalkHeavy = false,
  dingtalkOptions: FakeDingTalkOptions = {},
) {
  const dingtalkClient = createFakeDingTalkClient({
    empty: dingtalkEmpty,
    error: dingtalkError,
    status: dingtalkStatus,
    heavy: dingtalkHeavy,
    messageDelayMs: dingtalkHeavy ? 20 : scenarioName === "dingtalk-scrolled-top" ? 1_500 : 120,
    ...dingtalkOptions,
    onSend(params) {
      (window as Window & { __dingtalkPreviewSent?: unknown }).__dingtalkPreviewSent = params;
      dingtalkOptions.onSend?.(params);
    },
    onViewed(conversationId, active) {
      (window as Window & { __dingtalkPreviewViewed?: unknown }).__dingtalkPreviewViewed = {
        conversationId,
        active,
      };
      dingtalkOptions.onViewed?.(conversationId, active);
    },
  });
  const dispatchPreview = scenarioName.startsWith("agents-dispatch-");
  const agentsClient = createFakeCodexAgentsClient({
    withAgents: !agentsEmpty,
    ...(dispatchPreview
      ? {
          dispatchStatus: {
            "reviewer.toml": {
              lastDispatchAt: Date.now() - 60_000,
              result: scenarioName.includes("missing-key")
                ? ("skipped" as const)
                : ("replied" as const),
              ...(scenarioName.includes("missing-key")
                ? { detail: "未配置 Gemini Key，未派发" }
                : {}),
            },
            "writer.toml": {
              lastDispatchAt: Date.now() - 120_000,
              result: "failed" as const,
              detail: "回复发送失败",
            },
          },
        }
      : {}),
  });
  const dingtalkPage = createDingTalkSettingsPage(messages, {
    createClient: () => dingtalkClient,
    readLocale: () => locale,
    embed: () => true,
  });
  const agentsPage = createCodexAgentsSettingsPage(messages, {
    createClient: () => agentsClient,
  });
  const jarvisPage = createJarvisSettingsPage(messages, {
    createClient: () => createFakeJarvisClient(),
  });
  const shell = installRendererSettingsShell([dingtalkPage, agentsPage, jarvisPage], messages);
  const shadow = shell.root.shadowRoot;
  if (!shadow) throw new Error("Settings shell shadow root is missing");
  const query = <T extends Element>(selector: string) => shadow.querySelector<T>(selector);
  const queryAll = <T extends Element>(selector: string) => [
    ...shadow.querySelectorAll<T>(selector),
  ];
  return {
    shell,
    query,
    queryAll,
    dingtalkClient,
    open: () => shell.openSettings(undefined, pageId),
  };
}

function mountSettings(
  pageId: "dingtalk" | "codex-agents" | "jarvis",
  dingtalkEmpty = false,
  dingtalkError = false,
  dingtalkStatus: FakeDingTalkStatus = "connected",
  agentsEmpty = false,
  dingtalkHeavy = false,
  dingtalkOptions: FakeDingTalkOptions = {},
) {
  const prepared = prepareSettings(
    pageId,
    dingtalkEmpty,
    dingtalkError,
    dingtalkStatus,
    agentsEmpty,
    dingtalkHeavy,
    dingtalkOptions,
  );
  prepared.open();
  return prepared;
}

async function openPageMenu(query: <T extends Element>(selector: string) => T | null) {
  const button = await waitFor(() =>
    query<HTMLButtonElement>(".dingtalk-sidebar .dingtalk-more-button"),
  );
  await previewClick(button);
  await waitFor(() => query(".dingtalk-page-menu:not([hidden])"));
}

async function openFirstConversation(query: <T extends Element>(selector: string) => T | null) {
  const row = await waitFor(() => query<HTMLButtonElement>(".dingtalk-conversation"));
  await previewClick(row);
  await waitFor(() => query(".dingtalk-message"));
  await delay(180);
}

/** The native popup is portaled above the Composer; keep it out of card flow. */
function pinAtMenu(card: HTMLElement, menu: HTMLElement): void {
  card.style.position = "relative";
  menu.style.position = "absolute";
  menu.style.left = "0";
  menu.style.right = "0";
  menu.style.bottom = "100%";
  menu.style.width = "100%";
  menu.style.maxHeight = "340px";
}

function resetConversationMemory(): void {
  try {
    localStorage.removeItem("codexhost.dingtalk.lastConversation.unread");
    localStorage.removeItem("codexhost.dingtalk.lastConversation");
  } catch {
    /* Preview storage is optional. */
  }
}

function mountStage(html: string): HTMLElement {
  root!.classList.add("preview-stage-root");
  const stage = document.createElement("div");
  stage.className = "preview-stage";
  stage.innerHTML = html;
  root!.append(stage);
  return stage;
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
  const card = stage.querySelector<HTMLElement>(".preview-composer-card");
  if (!card) throw new Error("Preview composer is missing");
  card.append(menu);
  pinAtMenu(card, menu);
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
    listProjects: async () => ({
      available: false,
      errorCode: "jarvis_failed",
      projects: [],
      complete: false,
      userId: null,
    }),
    previewProjectBugTitle: async () => ({
      available: false,
      errorCode: "jarvis_failed",
      conditions: [],
      bugs: [],
      total: 0,
      capped: false,
    }),
    searchProjectBugs: async () => ({
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
  await previewKey(editor, "ArrowDown");
  document.body.dataset.entryKeyboardHandoff = String(
    dingtalkRow?.getAttribute("aria-current") === "true" &&
      lastNative?.getAttribute("aria-current") !== "true",
  );
  await previewKey(editor, "ArrowDown");
  const walkedToJarvis = jarvisRow?.getAttribute("aria-current") === "true";
  await previewKey(editor, "ArrowUp");
  document.body.dataset.entryWorkbenchWalk = String(
    walkedToJarvis &&
      dingtalkRow?.getAttribute("aria-current") === "true" &&
      jarvisRow?.getAttribute("aria-current") !== "true",
  );
  await previewKey(editor, "Enter");
  await waitFor(() => document.body.dataset.entryOpened === "true");
}

interface JarvisPreviewBug {
  id: number;
  title: string;
  status?: number;
  priority?: number;
  severity?: number;
  updatedAt?: string;
}

function previewBug(
  id: number,
  title: string,
  overrides: Partial<JarvisPreviewBug> = {},
): JarvisPreviewBug {
  return {
    id,
    title,
    status: 1,
    priority: 3,
    severity: 3,
    updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    ...overrides,
  };
}

const jarvisPreviewProjects = [
  "示例后台 · 迭代 B",
  "示例商城 · 迭代 A",
  "管货迭代 2026-09-15",
  "管货迭代 2026-09-01",
  "加盟商竞拍单 支持发起帮鉴定",
  "爱回收香港门店支持邮寄",
  "平台交易拍品打通直播拍品",
  "管货迭代 2026-06-09",
];

const jarvisPreviewVisibleProjects = [
  "寄售图文议价订单自动发货",
  "回收商商品发货接入顺店通",
  "发货流程调整发货后出库",
  "发货单详情 增加打印质检报告",
];

const jarvisPreviewTitles: JarvisPreviewBug[] = [
  previewBug(9101, "示例：发货单列表筛选类型未生效", { priority: 1, severity: 2 }),
  previewBug(9102, "示例：买家单平台发货类型错误", {
    updatedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
  }),
  previewBug(9103, "示例：发货后出库状态未同步", {
    status: 2,
    priority: 2,
    severity: 1,
    updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
  }),
  previewBug(9104, "示例：批量发货缺少面单图片", {
    priority: 3,
    severity: 3,
    updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  }),
];

const jarvisPreviewParsedConditions: JarvisBugCondition[] = [
  { key: "scope:assigned", kind: "scope", label: "指派给我" },
  { key: "status:1", kind: "status", label: "未解决" },
  { key: "priority:1", kind: "priority", label: "高优先级" },
  { key: "title", kind: "title", label: "标题含「发货」" },
];

interface JarvisTwoStepOptions {
  step: "project" | "bug";
  /** First-step cache and background revalidation payload. */
  projects?: string[];
  projectsPending?: boolean;
  projectsError?: string;
  /** Type this into the project search field. */
  projectQuery?: string;
  /** Seed the short-lived project cache before opening the panel. */
  seedCache?: string[];
  /** Leave the cache empty so the first step must ask the Host. */
  skipCache?: boolean;
  /** Seed the remembered project; opens directly in the bug step. */
  seedLastProject?: string;
  /** Bug-step preview payload. */
  preview?: {
    titles?: string[];
    pending?: boolean;
    errorCode?: string;
    delayMs?: number;
  };
  /** Bug-step parse payload, triggered by Enter. */
  parse?: { titles: string[]; conditions: JarvisBugCondition[] } | "fail" | "pending";
  /** Type this into the bug search field before the capture. */
  bugQuery?: string;
  pressEnter?: boolean;
  /** Click this condition chip after the parse is shown. */
  removeChip?: string;
  ready?: (step: HTMLElement) => boolean;
}

function jarvisResult(
  titles: readonly string[] | undefined,
  conditions: JarvisBugCondition[] = [],
): JarvisBugSearchResult {
  const bugs = (titles ?? jarvisPreviewTitles.map((bug) => bug.title)).map((title, index) => {
    const fixture = jarvisPreviewTitles.find((bug) => bug.title === title);
    return {
      id: fixture?.id ?? 9200 + index,
      projectId: 9001,
      title,
      status: fixture?.status ?? 1,
      priority: fixture?.priority ?? 3,
      severity: fixture?.severity ?? 3,
      updatedAt: fixture?.updatedAt ?? new Date(Date.now() - index * 40 * 60_000).toISOString(),
    };
  });
  return {
    available: true,
    errorCode: null,
    conditions,
    bugs,
    total: bugs.length,
    capped: false,
  };
}

async function mountJarvisTwoStep(options: JarvisTwoStepOptions): Promise<void> {
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
  editor.textContent = "@";
  const menu = nativeAtMenu();
  card.append(menu);
  pinAtMenu(card, menu);

  localStorage.removeItem("codexhost.jarvis.projects.v1.local");
  localStorage.removeItem("codexhost.jarvis.last-project.v1.local.10058");
  const cache = options.seedCache ?? options.projects ?? jarvisPreviewProjects;
  if (!options.skipCache) {
    localStorage.setItem(
      "codexhost.jarvis.projects.v1.local",
      JSON.stringify({
        userId: 10058,
        savedAt: Date.now(),
        projects: cache.map((name, index) => ({ id: 9001 + index, name })),
      }),
    );
  }
  if (options.seedLastProject) {
    localStorage.setItem(
      "codexhost.jarvis.last-project.v1.local.10058",
      JSON.stringify({
        savedAt: Date.now(),
        project: {
          id: 9001 + cache.indexOf(options.seedLastProject),
          name: options.seedLastProject,
        },
      }),
    );
  }

  installRendererJarvisMention(document, {
    isComposerEditor: (element) => element === editor,
    readHostId: () => "local",
    readLocale: () => locale,
    anchorForEditor: () => card,
    openSettings: () => {
      document.body.dataset.jarvisSettingsOpened = "true";
    },
    listProjects: async (_hostId, params) => {
      if (options.projectsPending) return new Promise(() => undefined);
      await delay(120);
      if (options.projectsError) {
        return {
          available: false,
          errorCode: options.projectsError,
          projects: [],
          complete: false,
          userId: null,
        };
      }
      const names = params.query
        ? (options.projects ?? jarvisPreviewVisibleProjects).filter((name) =>
            name.includes(params.query ?? ""),
          )
        : (options.projects ?? jarvisPreviewProjects);
      return {
        available: true,
        errorCode: null,
        projects: names.map((name, index) => ({ id: 9001 + index, name })),
        complete: true,
        userId: 10058,
      };
    },
    previewProjectBugTitle: async (_hostId, params) => {
      if (options.preview?.pending) return new Promise(() => undefined);
      await delay(options.preview?.delayMs ?? 100);
      if (options.preview?.errorCode) {
        return {
          available: false,
          errorCode: options.preview.errorCode,
          conditions: [],
          bugs: [],
          total: 0,
          capped: false,
        };
      }
      const titles = options.preview?.titles ?? jarvisPreviewTitles.map((bug) => bug.title);
      const trimmed = params.title.trim();
      const matched = trimmed ? titles.filter((title) => title.includes(trimmed)) : titles;
      return jarvisResult(matched, []);
    },
    searchProjectBugs: async (_hostId, params) => {
      if (options.parse === "pending") return new Promise(() => undefined);
      await delay(140);
      if (options.parse === "fail") {
        return {
          available: false,
          errorCode: "timeout",
          conditions: [],
          bugs: [],
          total: 0,
          capped: false,
        };
      }
      const parsed = options.parse ?? {
        titles: jarvisPreviewTitles.map((bug) => bug.title),
        conditions: jarvisPreviewParsedConditions,
      };
      const conditions = parsed.conditions.filter(
        (condition) => !params.omit?.includes(condition.key),
      );
      return jarvisResult(parsed.titles, conditions);
    },
  });

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
  await previewClick(row);
  const panelStep = await waitFor(() =>
    document.querySelector<HTMLElement>("[data-codexhost-jarvis-step]"),
  );
  if (options.step === "bug" || options.seedLastProject) {
    const bugStep = await waitFor(() =>
      document.querySelector<HTMLElement>("[data-codexhost-jarvis-step='bug']"),
    );
    if (options.bugQuery) {
      const input = bugStep.querySelector<HTMLInputElement>("input");
      if (!input) throw new Error("Bug search field is missing");
      await previewType(input, options.bugQuery);
      await delay(420);
    }
    if (options.pressEnter) {
      const input = bugStep.querySelector<HTMLInputElement>("input");
      if (!input) throw new Error("Bug search field is missing");
      await previewKey(input, "Enter");
    }
    if (options.removeChip) {
      const chip = await waitFor(() =>
        bugStep.querySelector<HTMLElement>(`[data-jarvis-chip='${options.removeChip}']`),
      );
      await previewClick(chip);
    }
    await waitFor(
      () =>
        (options.ready?.(bugStep) ??
        Boolean(bugStep.querySelector("[data-codexhost-jarvis-bug]")) ??
        true)
          ? bugStep
          : null,
      4_000,
    );
    await delay(150);
    return;
  }
  if (options.projectsPending || options.projectsError) {
    await waitFor(
      () =>
        (
          options.projectsError
            ? panelStep.textContent?.includes("未登录 Jarvis")
            : panelStep.querySelector("[data-codexhost-jarvis-skeleton]") !== null
        )
          ? panelStep
          : null,
      4_000,
    );
    await delay(120);
    return;
  }
  if (options.projectQuery) {
    const input = panelStep.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Project search field is missing");
    await previewType(input, options.projectQuery);
    await delay(420);
  }
  await waitFor(
    () =>
      (options.ready?.(panelStep) ??
      Boolean(panelStep.querySelector("[data-codexhost-jarvis-project]")))
        ? panelStep
        : null,
    4_000,
  );
  await delay(150);
}

async function mountJarvisEntryOnly(withQuery: boolean): Promise<void> {
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
  editor.textContent = withQuery ? "@我还没处理完的bug" : "@";
  const menu = nativeAtMenu();
  card.append(menu);
  pinAtMenu(card, menu);
  installRendererJarvisMention(document, {
    isComposerEditor: (element) => element === editor,
    readHostId: () => "local",
    readLocale: () => locale,
    anchorForEditor: () => card,
    listProjects: async () => ({
      available: false,
      errorCode: "jarvis_failed",
      projects: [],
      complete: false,
      userId: null,
    }),
    previewProjectBugTitle: async () => ({
      available: false,
      errorCode: "jarvis_failed",
      conditions: [],
      bugs: [],
      total: 0,
      capped: false,
    }),
    searchProjectBugs: async () => ({
      available: false,
      errorCode: "jarvis_failed",
      conditions: [],
      bugs: [],
      total: 0,
      capped: false,
    }),
  });
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
  await waitFor(() => document.querySelector("[data-codexhost-jarvis-entry-row]"), 4_000);
  await delay(80);
}

async function mountUnreadScenario(): Promise<void> {
  resetConversationMemory();
  const { query, queryAll } = mountSettings("dingtalk", false, false, "connected", false, false, {
    liveUnread: true,
  });
  await waitFor(() => query(".dingtalk-conversation"));
  await waitFor(() => query(".dingtalk-message"));
  const rows = queryAll<HTMLElement>(".dingtalk-conversation");
  const badges = queryAll(".dingtalk-unread-badge, .dingtalk-avatar-unread");
  document.body.dataset.initialUnread = String(badges.length);
  document.body.dataset.initialConversations = String(rows.length);
  const withBadge = rows.find((row) =>
    row.querySelector(".dingtalk-unread-badge, .dingtalk-avatar-unread"),
  );
  document.body.dataset.badgeTitle =
    withBadge?.querySelector(".dingtalk-conversation-title")?.textContent ?? "";
}

async function mountModelSettings(
  state: "empty" | "configured" | "testing" | "error" | "focus" | "hover" | "edit" | "add",
) {
  let settings: ModelServiceSettings = {
    provider: "openai",
    openai: { configured: false, lastFour: null },
    gemini: { configured: false, lastFour: null },
  };
  const client: RendererModelServiceClient = {
    async read() {
      return structuredClone(settings);
    },
    async update(value) {
      if (value.provider) settings.provider = value.provider;
      if (value.key)
        settings[value.key.provider] = {
          configured: value.key.value !== null,
          lastFour: value.key.value?.slice(-4) ?? null,
        };
      return structuredClone(settings);
    },
    async test() {
      if (state === "testing") return new Promise(() => {});
      return state === "error"
        ? { ok: false, latencyMs: null, errorCode: "quota_exhausted" }
        : { ok: true, latencyMs: 123, errorCode: null };
    },
  };
  const definitions = createDefaultRendererSettingsPages(
    messages,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    client,
  );
  const shell = installRendererSettingsShell(definitions, messages);
  shell.openSettings(undefined, "appearance");
  const shadow = shell.root.shadowRoot!;
  await waitFor(() =>
    shadow.querySelector<HTMLButtonElement>("#model-service-edit-gemini:not(:disabled)"),
  );
  const queryButton = (provider: string, text: string) =>
    [...shadow.querySelectorAll<HTMLButtonElement>(`[data-provider="${provider}"] button`)].find(
      (button) => button.textContent === text,
    )!;
  if (state !== "empty" && state !== "add") {
    for (const provider of ["gemini"]) {
      await previewClick(queryButton(provider, "添加"));
      const keyInput = shadow.querySelector<HTMLInputElement>(`#model-service-${provider}`)!;
      await previewClick(keyInput);
      await previewType(keyInput, `fake-preview-${provider}-1234`);
      await previewClick(queryButton(provider, "保存"));
      await waitFor(
        () =>
          !keyInput.value &&
          shadow.querySelector<HTMLElement>(`#model-service-editor-${provider}`)?.hidden,
      );
    }
  }
  if (state === "testing" || state === "error" || state === "configured") {
    await previewClick(queryButton("gemini", "测试"));
    await waitFor(() =>
      shadow.textContent?.includes(
        state === "testing"
          ? "正在测试…"
          : state === "error"
            ? "Gemini 额度不足"
            : "连接成功 123 毫秒",
      ),
    );
  }
  if (state === "edit" || state === "add") {
    await previewClick(queryButton("gemini", state === "add" ? "添加" : "更换"));
    const input = shadow.querySelector<HTMLInputElement>("#model-service-gemini")!;
    await previewType(input, "fake-preview-replacement-5678");
  }
  if (state === "focus") {
    await previewKey(queryButton("gemini", "测试"), "Tab");
  }
  if (state === "hover") await previewHover(queryButton("gemini", "更换"));
  document.body.dataset.modelServiceState = state;
  await delay(120);
}

const scenarios: Record<string, () => Promise<void>> = {
  async "code-repositories-settings"() {
    const definitions = createDefaultRendererSettingsPages(
      messages,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        async read() {
          return {
            provider: "openai",
            openai: { configured: true, lastFour: "demo" },
            gemini: { configured: false, lastFour: null },
          };
        },
        async update() {
          return this.read();
        },
        async test() {
          return { ok: true, latencyMs: 120, errorCode: null };
        },
      },
      createRepositoryPreviewClient(parameters.get("repository") ?? "ready"),
    );
    const shell = installRendererSettingsShell(definitions, messages);
    shell.openSettings(undefined, "appearance");
    await waitFor(() =>
      shell.root.shadowRoot?.querySelector<HTMLButtonElement>(
        "#repository-token-edit:not(:disabled)",
      ),
    );
    shell.root.shadowRoot?.querySelector("#code-repositories")?.scrollIntoView({ block: "center" });
  },
  async "dingtalk-heavy"() {
    interface HeavyMetrics {
      openToListMs: number;
      openToMessagesMs: number;
      renderTimeMs: number;
      renderedMessages: number;
      shadowNodes: number;
      heapBaselineBytes: number;
      heapAfterOpenBytes: number;
      longestLongTaskMs: number;
      longTasks: { start: number; duration: number }[];
      scenarioStartedAt: number;
      heapSupported: boolean;
      close(): Promise<{
        heapAfterCloseBytes: number;
        shadowNodesAfterClose: number;
        closeMs: number;
      }>;
    }
    const previewWindow = window as Window & {
      gc?: () => void;
      performance: Performance & { memory?: { usedJSHeapSize: number } };
      __dingtalkHeavy?: HeavyMetrics;
    };
    const heap = (): number => previewWindow.performance.memory?.usedJSHeapSize ?? 0;
    const longTasks: { start: number; duration: number }[] = [];
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      });
      observer.observe({ type: "longtask" });
    } catch {
      observer = null;
    }
    const prepared = prepareSettings("dingtalk", false, false, "connected", false, true);
    previewWindow.gc?.();
    await delay(60);
    previewWindow.gc?.();
    const baseline = heap();
    const started = performance.now();
    prepared.open();
    const { query, queryAll, shell } = prepared;
    await waitFor(() => query(".dingtalk-conversation"));
    const openToListMs = performance.now() - started;
    await waitFor(() => query(".dingtalk-message"));
    const openToMessagesMs = performance.now() - started;
    for (let page = 0; page < 8; page += 1) {
      const list = query<HTMLElement>(".dingtalk-message-list");
      if (!list) break;
      const before = queryAll(".dingtalk-message").length;
      if (before >= 200) break;
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll"));
      try {
        await waitFor(() => (queryAll(".dingtalk-message").length > before ? true : null), 3_000);
      } catch {
        break;
      }
    }
    const renderTimeMs = performance.now() - started;
    const renderedMessages = queryAll(".dingtalk-message").length;
    await delay(200);
    previewWindow.gc?.();
    await delay(60);
    previewWindow.gc?.();
    const heapAfterOpen = heap();
    const shadow = shell.root.shadowRoot;
    const shadowNodes = shadow ? shadow.querySelectorAll("*").length : 0;
    const relevantLongTasks = longTasks.filter((task) => task.start >= started);
    const longestLongTaskMs = relevantLongTasks.reduce(
      (max, task) => Math.max(max, task.duration),
      0,
    );
    observer?.disconnect();
    previewWindow.__dingtalkHeavy = {
      openToListMs,
      openToMessagesMs,
      renderTimeMs,
      renderedMessages,
      shadowNodes,
      heapBaselineBytes: baseline,
      heapAfterOpenBytes: heapAfterOpen,
      longestLongTaskMs,
      longTasks: relevantLongTasks,
      scenarioStartedAt: started,
      heapSupported: Boolean(previewWindow.performance.memory),
      async close() {
        const closeStarted = performance.now();
        shell.close();
        previewWindow.gc?.();
        await delay(60);
        previewWindow.gc?.();
        return {
          heapAfterCloseBytes: heap(),
          shadowNodesAfterClose: shadow ? shadow.querySelectorAll("*").length : 0,
          closeMs: performance.now() - closeStarted,
        };
      },
    };
  },

  async "dingtalk-list"() {
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await waitFor(() => query(".dingtalk-message"));
  },

  async "dingtalk-deduplicated"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk", false, false, "connected", false, false, {
      duplicateMessages: true,
      changeRepeats: 5,
      pushChangeAfterMs: 800,
    });
    await waitFor(() => query('[data-message-id^="preview-live-"]'));
    await delay(350);
  },

  async "dingtalk-send-echo"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk", false, false, "connected", false, false, {
      sendEcho: "before",
    });
    await waitFor(() => query(".dingtalk-message"));
  },

  async "dingtalk-send-ack"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk", false, false, "connected", false, false, {
      sendEcho: "after",
    });
    await waitFor(() => query(".dingtalk-message"));
  },

  async "dingtalk-hover"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    await waitFor(() => query(".dingtalk-message"));
  },

  async "dingtalk-conversation-hover"() {
    await scenarios["dingtalk-hover"]();
  },

  async "dingtalk-image-unavailable"() {
    await scenarios["dingtalk-hover"]();
  },

  async "dingtalk-lightbox"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    await waitFor(() => query(".dingtalk-message-image--clickable"));
    await waitFor(() => query(".dingtalk-message-image--loaded"));
    await delay(120);
  },

  async "dingtalk-at-picker"() {
    resetConversationMemory();
    const { query, queryAll } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    const group = queryAll<HTMLButtonElement>(".dingtalk-conversation").find((row) =>
      row.textContent?.includes("产品发布群"),
    );
    group?.click();
    await waitFor(() => query(".dingtalk-main-title")?.textContent === "产品发布群");
    await waitFor(() => query(".dingtalk-message"));
  },

  async "dingtalk-header-menu"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
  },

  async "dingtalk-page-menu"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
  },

  async "dingtalk-empty-menu"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk", true);
    await waitFor(() => query(".dingtalk-empty-list"));
  },

  async "dingtalk-empty-menu-narrow"() {
    await scenarios["dingtalk-empty-menu"]();
  },

  async "dingtalk-header-menu-open"() {
    await scenarios["dingtalk-header-menu"]();
  },

  async "dingtalk-header-menu-narrow"() {
    await scenarios["dingtalk-header-menu"]();
  },

  async "dingtalk-at-send"() {
    resetConversationMemory();
    const { query, queryAll } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    const group = queryAll<HTMLButtonElement>(".dingtalk-conversation").find((row) =>
      row.textContent?.includes("产品发布群"),
    );
    group?.click();
    await waitFor(() => query(".dingtalk-main-title")?.textContent === "产品发布群");
    await waitFor(() => query(".dingtalk-message"));
  },

  async "dingtalk-at-chip"() {
    resetConversationMemory();
    const { query, queryAll } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    const group = queryAll<HTMLButtonElement>(".dingtalk-conversation").find((row) =>
      row.textContent?.includes("产品发布群"),
    );
    group?.click();
    await waitFor(() => query(".dingtalk-main-title")?.textContent === "产品发布群");
    await waitFor(() => query(".dingtalk-message"));
  },

  async "dingtalk-unread"() {
    await mountUnreadScenario();
  },

  async "dingtalk-unread-open"() {
    await mountUnreadScenario();
  },

  async "dingtalk-unread-left"() {
    await mountUnreadScenario();
  },

  async "dingtalk-live"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk", false, false, "connected", false, false, {
      pushChangeAfterMs: 1_200,
    });
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    const count =
      query(".dingtalk-message-list")?.querySelectorAll(".dingtalk-message").length ?? 0;
    document.body.dataset.initialMessages = String(count);
    await waitFor(
      () => query(".dingtalk-message-list")?.textContent?.includes("刚刚收到一条新消息") || null,
      6_000,
    );
    await delay(200);
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
    // Warm the synthetic missing image, then return to the newest messages.
    query('[data-message-id="msg-launch-193"]')?.scrollIntoView({ block: "center" });
    await delay(200);
    const list = query<HTMLElement>(".dingtalk-message-list");
    if (list) list.scrollTop = list.scrollHeight;
    await delay(200);
  },

  async "dingtalk-direct"() {
    const { query, queryAll } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    const row = await waitFor(() =>
      queryAll<HTMLButtonElement>(".dingtalk-conversation").find(
        (item) => item.textContent?.includes("林晓") && !item.textContent?.includes("群"),
      ),
    );
    await previewClick(row);
    await waitFor(() => query(".dingtalk-main-title")?.textContent === "林晓");
    await waitFor(() => query(".dingtalk-message"));
  },

  async "dingtalk-scrolled-top"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    await waitFor(() => query(".dingtalk-message-list"));
  },

  async "dingtalk-search"() {
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
  },

  async "dingtalk-search-empty"() {
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
  },

  async "dingtalk-search-contacts"() {
    await scenarios["dingtalk-search"]();
  },

  async "dingtalk-contact-open"() {
    await scenarios["dingtalk-search"]();
  },

  async "dingtalk-loading"() {
    const { query } = mountSettings("dingtalk", false, false, "connected", false, false, {
      conversationsPending: true,
    });
    await waitFor(() => query(".dingtalk-skeleton-list"));
  },

  async "dingtalk-search-more"() {
    const { query, queryAll } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    const input = query<HTMLInputElement>(".dingtalk-search-input");
    if (!input) throw new Error("Search input is missing");
    await previewType(input, "示例Sprint");
    const more = await waitFor(() =>
      query<HTMLButtonElement>(".dingtalk-search-result--conversation")
        ? query<HTMLButtonElement>(".dingtalk-search-more")
        : null,
    );
    await previewClick(more);
    await waitFor(() => queryAll(".dingtalk-search-result--conversation").length >= 4);
    await delay(120);
  },

  async "dingtalk-empty"() {
    const { query } = mountSettings("dingtalk", true, false);
    await waitFor(() => query(".dingtalk-empty-list"));
  },

  async "dingtalk-error"() {
    const { query } = mountSettings("dingtalk", false, true);
    await waitFor(() => query(".dingtalk-empty-list"));
  },

  async "agents-dispatch-status"() {
    const { query } = mountSettings("codex-agents");
    await waitFor(() => query(".agent-dingtalk-status:not([hidden])"));
  },

  async "agents-dispatch-missing-key"() {
    const { query } = mountSettings("codex-agents");
    await waitFor(() => query(".agent-dingtalk-status:not([hidden])"));
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
    await previewClick(card);
    await waitFor(() => query(".agent-editor:not([hidden])"));
  },

  async "agents-menu"() {
    const { query } = mountSettings("codex-agents");
    await waitFor(() => query(".agent-card-tag--dispatch"));
    const card = await waitFor(() => query<HTMLElement>('.agent-card[data-agent-name="writer"]'));
    const button = await waitFor(() => card.querySelector<HTMLButtonElement>(".agent-card-menu"));
    await previewClick(button);
    await waitFor(() => query(".agent-menu"));
    await delay(120);
  },

  async "agents-delete-confirm"() {
    const { query } = mountSettings("codex-agents");
    await waitFor(() => query(".agent-card-tag--dispatch"));
    const card = await waitFor(() => query<HTMLElement>('.agent-card[data-agent-name="writer"]'));
    const button = await waitFor(() => card.querySelector<HTMLButtonElement>(".agent-card-menu"));
    await previewClick(button);
    const menu = await waitFor(() => query(".agent-menu"));
    const remove = await waitFor(() =>
      [...menu.querySelectorAll<HTMLButtonElement>(".agent-menu-item")].find(
        (item) => item.textContent === "删除",
      ),
    );
    await previewClick(remove);
    await waitFor(() => query<HTMLDialogElement>(".agent-confirm[open]"));
    await delay(120);
  },

  async "agents-edit-dingtalk-on"() {
    const { query } = mountSettings("codex-agents");
    const card = await waitFor(() => query<HTMLElement>('.agent-card[data-agent-name="writer"]'));
    await previewClick(card);
    await waitFor(() => query(".agent-editor:not([hidden])"));
    await waitFor(() => query<HTMLInputElement>(".agent-dingtalk-switch input")?.checked === true);
    await waitFor(() => query('.agent-dingtalk-body[data-disabled="false"]'));
    await delay(200);
    const body = query<HTMLElement>(".agent-editor-body");
    if (!body) throw new Error("Editor body is missing");
    body.scrollTop = body.scrollHeight;
    await delay(180);
  },

  async "agents-edit-dingtalk-off"() {
    const { query } = mountSettings("codex-agents");
    const card = await waitFor(() =>
      query<HTMLElement>('.agent-card[data-agent-name="researcher"]'),
    );
    await previewClick(card);
    await waitFor(() => query(".agent-editor:not([hidden])"));
    await waitFor(() => query<HTMLInputElement>(".agent-dingtalk-switch input")?.checked === false);
    await waitFor(() => query('.agent-dingtalk-body[data-disabled="true"]'));
    await delay(200);
    const body = query<HTMLElement>(".agent-editor-body");
    if (!body) throw new Error("Editor body is missing");
    body.scrollTop = body.scrollHeight;
    await delay(180);
  },

  async "agents-name-error"() {
    const { query } = mountSettings("codex-agents");
    await waitFor(() => query(".agent-card-tag--dispatch"));
    const card = await waitFor(() => query<HTMLElement>(".agent-card--new"));
    await previewClick(card);
    await waitFor(() => query(".agent-editor:not([hidden])"));
    const description = query<HTMLTextAreaElement>(".agent-editor textarea");
    const instructions = query<HTMLTextAreaElement>(".agent-instructions");
    if (!description || !instructions) throw new Error("Agent fields are missing");
    description.value = "测试描述";
    description.dispatchEvent(new Event("input", { bubbles: true }));
    instructions.value = "测试指令";
    instructions.dispatchEvent(new Event("input", { bubbles: true }));
    const form = query<HTMLFormElement>(".agent-editor form");
    if (!form) throw new Error("Agent form is missing");
    form.requestSubmit();
    await waitFor(() => query('.agent-field-error[data-field="name"]:not([hidden])'));
    await delay(150);
  },

  async "agents-dingtalk-threshold"() {
    const { query, shell } = mountSettings("codex-agents");
    await waitFor(() => query(".dingtalk-listener"));
    await waitFor(() => query(".agent-card-tag--dispatch"));
    const page = shell.root.shadowRoot?.querySelector<HTMLElement>(".settings-page");
    if (!page) throw new Error("Settings page scroller is missing");
    await delay(100);
    page.scrollTop = page.scrollHeight;
    await delay(180);
  },

  async "jarvis-settings"() {
    const { query } = mountSettings("jarvis");
    await waitFor(() => query(".settings-jarvis-machines .settings-jarvis-row"));
    await delay(120);
  },

  ...Object.fromEntries(
    ["empty", "loading", "error", "save-error"].map((state) => [
      `thread-folders-${state}`,
      async () => {
        document.querySelector('link[href="/shadow-context.css"]')?.remove();
        await loadDesktopCss();
        mountThreadFoldersPreview(root!, `thread-folders-${state}`);
      },
    ]),
  ),
  async "thread-folders-local"() {
    document.querySelector('link[href="/shadow-context.css"]')?.remove();
    await loadDesktopCss();
    mountThreadFoldersPreview(root!, "thread-folders-local");
  },
  async "thread-folders-remote"() {
    document.querySelector('link[href="/shadow-context.css"]')?.remove();
    await loadDesktopCss();
    mountThreadFoldersPreview(root!, "thread-folders-remote");
  },
  async "thread-folders-existing"() {
    document.querySelector('link[href="/shadow-context.css"]')?.remove();
    await loadDesktopCss();
    mountThreadFoldersPreview(root!, "thread-folders-existing");
  },
  async "thread-folders-limited"() {
    document.querySelector('link[href="/shadow-context.css"]')?.remove();
    await loadDesktopCss();
    mountThreadFoldersPreview(root!, "thread-folders-limited");
  },
  async "sidebar-sections"() {
    document.querySelector('link[href="/shadow-context.css"]')?.remove();
    await loadDesktopCss();
    mountSidebarSectionsPreview(root!, "merged");
  },
  async "sidebar-sections-grouped"() {
    document.querySelector('link[href="/shadow-context.css"]')?.remove();
    await loadDesktopCss();
    mountSidebarSectionsPreview(root!, "grouped");
  },

  async "sidebar-sections-new-chat"() {
    document.querySelector('link[href="/shadow-context.css"]')?.remove();
    await loadDesktopCss();
    const preview = mountSidebarSectionsPreview(root!, "merged");
    preview.simulateNewChat();
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
    await mountJarvisEntryOnly(false);
  },

  async "jarvis-entry-query"() {
    await mountJarvisEntryOnly(true);
  },

  async "jarvis-projects"() {
    await mountJarvisTwoStep({ step: "project", seedCache: jarvisPreviewProjects });
  },

  async "jarvis-projects-search"() {
    await mountJarvisTwoStep({
      step: "project",
      projectQuery: "发货",
      projects: jarvisPreviewVisibleProjects,
    });
  },

  async "jarvis-projects-loading"() {
    await mountJarvisTwoStep({
      step: "project",
      projectsPending: true,
      skipCache: true,
    });
  },

  async "jarvis-projects-empty"() {
    await mountJarvisTwoStep({
      step: "project",
      projectQuery: "不存在",
      projects: [],
      ready: (step) => step.textContent?.includes("无结果") === true,
    });
  },

  async "jarvis-projects-error"() {
    await mountJarvisTwoStep({
      step: "project",
      projectsError: "not_logged_in",
      skipCache: true,
    });
  },

  async "jarvis-bugs-preview"() {
    await mountJarvisTwoStep({
      step: "bug",
      seedCache: jarvisPreviewProjects,
      seedLastProject: "示例后台 · 迭代 B",
      bugQuery: "发货",
      preview: { titles: jarvisPreviewTitles.map((bug) => bug.title) },
    });
  },

  async "jarvis-bugs-conditions"() {
    await mountJarvisTwoStep({
      step: "bug",
      seedCache: jarvisPreviewProjects,
      seedLastProject: "示例后台 · 迭代 B",
      bugQuery: "发货",
      pressEnter: true,
      preview: { titles: jarvisPreviewTitles.map((bug) => bug.title) },
      parse: {
        titles: jarvisPreviewTitles.slice(0, 2).map((bug) => bug.title),
        conditions: jarvisPreviewParsedConditions,
      },
      ready: (step) => step.querySelectorAll("[data-jarvis-chip]").length >= 4,
    });
  },

  async "jarvis-bugs-unparsed"() {
    await mountJarvisTwoStep({
      step: "bug",
      seedCache: jarvisPreviewProjects,
      seedLastProject: "示例后台 · 迭代 B",
      bugQuery: "发货",
      pressEnter: true,
      preview: { titles: jarvisPreviewTitles.map((bug) => bug.title) },
      parse: "fail",
      ready: (step) => step.textContent?.includes("条件未识别，已按标题搜索") === true,
    });
  },

  async "jarvis-bugs-empty"() {
    await mountJarvisTwoStep({
      step: "bug",
      seedCache: jarvisPreviewProjects,
      seedLastProject: "示例后台 · 迭代 B",
      preview: { titles: [] },
      ready: (step) => step.textContent?.includes("无结果") === true,
    });
  },

  async "jarvis-bugs-error"() {
    await mountJarvisTwoStep({
      step: "bug",
      seedCache: jarvisPreviewProjects,
      seedLastProject: "示例后台 · 迭代 B",
      preview: { errorCode: "not_logged_in" },
      ready: (step) => step.textContent?.includes("未登录 Jarvis") === true,
    });
  },

  async "jarvis-bugs-loading"() {
    await mountJarvisTwoStep({
      step: "bug",
      seedCache: jarvisPreviewProjects,
      seedLastProject: "示例后台 · 迭代 B",
      preview: { pending: true },
      ready: () => true,
    });
  },

  async "jarvis-bugs-many"() {
    const titles = Array.from(
      { length: 14 },
      (_, index) => `示例：第 ${index + 1} 条待处理的发货 Bug`,
    );
    await mountJarvisTwoStep({
      step: "bug",
      seedCache: jarvisPreviewProjects,
      seedLastProject: "示例后台 · 迭代 B",
      preview: { titles },
      ready: (step) => step.querySelectorAll("[data-codexhost-jarvis-bug]").length >= 14,
    });
  },

  async "jarvis-bugs-chip-removed"() {
    await mountJarvisTwoStep({
      step: "bug",
      seedCache: jarvisPreviewProjects,
      seedLastProject: "示例后台 · 迭代 B",
      bugQuery: "发货",
      pressEnter: true,
      preview: { titles: jarvisPreviewTitles.map((bug) => bug.title) },
      parse: {
        titles: jarvisPreviewTitles.slice(0, 2).map((bug) => bug.title),
        conditions: jarvisPreviewParsedConditions,
      },
      removeChip: "status:1",
      ready: (step) =>
        step.querySelectorAll("[data-jarvis-chip]").length === 3 &&
        step.querySelector("[data-jarvis-chip='status:1']") === null,
    });
  },

  async "model-service-empty"() {
    await mountModelSettings("empty");
  },
  async "model-service-configured"() {
    await mountModelSettings("configured");
  },
  async "model-service-testing"() {
    await mountModelSettings("testing");
  },
  async "model-service-error"() {
    await mountModelSettings("error");
  },
  async "model-service-focus"() {
    await mountModelSettings("focus");
  },
  async "model-service-hover"() {
    await mountModelSettings("hover");
  },
  async "model-service-edit"() {
    await mountModelSettings("edit");
  },
  async "model-service-add"() {
    await mountModelSettings("add");
  },
  async "harness-picker"() {
    const stage = mountStage(`
      <main class="preview-canvas preview-canvas--composer">
        <div class="preview-composer-card" data-composer-body>
          <div class="preview-composer-editor" contenteditable="true">hello</div>
          <div class="preview-agent-toolbar"></div>
        </div>
      </main>`);
    const toolbar = stage.querySelector<HTMLElement>(".preview-agent-toolbar");
    const editor = stage.querySelector<HTMLElement>(".preview-composer-editor");
    if (!toolbar || !editor) throw new Error("Composer preview is missing");
    const state = { agent: "codex" as string, phase: "draft" as const };
    const picker = mountRendererAgentPicker(
      "preview-harness-picker",
      ["codex", "claude-code", "grok"],
      (agent) => {
        document.body.dataset.selectedAgent = agent;
        state.agent = agent;
        renderRendererAgentPicker(picker, state, "ready", false, {
          "claude-code": "ready",
          grok: "ready",
        });
      },
      () => {},
    );
    toolbar.append(picker.root);
    renderRendererAgentPicker(picker, state, "ready", false, {
      "claude-code": "ready",
      grok: "ready",
    });
    editor.focus();
    await previewClick(picker.trigger);
    const menu = await waitFor(() => document.getElementById("preview-harness-picker-agent-menu"));
    // Desktop rebuilds the Composer chrome when a press escapes the menu. The
    // picker rows must keep the press inside the menu for the click to land.
    document.addEventListener("pointerdown", (event) => {
      if (event.defaultPrevented) return;
      if (!event.composedPath().includes(menu)) return;
      document.body.dataset.toolbarTornDown = "true";
      picker.root.remove();
    });
    const target = menu.querySelector<HTMLElement>('button[data-agent="claude-code"]');
    if (!target) throw new Error("Agent menu row is missing");
    await previewClick(target);
    await waitFor(() => document.body.dataset.selectedAgent === "claude-code");
    // Reopen so the capture shows the menu that the press just kept alive.
    await previewClick(picker.trigger);
    await waitFor(() => menu.matches(":popover-open"));
    document.body.dataset.harnessPicker = String(Boolean(menu.isConnected));
  },
};

async function main() {
  const run = scenarios[scenarioName];
  if (!run) throw new Error(`Unknown preview scenario: ${scenarioName}`);
  try {
    await applyDesktopTheme(theme);
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
