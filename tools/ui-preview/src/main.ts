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
import type { JarvisBugSearchResult } from "@codexhost/shared-contracts";

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
    previewBug(9101, 9001, "示例后台 · 迭代 B", "示例：列表页加载失败", {
      priority: 1,
      severity: 2,
      updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    }),
    previewBug(9103, 9002, "示例商城 · 迭代 A", "示例：筛选条件未生效", {
      priority: 3,
      severity: 3,
      updatedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    }),
    previewBug(9104, 9003, "示例买 · 消息通知", "示例：消息通知未送达", {
      priority: 2,
      severity: 1,
      updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
    }),
    previewBug(9105, 9004, "示例买 · 标记迭代", "示例：列表标记未显示", {
      priority: 3,
      severity: 2,
      updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }),
  ],
  total: 4,
  capped: false,
};

const jarvisPreviewSingleBug: JarvisBugSearchResult = {
  available: true,
  errorCode: null,
  conditions: [{ key: "status:1", kind: "status", label: "未解决" }],
  bugs: [previewBug(9301, 9001, "示例后台 · 迭代 B", "示例：列表页加载失败", { priority: 1 })],
  total: 1,
  capped: false,
};

const jarvisPreviewMany: JarvisBugSearchResult = {
  available: true,
  errorCode: null,
  conditions: [
    { key: "status:1", kind: "status", label: "未解决" },
    { key: "order:newest", kind: "order", label: "最新" },
  ],
  bugs: Array.from({ length: 14 }, (_, index) =>
    previewBug(
      9400 + index,
      9001 + (index % 3),
      `示例项目 ${(index % 3) + 1}`,
      `示例：第 ${index + 1} 条待处理 Bug`,
      {
        // The active condition is 「未解决」; every fixture row must match it.
        status: 1,
        priority: (index % 3) + 1,
        severity: (index % 4) + 1,
        updatedAt: new Date(Date.now() - index * 40 * 60_000).toISOString(),
      },
    ),
  ),
  total: 14,
  capped: false,
};

const jarvisPreviewProjectRecent: JarvisBugSearchResult = {
  available: true,
  errorCode: null,
  conditions: [
    { key: "scope:assigned", kind: "scope", label: "指派给我" },
    { key: "project:示例买", kind: "project", label: "示例买 ×2 个项目" },
    { key: "order:newest", kind: "order", label: "最新" },
  ],
  bugs: [
    previewBug(9201, 9003, "示例买 · 消息通知", "示例：消息通知未送达", {
      priority: 2,
      severity: 1,
      updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    }),
    previewBug(9202, 9004, "示例买 · 标记迭代", "示例：列表标记未显示", {
      status: 2,
      priority: 3,
      severity: 2,
      updatedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    }),
    previewBug(9203, 9003, "示例买 · 消息通知", "示例：通知开关无效", {
      priority: 3,
      severity: 3,
      updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
    }),
    previewBug(9204, 9004, "示例买 · 标记迭代", "示例：标记颜色错误", {
      priority: 3,
      severity: 3,
      updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }),
  ],
  total: 4,
  capped: false,
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
    previewBug(9101, 9001, "示例后台 · 迭代 B", "示例：登录后无法进入工作台", {
      severity: 2,
    }),
    previewBug(9103, 9002, "示例商城 · 迭代 A", "示例：验证码不显示", {
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
  pinAtMenu(card, menu);
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
    search: async (_hostId, params, signal) => {
      document.body.dataset.jarvisLastQuery = params.query;
      previewWindow.__jarvisPreviewSearchCalls =
        (previewWindow.__jarvisPreviewSearchCalls ?? 0) + 1;
      const result = {
        ...preview.result,
        conditions: preview.result.conditions.filter(
          (condition) => !params.omit?.includes(condition.key),
        ),
      };
      signal?.addEventListener(
        "abort",
        () => {
          document.body.dataset.jarvisCancelled = String(
            Number(document.body.dataset.jarvisCancelled ?? 0) + 1,
          );
        },
        { once: true },
      );
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
  await previewClick(row);
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
  await previewType(input, query);
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
    shadow.querySelector<HTMLButtonElement>("#model-service-edit-openai:not(:disabled)"),
  );
  const queryButton = (provider: string, text: string) =>
    [...shadow.querySelectorAll<HTMLButtonElement>(`[data-provider="${provider}"] button`)].find(
      (button) => button.textContent === text,
    )!;
  if (state !== "empty" && state !== "add") {
    for (const provider of ["openai", "gemini"]) {
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
    await previewClick(queryButton("openai", "测试"));
    await waitFor(() =>
      shadow.textContent?.includes(
        state === "testing"
          ? "正在测试…"
          : state === "error"
            ? "OpenAI 额度不足"
            : "连接成功 123 毫秒",
      ),
    );
  }
  if (state === "edit" || state === "add") {
    await previewClick(queryButton("openai", state === "add" ? "添加" : "更换"));
    const input = shadow.querySelector<HTMLInputElement>("#model-service-openai")!;
    await previewType(input, "fake-preview-replacement-5678");
  }
  if (state === "focus") {
    await previewKey(queryButton("openai", "测试"), "Tab");
  }
  if (state === "hover") await previewHover(queryButton("openai", "更换"));
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
    await mountJarvisSearch(
      { result: jarvisPreviewResults, pending: true },
      "我还没处理的，标题有发货的",
    );
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
  async "jarvis-mode-openai-missing-key"() {
    await mountJarvisSearch(
      {
        result: { ...jarvisPreviewError, source: "openai", errorCode: "missing_key" },
        delayMs: 80,
      },
      "我还没处理的标题有发货的",
      true,
      (mode) =>
        document.body.dataset.jarvisLastQuery === "我还没处理的标题有发货的" &&
        mode.textContent?.includes("未配置 OpenAI Key") === true,
    );
  },
  async "jarvis-mode-openai-quota"() {
    await mountJarvisSearch(
      {
        result: { ...jarvisPreviewError, source: "openai", errorCode: "quota_exhausted" },
        delayMs: 80,
      },
      "我还没处理的标题有发货的",
      true,
      (mode) =>
        document.body.dataset.jarvisLastQuery === "我还没处理的标题有发货的" &&
        mode.textContent?.includes("OpenAI 额度不足") === true,
    );
  },

  async "jarvis-mode-openai-timeout"() {
    await mountJarvisSearch(
      { result: { ...jarvisPreviewError, source: "openai", errorCode: "timeout" }, delayMs: 80 },
      "我还没处理的标题有发货的",
      true,
      (mode) =>
        document.body.dataset.jarvisLastQuery === "我还没处理的标题有发货的" &&
        mode.textContent?.includes("解析超时") === true,
    );
  },

  async "jarvis-mode-slow"() {
    await mountJarvisSearch({ result: jarvisPreviewResults, pending: true }, "我还没处理完的bug");
    await delay(8_200);
  },

  async "jarvis-mode-single"() {
    await mountJarvisSearch({ result: jarvisPreviewSingleBug, delayMs: 80 }, "我还没处理完的bug");
  },

  async "jarvis-mode-many"() {
    await mountJarvisSearch({ result: jarvisPreviewMany, delayMs: 80 }, "我还没处理完的bug");
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
    await previewClick(chip);
    await waitFor(() => document.querySelector('[data-jarvis-chip="status:1"]') === null, 4_000);
    await delay(120);
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
