import { mountSkillsPreview } from "./skills.js";
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
import {
  mountRendererAgentPicker,
  renderRendererAgentPicker,
} from "../../../packages/renderer-extension/src/renderer-agent-picker.js";
import { ProjectGroupNewChatPicker } from "../../../packages/renderer-extension/src/renderer-project-groups-new-chat.js";
import {
  ProjectGroupHeaders,
  type ProjectGroupHeaderItem,
} from "../../../packages/renderer-extension/src/renderer-project-groups-header.js";
import {
  ProjectGroupLayoutStyle,
  PROJECT_GROUP_EMPTY_ATTRIBUTE,
  type ProjectGroupLayoutMember,
} from "../../../packages/renderer-extension/src/renderer-project-groups-layout.js";
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
import {
  projectGroupEmptyVisibility,
  projectGroupMachineSummary,
  type ProjectGroupAddMachineResult,
  type ProjectGroupAddMachineTarget,
  type ProjectGroupMachineView,
  type ProjectGroupProjectView,
  type ProjectGroupView,
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
  const agentsClient = createFakeCodexAgentsClient({ withAgents: !agentsEmpty });
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

interface PreviewProjectMachine {
  key: string;
  label: string;
  projectId: string;
  threads: string[];
}

/** Native-shaped sidebar used by the empty-machine preview scenarios. */
async function mountProjectGroupMachineScene(
  machines: readonly PreviewProjectMachine[],
): Promise<void> {
  await loadDesktopCss();
  const groupName = "示例工作台";
  const stage = mountStage(`
    <aside class="preview-projects preview-native-sidebar">
      <div class="preview-projects-heading">项目</div>
      <section data-app-action-sidebar-section data-app-action-sidebar-section-heading="Projects"
               data-app-action-sidebar-section-collapsed="false">
        <div class="preview-native-section-body">
          <div role="list" class="preview-native-project-list"></div>
        </div>
      </section>
    </aside>
    <main class="preview-canvas preview-canvas--composer"></main>`);
  const list = stage.querySelector<HTMLElement>(".preview-native-project-list");
  if (!list) throw new Error("Native project list is missing");
  for (const machine of machines) {
    const unit = document.createElement("div");
    unit.setAttribute("role", "listitem");
    unit.className = "preview-project-unit";
    const wrapper = document.createElement("div");
    wrapper.setAttribute("role", "listitem");
    wrapper.setAttribute("aria-label", machine.label);
    const row = document.createElement("div");
    row.className = "preview-native-project-row";
    row.setAttribute("role", "button");
    row.setAttribute("aria-expanded", "true");
    row.setAttribute("data-app-action-sidebar-project-row", "");
    row.setAttribute("data-app-action-sidebar-project-id", machine.projectId);
    row.setAttribute("data-app-action-sidebar-project-label", groupName);
    row.setAttribute("data-app-action-sidebar-project-collapsed", "false");
    const leading = document.createElement("div");
    leading.className = "preview-native-project-leading";
    const kind = document.createElement("span");
    kind.setAttribute("data-sidebar-project-kind", machine.key === "local" ? "local" : "remote");
    const label = document.createElement("span");
    label.textContent = groupName;
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    leading.append(kind, label, plus);
    const trailing = document.createElement("div");
    trailing.className = "preview-native-project-trailing";
    trailing.textContent = "···";
    row.append(leading, trailing);
    wrapper.append(row);
    const conversations = document.createElement("div");
    conversations.setAttribute("data-app-action-sidebar-project-list-id", machine.projectId);
    const conversationList = document.createElement("div");
    conversationList.setAttribute("role", "list");
    if (machine.threads.length === 0) {
      const empty = document.createElement("div");
      empty.className = "preview-empty-chat";
      empty.textContent = "暂无聊天";
      conversationList.append(empty);
    } else {
      for (const thread of machine.threads) {
        const threadRow = document.createElement("div");
        threadRow.className = "preview-thread-row";
        threadRow.setAttribute("data-app-action-sidebar-thread-row", "");
        threadRow.textContent = thread;
        conversationList.append(threadRow);
      }
    }
    conversations.append(conversationList);
    wrapper.append(conversations);
    unit.append(wrapper);
    list.append(unit);
  }

  const projects = machines.map(
    (machine) =>
      ({
        project: {
          member: {
            projectId: machine.projectId,
            projectKind: machine.key === "local" ? "local" : "remote",
          },
          entry: { projectId: machine.projectId },
          missing: null,
        },
        mounted: true,
        newChatAvailable: true,
      }) as unknown as ProjectGroupProjectView,
  );
  const machineViews: ProjectGroupMachineView[] = machines.map((machine, index) => ({
    key: machine.key,
    label: machine.label,
    state: "connected",
    projects: [projects[index]!],
  }));
  const group = {
    id: "preview-group",
    name: groupName,
    order: 0,
    collapsed: false,
    members: [],
  };
  const view = {
    group,
    projects,
    machines: machineViews,
    unresolved: [],
  } as unknown as ProjectGroupView;
  const emptyIds = new Set(
    machines.filter((machine) => machine.threads.length === 0).map((machine) => machine.projectId),
  );
  const visibility = projectGroupEmptyVisibility(view, emptyIds);
  const members: ProjectGroupLayoutMember[] = machines.map((machine) => ({
    projectId: machine.projectId,
    label: groupName,
    machineName: machine.label,
    kind: machine.key === "local" ? "local" : "remote",
  }));
  new ProjectGroupLayoutStyle(document).apply([
    { id: group.id, name: group.name, collapsed: false, members },
  ]);
  const summary = projectGroupMachineSummary(machineViews, visibility.visibleMachines);
  const items: ProjectGroupHeaderItem[] = [
    {
      id: group.id,
      name: group.name,
      machineSummary: summary.text,
      machineSummaryTitle: summary.title,
      projectIds: machines.map((machine) => machine.projectId),
    },
  ];
  new ProjectGroupHeaders(document, {
    toggleGroup: () => undefined,
    openNewChat: () => undefined,
    openManager: () => undefined,
    showMoreProjects: () => undefined,
  }).render(items, { collapsedGroups: new Set(), placeholders: new Map() });
  for (const projectId of visibility.hiddenProjectIds) {
    document
      .querySelector(
        `[data-app-action-sidebar-project-row][data-app-action-sidebar-project-id="${projectId}"]`,
      )
      ?.closest(".preview-project-unit")
      ?.setAttribute(PROJECT_GROUP_EMPTY_ATTRIBUTE, "true");
  }
  document.body.dataset.previewGroupEmpty = String(visibility.hiddenProjectIds.size);
  await delay(120);
}

async function openMachineMenu(onAddMachine: AddMachineHandler): Promise<void> {
  openProjectMenu(onAddMachine);
  const add = await waitFor(() =>
    document.querySelector<HTMLElement>("[data-codexhost-add-machine-row]"),
  );
  await previewClick(add);
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

const scenarios: Record<string, () => Promise<void>> = {
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

  async "dingtalk-hover"() {
    resetConversationMemory();
    const { query } = mountSettings("dingtalk");
    await waitFor(() => query(".dingtalk-conversation"));
    await openFirstConversation(query);
    await waitFor(() => query(".dingtalk-message"));
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
    const input = query<HTMLInputElement>(".dingtalk-search-input");
    if (!input) throw new Error("Search input is missing");
    await previewType(input, "示例Sprint");
    await waitFor(() => query(".dingtalk-search-result"));
    await delay(260);
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

  async "project-group-empty-machine"() {
    await mountProjectGroupMachineScene([
      {
        key: "remote",
        label: "示例新加坡",
        projectId: "preview-machine-remote",
        threads: ["示例：列表页加载失败", "示例：筛选条件未生效"],
      },
      { key: "local", label: "本机", projectId: "preview-machine-local", threads: [] },
    ]);
  },

  async "project-group-all-empty"() {
    await mountProjectGroupMachineScene([
      { key: "remote", label: "示例新加坡", projectId: "preview-machine-remote", threads: [] },
      { key: "local", label: "本机", projectId: "preview-machine-local", threads: [] },
    ]);
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
    await previewClick(row);
    await waitFor(() => row.getAttribute("aria-busy") === "true");
    await delay(120);
  },

  async "group-add-machine-error"() {
    await openMachineMenu(async () => ({ ok: false, message: "创建目录失败：权限不足。" }));
    const row = await waitFor(() =>
      document.querySelector<HTMLElement>('[data-codexhost-add-machine-host="host-build"]'),
    );
    await previewClick(row);
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

scenarios["skills-matrix"] = async () => {
  const shadow = mountSkillsPreview();
  await waitFor(() => shadow.querySelector(".skills-matrix tbody tr"));
};
scenarios["skills-conflict"] = async () => {
  const shadow = mountSkillsPreview();
  await waitFor(() => shadow.querySelector(".skills-matrix tbody tr"));
  const fill = [...shadow.querySelectorAll("button")].find(
    (button) => button.textContent === "全部补齐",
  );
  await previewClick(fill!);
  await waitFor(() => shadow.querySelector(".skills-version"));
  const radio = shadow.querySelector<HTMLInputElement>(".skills-version input");
  await previewClick(radio!);
  await previewInputOn(radio!, "key", { key: "ArrowDown" });
  await previewInputOn(shadow.querySelector<HTMLElement>("dialog h2")!, "hover");
};
scenarios["skills-link-preview"] = async () => {
  const shadow = mountSkillsPreview();
  await waitFor(() => shadow.querySelector(".skills-matrix tbody tr"));
  const link = [...shadow.querySelectorAll("button")].find(
    (button) => button.textContent === "一键链接",
  );
  await previewClick(link!);
  await waitFor(() => shadow.querySelector(".skills-link-row"));
};

scenarios["skills-hover"] = scenarios["skills-matrix"];
scenarios["skills-focus"] = async () => {
  const shadow = mountSkillsPreview();
  await waitFor(() => shadow.querySelector(".skills-matrix tbody tr"));
  await previewInputOn(shadow.querySelector<HTMLElement>("[data-skills-refresh]")!, "key", {
    key: "Tab",
  });
};
scenarios["skills-agents"] = async () => {
  const shadow = mountSkillsPreview();
  await waitFor(() => shadow.querySelector(".skills-matrix tbody tr"));
  await previewInputOn(shadow.querySelector<HTMLElement>(".skills-machine")!, "wheel", {
    deltaY: 600,
  });
};
scenarios["skills-exclusions"] = async () => {
  await scenarios["skills-agents"]();
  const shadow = document.querySelector("[data-codexhost-settings-shell]")!.shadowRoot!;
  await previewClick(shadow.querySelector<HTMLElement>(".skills-exclusions button")!);
  await waitFor(() => shadow.querySelector("dialog[open] select"));
};
scenarios["skills-link-choice"] = async () => {
  await scenarios["skills-link-preview"]();
  const shadow = document.querySelector("[data-codexhost-settings-shell]")!.shadowRoot!;
  await previewClick(shadow.querySelector<HTMLElement>("[data-skill-adoption]")!);
  await waitFor(() => shadow.querySelector<HTMLInputElement>("[data-skill-adoption]")?.checked);
  await previewInputOn(shadow.querySelector<HTMLElement>("[data-skill-adoption]")!, "key", {
    key: "Tab",
  });
};
scenarios["skills-link-focus"] = async () => {
  await scenarios["skills-link-preview"]();
  const shadow = document.querySelector("[data-codexhost-settings-shell]")!.shadowRoot!;
  await previewInputOn(shadow.querySelector<HTMLElement>("dialog")!, "key", { key: "Tab" });
  await waitFor(() => shadow.activeElement === shadow.querySelector("[data-skill-adoption]"));
};
scenarios["skills-link-checked-focus"] = async () => {
  await scenarios["skills-link-focus"]();
  const shadow = document.querySelector("[data-codexhost-settings-shell]")!.shadowRoot!;
  await previewInputOn(shadow.querySelector<HTMLElement>("[data-skill-adoption]")!, "key", {
    key: "Space",
  });
  await waitFor(() => shadow.querySelector<HTMLInputElement>("[data-skill-adoption]")?.checked);
};
scenarios["skills-agents-focus"] = async () => {
  await scenarios["skills-agents"]();
  const shadow = document.querySelector("[data-codexhost-settings-shell]")!.shadowRoot!;
  const buttons = shadow.querySelectorAll<HTMLElement>(".skills-machine-head button");
  await previewInputOn(buttons[0]!, "key", { key: "Tab" });
};
scenarios["skills-conflict-files"] = async () => {
  await scenarios["skills-conflict"]();
  const shadow = document.querySelector("[data-codexhost-settings-shell]")!.shadowRoot!;
  await previewClick(shadow.querySelector<HTMLElement>("dialog summary")!);
};
scenarios["skills-conflict-files-focus"] = async () => {
  await scenarios["skills-conflict"]();
  const shadow = document.querySelector("[data-codexhost-settings-shell]")!.shadowRoot!;
  await previewInputOn(shadow.querySelector<HTMLElement>(".skills-version input:checked")!, "key", {
    key: "Tab",
  });
  await previewInputOn(shadow.querySelector<HTMLElement>(".skills-file-summary")!, "key", {
    key: "Enter",
  });
  await waitFor(() => shadow.querySelector("details[open]"));
};
scenarios["skills-sync-selection"] = async () => {
  await scenarios["skills-matrix"]();
  const shadow = document.querySelector("[data-codexhost-settings-shell]")!.shadowRoot!;
  const sync = [...shadow.querySelectorAll(".skills-machine button")].find(
    (button) => button.textContent === "同步到其他机器…",
  );
  await previewClick(sync!);
  await waitFor(() => shadow.querySelector("dialog[open]"));
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
