/**
 * Jarvis inside Codex Desktop's native `@` menu.
 *
 * Typing after `@` only reveals one 「Jarvis」 row in the 「工作台」 group; it
 * never searches by itself. Selecting the row opens a two-step panel inside the
 * same popup area:
 *
 *   1. projects — 「我的项目」 paints from a short-lived local cache while the
 *      Host revalidates it; typing searches visible projects;
 *   2. bugs — the chosen project becomes a removable chip. Typing paints a
 *      title preview, then runs the Gemini condition parse on its own 800 ms
 *      debounce. The pending panel says 「正在识别条件…」 and only the parse can
 *      replace it; a timeout or failure keeps the preview and offers 「重试」.
 *
 * Choosing a bug inserts the native mention chip whose
 * `jarvis://bug/<projectId>/<bugId>` path the Host expands on submit.
 */
import {
  formatJarvisMentionLink,
  jarvisMentionPath,
  type JarvisBug,
  type JarvisBugCondition,
  type JarvisBugSearchResult,
  type JarvisProject,
  type JarvisProjectBugSearchParams,
  type JarvisProjectListParams,
  type JarvisProjectListResult,
} from "@codexhost/shared-contracts";

import {
  createJarvisConditionChip,
  createJarvisEntryRow,
  createJarvisProjectChip,
  jarvisBugLabel,
  renderJarvisBugRows,
} from "./renderer-jarvis-bug-view.js";
import {
  JARVIS_MODE_ATTRIBUTE,
  TEXT_PRIMARY,
  type JarvisStepChrome,
  clearJarvisNotice,
  createJarvisStepChrome,
  renderJarvisLoading,
  renderJarvisMessage,
  renderJarvisNotice,
} from "./renderer-jarvis-panel-view.js";
import { renderJarvisProjectRows } from "./renderer-jarvis-project-view.js";
import {
  clearJarvisProjectCache,
  isJarvisProjectCacheFresh,
  readJarvisLastProject,
  readJarvisProjectCache,
  writeJarvisLastProject,
  writeJarvisProjectCache,
} from "./renderer-jarvis-project-store.js";
import {
  ensureWorkbenchSection,
  findNativeSuggestionList,
  highlightWorkbenchRow,
  registerWorkbenchRow,
  removeWorkbenchSectionIfEmpty,
  waitForNativeSuggestionList,
} from "./renderer-native-at-menu.js";
import {
  deleteNativeRange,
  insertNativeAgentMention,
  insertNativeAgentMentionAtSelection,
  type NativeTextRange,
} from "./renderer-native-composer-controller.js";
import { jarvisStepErrorText } from "./renderer-jarvis-client.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

export {
  createJarvisEntryRow,
  createJarvisEntrySection,
  jarvisBugLabel,
  jarvisPriorityText,
  jarvisRelativeTime,
  jarvisSeverityText,
  jarvisStatusText,
  truncateJarvisText,
} from "./renderer-jarvis-bug-view.js";

export { findNativeSuggestionList } from "./renderer-native-at-menu.js";

const MODE_ATTRIBUTE = JARVIS_MODE_ATTRIBUTE;
const TRIGGER_PATTERN = /(?:^|\s)@([^\s@]{0,64})$/u;
const DEBOUNCE_MS = 300;
const PARSE_DEBOUNCE_MS = 800;
const MAX_QUERY_LENGTH = 64;

export interface RendererJarvisTrigger {
  query: string;
  start: number;
}

/** Detect an active `@query` token ending at the caret. */
export function findJarvisTrigger(textBeforeCaret: string): RendererJarvisTrigger | null {
  const match = TRIGGER_PATTERN.exec(textBeforeCaret);
  if (!match) return null;
  const query = match[1] ?? "";
  if (query.length > MAX_QUERY_LENGTH) return null;
  return { query, start: textBeforeCaret.length - query.length - 1 };
}

/** The row appears for an empty query or a prefix of its own name. */
export function matchesJarvisEntry(query: string): boolean {
  if (query.length === 0) return true;
  const value = query.toLocaleLowerCase();
  return "jarvis".startsWith(value) || "贾维斯".startsWith(value);
}

const WORKBENCH_PREFIXES = ["jarvis", "贾维斯", "钉钉", "dingtalk"] as const;

/**
 * `@<text>` that is not a Workbench name prefix is itself the Jarvis query.
 * The row then reads `Jarvis：<text>` and selecting it prefills the search.
 */
export function jarvisQueryEntry(query: string): string | null {
  if (!query) return null;
  const value = query.toLocaleLowerCase();
  if (WORKBENCH_PREFIXES.some((prefix) => prefix.startsWith(value))) return null;
  return query;
}

export function showsJarvisEntry(query: string): boolean {
  return matchesJarvisEntry(query) || jarvisQueryEntry(query) !== null;
}

export type JarvisEntryAction = "none" | "entry" | "search";

/**
 * Entry gating policy. Typing after `@` can only reveal the row; a search
 * request is possible only after the row was selected.
 */
export function jarvisEntryAction(input: {
  query: string;
  selectedEntry: boolean;
}): JarvisEntryAction {
  if (!showsJarvisEntry(input.query)) return "none";
  return input.selectedEntry ? "search" : "entry";
}

export interface RendererJarvisMentionOptions {
  isComposerEditor(editor: HTMLElement): boolean;
  /** Desktop Host that runs the Composer's Thread; null while unknown. */
  readHostId(editor: HTMLElement): string | null;
  /** Step 1: my projects, or a visible-project search while typing. */
  listProjects(
    hostId: string,
    params: JarvisProjectListParams,
    signal?: AbortSignal,
  ): Promise<JarvisProjectListResult>;
  /** Step 2: raw text as a title in the chosen project; no model. */
  previewProjectBugTitle(
    hostId: string,
    params: { projectId: number; title: string },
    signal?: AbortSignal,
  ): Promise<JarvisBugSearchResult>;
  /** Step 2: parsed conditions inside the chosen project. */
  searchProjectBugs(
    hostId: string,
    params: JarvisProjectBugSearchParams,
    signal?: AbortSignal,
  ): Promise<JarvisBugSearchResult>;
  readLocale(): RendererSettingsLocale;
  anchorForEditor(editor: HTMLElement): Element | null;
  /** Opens the Jarvis settings page from an error state. */
  openSettings?(opener: HTMLElement): void;
}

export interface RendererJarvisMentionControl {
  refresh(): void;
  dispose(): void;
}

interface Trigger {
  editor: HTMLElement;
  node: Text;
  start: number;
  end: number;
  query: string;
}

interface EntryState {
  trigger: Trigger;
  row: HTMLElement;
  section: HTMLElement;
  unregister: () => void;
}

type StepState =
  | {
      kind: "project";
      entries: { project: JarvisProject; row: HTMLElement }[];
      selected: number;
    }
  | {
      kind: "bug";
      entries: { bug: JarvisBug; row: HTMLElement }[];
      selected: number;
    };

interface ModeState {
  trigger: Trigger;
  hostId: string | null;
  locale: RendererSettingsLocale;
  projectChrome: JarvisStepChrome;
  bugChrome: JarvisStepChrome;
  step: StepState;
  /** Section currently attached to the panel host. */
  visibleKind: StepState["kind"];
  /** Chosen project; stays when returning to the project step. */
  project: JarvisProject | null;
  projectQuery: string;
  projectRows: JarvisProject[];
  /** Jarvis user that owns the project cache and the remembered project. */
  projectUserId: number | null;
  /** Condition chips removed by the user; sent as `omit` on the next parse. */
  omit: Set<string>;
  /** Title preview = the raw text; the parse replaces it when it answers. */
  previewText: string;
  previewGeneration: number;
  previewRequest: AbortController | null;
  previewError: string | null;
  parse: "idle" | "pending" | "done" | "failed";
  parseText: string;
  parseGeneration: number;
  parseRequest: AbortController | null;
  /** Debounce for the automatic parse after the user stops typing. */
  parseTimer: number | null;
  generation: number;
  hiddenPanel: { element: HTMLElement; visibility: string } | null;
  timer: number | null;
  request: AbortController | null;
  /** The `@query` text was already removed; insert the mention at the caret. */
  insertAtSelection: boolean;
  /** Native popup bounds, reused if focus makes the popup close. */
  lastRect: { left: number; top: number; width: number; height: number } | null;
  detachedHost: HTMLElement | null;
}

export function installRendererJarvisMention(
  ownerDocument: Document,
  options: RendererJarvisMentionOptions,
): RendererJarvisMentionControl {
  const view = ownerDocument.defaultView;
  if (!view) return { refresh: () => undefined, dispose: () => undefined };

  let entry: EntryState | null = null;
  let entryPending: Trigger | null = null;
  let cancelEntryWait: (() => void) | null = null;
  let mode: ModeState | null = null;
  let suppressed: string | null = null;
  let composing = false;
  let inserting = false;
  let reattachScheduled = false;

  const isInside = (node: Node | null, element: Element | null): boolean =>
    node !== null && element !== null && element.contains(node);

  const nativeList = (editor: HTMLElement): HTMLElement | null =>
    findNativeSuggestionList(ownerDocument, options.anchorForEditor(editor));

  const storage = (): Storage | null => {
    try {
      return view.localStorage ?? null;
    } catch {
      return null;
    }
  };

  const now = (): number => Date.now();

  const removeEntry = (): void => {
    cancelEntryWait?.();
    cancelEntryWait = null;
    entryPending = null;
    entry?.unregister();
    entry?.row.remove();
    // The section is shared with the DingTalk row; drop it only when empty.
    removeWorkbenchSectionIfEmpty(entry?.section ?? null);
    entry = null;
  };

  const removeMode = (): void => {
    if (!mode) return;
    if (mode.timer !== null) view.clearTimeout(mode.timer);
    mode.request?.abort();
    mode.projectChrome.section.remove();
    mode.bugChrome.section.remove();
    mode.detachedHost?.remove();
    mode.detachedHost = null;
    const hiddenPanel = mode.hiddenPanel;
    mode.hiddenPanel = null;
    if (hiddenPanel?.element.isConnected) {
      hiddenPanel.element.style.visibility = hiddenPanel.visibility;
    }
    mode = null;
  };

  /**
   * The Native popup only supplies the anchor rectangle. Keeping its panel
   * visible behind the Jarvis panel would show native rows and an old height,
   * so hide it for the lifetime of the mode.
   */
  const hideNativePanel = (state: ModeState, list: HTMLElement): void => {
    if (state.hiddenPanel) return;
    const panel =
      list.closest<HTMLElement>('[class*="suggestionMenu"]') ?? list.parentElement ?? list;
    state.hiddenPanel = { element: panel, visibility: panel.style.visibility };
    panel.style.visibility = "hidden";
  };

  const readTrigger = (): Trigger | null => {
    const selection = ownerDocument.getSelection();
    if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
    const node = selection.anchorNode;
    if (!node || node.nodeType !== node.TEXT_NODE) return null;
    const editor = node.parentElement?.closest<HTMLElement>('[contenteditable="true"]');
    if (!editor || !options.isComposerEditor(editor)) return null;
    const text = node as Text;
    const found = findJarvisTrigger(text.data.slice(0, selection.anchorOffset));
    if (!found) return null;
    return {
      editor,
      node: text,
      start: found.start,
      end: selection.anchorOffset,
      query: found.query,
    };
  };

  const triggerIntact = (trigger: Trigger): boolean =>
    trigger.node.isConnected &&
    trigger.node.data.slice(trigger.start, trigger.end) === `@${trigger.query}`;

  const attachEntry = (trigger: Trigger): void => {
    const queryText = jarvisQueryEntry(trigger.query);
    if (!matchesJarvisEntry(trigger.query) && queryText === null) return;
    const list = nativeList(trigger.editor);
    if (!list) return;
    cancelEntryWait?.();
    cancelEntryWait = null;
    entryPending = null;
    const locale = options.readLocale();
    const row = createJarvisEntryRow(ownerDocument, locale, queryText ?? undefined);
    const section = ensureWorkbenchSection(ownerDocument, list, locale);
    if (row.parentElement !== section.items) section.items.append(row);
    const state: EntryState = {
      trigger,
      row,
      section: section.element,
      unregister: () => undefined,
    };
    entry = state;

    row.addEventListener("pointermove", (event) => {
      event.stopPropagation();
      highlightWorkbenchRow(ownerDocument, state.row);
    });
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (entry !== state) return;
      if (queryText !== null) enterMode(state.trigger, queryText, true);
      else enterMode(state.trigger);
    });
    state.unregister = registerWorkbenchRow(ownerDocument, row, () => row.click());
  };

  /** Wait for the native popup instead of drawing our own panel. */
  const scheduleEntry = (trigger: Trigger): void => {
    if (!showsJarvisEntry(trigger.query)) return;
    const list = nativeList(trigger.editor);
    if (list) {
      attachEntry(trigger);
      return;
    }
    entryPending = trigger;
    cancelEntryWait?.();
    cancelEntryWait = waitForNativeSuggestionList(
      ownerDocument,
      () => options.anchorForEditor(trigger.editor),
      () => {
        cancelEntryWait = null;
        if (entry || entryPending !== trigger) return;
        attachEntry(trigger);
      },
    );
  };

  const buildMode = (trigger: Trigger): ModeState => {
    const locale = options.readLocale();
    const projectChrome = createJarvisStepChrome(ownerDocument, locale, {
      step: "project",
      subtitle: locale === "zh-CN" ? "项目" : "Project",
      placeholder: locale === "zh-CN" ? "搜索项目" : "Search projects",
      listLabel: locale === "zh-CN" ? "我的项目" : "My projects",
      withChips: false,
    });
    const bugChrome = createJarvisStepChrome(ownerDocument, locale, {
      step: "bug",
      subtitle: "Bug",
      placeholder:
        locale === "zh-CN" ? "搜索标题，回车识别条件" : "Search titles; Enter reads conditions",
      listLabel: "",
      withChips: true,
    });
    for (const chrome of [projectChrome, bugChrome]) {
      chrome.section.setAttribute(MODE_ATTRIBUTE, "true");
    }
    return {
      trigger,
      hostId: options.readHostId(trigger.editor),
      locale,
      projectChrome,
      bugChrome,
      step: { kind: "project", entries: [], selected: -1 },
      visibleKind: "project",
      project: null,
      projectQuery: "",
      projectRows: [],
      projectUserId: null,
      omit: new Set(),
      previewText: "",
      previewGeneration: 0,
      previewRequest: null,
      previewError: null,
      parse: "idle",
      parseText: "",
      parseGeneration: 0,
      parseRequest: null,
      parseTimer: null,
      generation: 0,
      hiddenPanel: null,
      timer: null,
      request: null,
      insertAtSelection: false,
      lastRect: null,
      detachedHost: null,
    };
  };

  const chromeOf = (state: ModeState, kind: StepState["kind"]): JarvisStepChrome =>
    kind === "project" ? state.projectChrome : state.bugChrome;

  const showStep = (state: ModeState, step: StepState): void => {
    // Track the attached section separately: callers replace `state.step`
    // before switching, and the old section must still be removed.
    const previous = chromeOf(state, state.visibleKind);
    const next = chromeOf(state, step.kind);
    if (previous !== next) previous.section.remove();
    if (next.section.parentElement !== state.detachedHost) {
      state.detachedHost?.append(next.section);
    }
    state.visibleKind = step.kind;
    state.step = step;
    next.input.focus({ preventScroll: true });
  };

  const setBusy = (state: ModeState, busy: boolean): void => {
    const chrome = chromeOf(state, state.step.kind);
    if (busy) chrome.section.setAttribute("aria-busy", "true");
    else chrome.section.removeAttribute("aria-busy");
  };

  const selectRow = (state: ModeState, index: number): void => {
    const step = state.step;
    const entries = step.entries;
    step.selected = index >= 0 && index < entries.length ? index : -1;
    entries.forEach(({ row }, current) => {
      const selected = current === step.selected;
      row.setAttribute("aria-selected", String(selected));
      row.style.background = selected
        ? "var(--color-token-interactive-bg-secondary-hover, rgba(127, 127, 127, 0.08))"
        : "transparent";
      if (selected) row.scrollIntoView({ block: "nearest" });
    });
  };

  const projectLabel = (state: ModeState): string => {
    if (state.projectQuery) return state.locale === "zh-CN" ? "搜索结果" : "Search results";
    return state.locale === "zh-CN" ? "我的项目" : "My projects";
  };

  /** The list label already names the section; only a truncation needs a line. */
  const projectSummary = (state: ModeState, result: JarvisProjectListResult | null): string => {
    if (!result || result.complete) return "";
    const count = result.projects.length;
    return state.locale === "zh-CN" ? `已显示前 ${count} 个` : `Showing the first ${count}`;
  };

  const resultCount = (state: ModeState, result: JarvisBugSearchResult): string => {
    if (result.capped) {
      return state.locale === "zh-CN"
        ? `已显示前 ${result.bugs.length} 条`
        : `Showing the first ${result.bugs.length}`;
    }
    return state.locale === "zh-CN" ? `共 ${result.total} 条` : `${result.total} bugs`;
  };

  const emptyMessage = (state: ModeState, kind: StepState["kind"]): string =>
    kind === "project"
      ? state.locale === "zh-CN"
        ? "无结果，换个项目名试试。"
        : "No matching projects. Try another name."
      : state.bugChrome.input.value.trim()
        ? state.locale === "zh-CN"
          ? "没有符合条件的 Bug。换个说法，或点掉一个条件。"
          : "No bugs match these conditions. Rephrase the search or remove a condition."
        : state.locale === "zh-CN"
          ? "无结果。这个项目里没有指派给你的 Bug。"
          : "No results. No bugs in this project are assigned to you.";

  const failureMessage = (state: ModeState, errorCode: string | null): string =>
    jarvisStepErrorText(errorCode, state.locale);

  const failureAction = (
    state: ModeState,
    errorCode: string | null,
    retry: () => void,
  ): { label: string; onClick(opener: HTMLElement): void } | undefined => {
    if (errorCode === "not_logged_in" || errorCode === "not_installed") {
      if (!options.openSettings) return undefined;
      return {
        label: state.locale === "zh-CN" ? "去设置" : "Open settings",
        onClick: (opener) => {
          options.openSettings?.(opener);
          exitMode(false);
        },
      };
    }
    return {
      label: state.locale === "zh-CN" ? "重试" : "Retry",
      onClick: () => retry(),
    };
  };

  const renderProjectRows = (state: ModeState, projects: readonly JarvisProject[]): void => {
    const chrome = state.projectChrome;
    state.step = { kind: "project", entries: [], selected: -1 };
    chrome.listLabel.textContent = projectLabel(state);
    chrome.listLabel.hidden = false;
    state.projectRows = [...projects];
    const entries = renderJarvisProjectRows(ownerDocument, chrome.results, projects, {
      onSelect: (index) => {
        if (state.step.kind === "project") selectRow(state, index);
      },
      onChoose: (project) => {
        openProject(state, project);
      },
    });
    if (state.step.kind === "project") state.step.entries = entries;
  };

  const applyProjectResult = (state: ModeState, result: JarvisProjectListResult): void => {
    setBusy(state, false);
    if (!result.available || result.errorCode) {
      state.projectChrome.summary.textContent = "";
      state.projectChrome.listLabel.hidden = true;
      renderJarvisMessage(
        ownerDocument,
        state.projectChrome.results,
        failureMessage(state, result.errorCode),
        failureAction(state, result.errorCode, () => {
          void requestProjects(state, state.projectQuery);
        }),
      );
      return;
    }
    state.projectChrome.listLabel.hidden = false;
    state.projectChrome.summary.textContent = projectSummary(state, result);
    if (result.projects.length === 0) {
      renderJarvisMessage(
        ownerDocument,
        state.projectChrome.results,
        emptyMessage(state, "project"),
      );
    } else {
      renderProjectRows(state, result.projects);
    }
  };

  const requestProjects = async (state: ModeState, query: string): Promise<void> => {
    state.generation += 1;
    state.request?.abort();
    state.request = new AbortController();
    const generation = state.generation;
    if (state.step.kind !== "project") {
      state.step = { kind: "project", entries: [], selected: -1 };
      showStep(state, state.step);
    }
    setBusy(state, true);
    state.projectChrome.listLabel.textContent = projectLabel(state);
    if (state.step.entries.length === 0) {
      state.projectChrome.summary.textContent = "";
      renderJarvisLoading(ownerDocument, state.projectChrome.results);
    } else {
      state.projectChrome.summary.textContent = state.locale === "zh-CN" ? "搜索中…" : "Searching…";
    }
    const hostId = state.hostId;
    if (!hostId) {
      setBusy(state, false);
      state.projectChrome.summary.textContent = "";
      renderJarvisMessage(
        ownerDocument,
        state.projectChrome.results,
        failureMessage(state, "jarvis_failed"),
        failureAction(state, "jarvis_failed", () => {
          void requestProjects(state, state.projectQuery);
        }),
      );
      return;
    }
    const result = await options
      .listProjects(hostId, query ? { query } : {}, state.request.signal)
      .catch((): JarvisProjectListResult => ({
        available: false,
        errorCode: "jarvis_failed",
        projects: [],
        complete: false,
        userId: null,
      }));
    if (mode !== state || generation !== state.generation) return;
    state.request = null;
    if (state.step.kind !== "project") return;
    if (result.userId) state.projectUserId = result.userId;
    applyProjectResult(state, result);
    if (result.available && result.userId) {
      if (!query) {
        writeJarvisProjectCache(storage(), hostId, result.userId, result.projects, now());
      }
    }
    if (state.projectUserId !== null) {
      const cache = readJarvisProjectCache(storage(), hostId);
      if (cache && cache.userId !== state.projectUserId) {
        clearJarvisProjectCache(storage(), hostId);
      }
    }
  };

  const scheduleProjectSearch = (state: ModeState): void => {
    state.generation += 1;
    state.request?.abort();
    setBusy(state, true);
    state.projectQuery = state.projectChrome.input.value.trim();
    if (state.step.kind === "project") {
      state.projectChrome.listLabel.textContent = projectLabel(state);
      state.projectChrome.summary.textContent = state.locale === "zh-CN" ? "搜索中…" : "Searching…";
    }
    if (state.timer !== null) view.clearTimeout(state.timer);
    state.timer = view.setTimeout(() => {
      state.timer = null;
      if (mode !== state) return;
      void requestProjects(state, state.projectQuery);
    }, DEBOUNCE_MS);
  };

  const renderBugChips = (state: ModeState, conditions: readonly JarvisBugCondition[]): void => {
    const chips = state.bugChrome.chips;
    chips.replaceChildren();
    chips.hidden = false;
    if (!state.project) return;
    chips.append(
      createJarvisProjectChip(ownerDocument, state.project, () => {
        returnToProjects(state);
      }),
    );
    for (const condition of conditions) {
      if (state.omit.has(condition.key)) continue;
      chips.append(
        createJarvisConditionChip(ownerDocument, condition, () => {
          state.omit.add(condition.key);
          void submitBugSearch(state, true);
        }),
      );
    }
  };

  const renderBugRows = (state: ModeState, bugs: readonly JarvisBug[]): void => {
    state.step = { kind: "bug", entries: [], selected: -1 };
    const entries = renderJarvisBugRows(
      ownerDocument,
      state.bugChrome.results,
      bugs,
      state.locale,
      {
        onSelect: (index) => {
          if (state.step.kind === "bug") selectRow(state, index);
        },
        onChoose: (bug) => void choose(state, bug),
      },
    );
    if (state.step.kind === "bug") state.step.entries = entries;
  };

  const missingResult = (): JarvisBugSearchResult => ({
    available: false,
    errorCode: "jarvis_failed",
    conditions: [],
    bugs: [],
    total: 0,
    capped: false,
  });

  /**
   * The parse failed: keep any title preview visible, but say what happened
   * and offer a retry. This must never look like a completed empty search.
   */
  const failParse = (state: ModeState, errorCode: string | null): void => {
    state.parse = "failed";
    setBusy(state, false);
    renderBugChips(state, []);
    state.bugChrome.summary.textContent = "";
    const message =
      errorCode === "unrecognized_query"
        ? state.locale === "zh-CN"
          ? "无法识别这些条件"
          : "Those conditions were not understood"
        : errorCode === "timeout"
          ? state.locale === "zh-CN"
            ? "识别条件超时"
            : "Reading conditions timed out"
          : state.locale === "zh-CN"
            ? "条件识别失败"
            : "Could not read the conditions";
    renderJarvisNotice(ownerDocument, state.bugChrome.results, message, {
      label: state.locale === "zh-CN" ? "重试" : "Retry",
      onClick: () => {
        void submitBugSearch(state, true);
      },
    });
  };

  const applyParsedResult = (state: ModeState, result: JarvisBugSearchResult): void => {
    if (state.step.kind !== "bug") return;
    if (!result.available || result.errorCode) {
      failParse(state, result.errorCode);
      return;
    }
    state.parse = "done";
    state.previewError = null;
    setBusy(state, false);
    state.bugChrome.summary.textContent =
      result.bugs.length === 0 ? "" : resultCount(state, result);
    renderBugChips(state, result.conditions);
    if (result.bugs.length === 0) {
      renderJarvisMessage(ownerDocument, state.bugChrome.results, emptyMessage(state, "bug"));
      return;
    }
    renderBugRows(state, result.bugs);
  };

  const requestTitlePreview = async (
    state: ModeState,
    text: string,
    silent: boolean,
  ): Promise<void> => {
    if (!state.project) return;
    state.previewGeneration += 1;
    const generation = state.previewGeneration;
    state.previewRequest?.abort();
    state.previewRequest = new AbortController();
    const hadRows = state.step.kind === "bug" && state.step.entries.length > 0;
    const parsingNow = state.parse === "pending" && state.parseText === text;
    setBusy(state, true);
    if (!hadRows) {
      // Entering the step or typing after an empty state still needs a
      // skeleton, even when this preview was started silently.
      state.step = { kind: "bug", entries: [], selected: -1 };
      if (!parsingNow) state.bugChrome.summary.textContent = "";
      renderJarvisLoading(ownerDocument, state.bugChrome.results);
    } else if (!parsingNow) {
      state.bugChrome.summary.textContent = state.locale === "zh-CN" ? "搜索中…" : "Searching…";
    }
    const hostId = state.hostId;
    if (!hostId) {
      state.previewRequest = null;
      setBusy(state, false);
      state.bugChrome.summary.textContent = "";
      renderJarvisMessage(
        ownerDocument,
        state.bugChrome.results,
        failureMessage(state, "jarvis_failed"),
        failureAction(state, "jarvis_failed", () => {
          void requestTitlePreview(state, text, silent);
        }),
      );
      return;
    }
    const result = await options
      .previewProjectBugTitle(
        hostId,
        { projectId: state.project.id, title: text },
        state.previewRequest.signal,
      )
      .catch(missingResult);
    if (mode !== state || generation !== state.previewGeneration) return;
    state.previewRequest = null;
    if (state.step.kind !== "bug") return;
    if (state.parse === "done" && state.parseText === text) return;
    const parsing = state.parse === "pending" && state.parseText === text;
    if (state.parse === "failed" && state.parseText === text) return;
    state.previewText = text;
    if (!result.available || result.errorCode) {
      state.previewError = result.errorCode;
      // A pending parse owns the panel; its own failure path reports later.
      if (parsing) return;
      setBusy(state, false);
      state.bugChrome.summary.textContent = "";
      renderJarvisMessage(
        ownerDocument,
        state.bugChrome.results,
        failureMessage(state, result.errorCode),
        failureAction(state, result.errorCode, () => {
          void requestTitlePreview(state, text, silent);
        }),
      );
      return;
    }
    state.previewError = null;
    if (parsing) {
      // Only the rows may update; the pending summary and skeleton stay.
      if (result.bugs.length > 0) renderBugRows(state, result.bugs);
      return;
    }
    setBusy(state, false);
    if (result.bugs.length === 0) {
      if (text) {
        // The automatic parse is queued (or already running): never turn this
        // gap into 「无结果」.
        state.bugChrome.summary.textContent =
          state.locale === "zh-CN" ? "正在识别条件…" : "Reading conditions…";
        renderJarvisLoading(ownerDocument, state.bugChrome.results);
      } else {
        state.bugChrome.summary.textContent = "";
        renderJarvisMessage(ownerDocument, state.bugChrome.results, emptyMessage(state, "bug"));
      }
      return;
    }
    state.bugChrome.summary.textContent = resultCount(state, result);
    renderBugRows(state, result.bugs);
  };

  /**
   * Runs the model interpretation once for the current text. Typing schedules
   * it automatically; Enter only forces it when no parse is pending or done.
   */
  const submitBugSearch = async (state: ModeState, force = false): Promise<void> => {
    if (!state.project) return;
    const text = state.bugChrome.input.value.trim();
    if (!text) return;
    if (!force) {
      if (state.parse === "pending" && state.parseText === text) return;
      if (state.parse === "done" && state.parseText === text) return;
    }
    if (state.parseTimer !== null) view.clearTimeout(state.parseTimer);
    state.parseTimer = null;
    state.parseGeneration += 1;
    const generation = state.parseGeneration;
    state.parseRequest?.abort();
    state.parseRequest = new AbortController();
    state.parse = "pending";
    state.parseText = text;
    setBusy(state, true);
    clearJarvisNotice(state.bugChrome.results);
    state.bugChrome.summary.textContent =
      state.locale === "zh-CN" ? "正在识别条件…" : "Reading conditions…";
    if (state.previewText !== text) void requestTitlePreview(state, text, true);
    const hostId = state.hostId;
    if (!hostId) {
      state.parseRequest = null;
      failParse(state, "jarvis_failed");
      return;
    }
    const params: JarvisProjectBugSearchParams = {
      projectId: state.project.id,
      query: text,
      ...(state.omit.size > 0 ? { omit: [...state.omit] } : {}),
    };
    const result = await options
      .searchProjectBugs(hostId, params, state.parseRequest.signal)
      .catch(missingResult);
    if (mode !== state || generation !== state.parseGeneration) return;
    state.parseRequest = null;
    applyParsedResult(state, result);
  };

  /**
   * Typing paints the title preview immediately and schedules the condition
   * parse 800 ms after the last keystroke. A changed text cancels the older
   * parse; an unchanged text never asks Gemini twice.
   */
  const scheduleBugSearch = (state: ModeState): void => {
    const text = state.bugChrome.input.value.trim();
    state.previewGeneration += 1;
    state.previewRequest?.abort();
    state.previewRequest = null;
    const changed = text !== state.parseText;
    if (changed) {
      state.parseGeneration += 1;
      state.parseRequest?.abort();
      state.parseRequest = null;
      state.parse = "idle";
      state.parseText = "";
      state.previewError = null;
      state.omit.clear();
      renderBugChips(state, []);
      if (state.step.kind === "bug") state.bugChrome.summary.textContent = "";
      if (state.parseTimer !== null) view.clearTimeout(state.parseTimer);
      state.parseTimer = null;
      if (text) {
        state.parseTimer = view.setTimeout(() => {
          state.parseTimer = null;
          if (mode !== state) return;
          if (state.bugChrome.input.value.trim() !== text) return;
          void submitBugSearch(state);
        }, PARSE_DEBOUNCE_MS);
      }
    }
    if (state.timer !== null) view.clearTimeout(state.timer);
    state.timer = view.setTimeout(() => {
      state.timer = null;
      if (mode !== state) return;
      void requestTitlePreview(state, state.bugChrome.input.value.trim(), false);
    }, DEBOUNCE_MS);
  };

  const openProjectStep = (state: ModeState, prefill: string, focus: boolean): void => {
    state.generation += 1;
    state.request?.abort();
    state.step = { kind: "project", entries: [], selected: -1 };
    const chrome = state.projectChrome;
    if (chrome.input.value !== prefill) chrome.input.value = prefill;
    state.projectQuery = prefill.trim();
    chrome.clear.style.display = prefill.length === 0 ? "none" : "inline-flex";
    chrome.listLabel.textContent = projectLabel(state);
    chrome.listLabel.hidden = false;
    chrome.summary.textContent = "";
    if (state.projectRows.length > 0 && !state.projectQuery) {
      renderProjectRows(state, state.projectRows);
    } else {
      renderJarvisLoading(ownerDocument, chrome.results);
    }
    showStep(state, state.step);
    setBusy(state, false);
    if (focus) chrome.input.focus({ preventScroll: true });
  };

  const returnToProjects = (state: ModeState): void => {
    state.generation += 1;
    state.request?.abort();
    state.request = null;
    state.previewGeneration += 1;
    state.previewRequest?.abort();
    state.previewRequest = null;
    state.parseGeneration += 1;
    state.parseRequest?.abort();
    state.parseRequest = null;
    if (state.parseTimer !== null) view.clearTimeout(state.parseTimer);
    state.parseTimer = null;
    state.parse = "idle";
    state.parseText = "";
    state.omit.clear();
    setBusy(state, false);
    openProjectStep(state, state.projectChrome.input.value, true);
    // The cached list is display data; refresh it without blocking the switch.
    void requestProjects(state, state.projectQuery);
  };

  const openBugStep = (state: ModeState, project: JarvisProject): void => {
    state.project = project;
    state.omit.clear();
    if (state.parseTimer !== null) view.clearTimeout(state.parseTimer);
    state.parseTimer = null;
    state.parse = "idle";
    state.parseText = "";
    state.previewText = "";
    state.previewError = null;
    const chrome = state.bugChrome;
    chrome.input.value = "";
    chrome.clear.style.display = "none";
    renderBugChips(state, []);
    state.step = { kind: "bug", entries: [], selected: -1 };
    showStep(state, state.step);
    // The whole project opens with its assigned bugs; typing narrows titles.
    void requestTitlePreview(state, "", true);
  };

  const openProject = (state: ModeState, project: JarvisProject): void => {
    if (mode !== state) return;
    state.projectQuery = state.projectChrome.input.value.trim();
    if (state.projectUserId !== null) {
      writeJarvisLastProject(
        storage(),
        state.hostId ?? "local",
        state.projectUserId,
        project,
        now(),
      );
    }
    openBugStep(state, project);
  };

  const deleteTriggerText = async (trigger: Trigger): Promise<boolean> => {
    const range: NativeTextRange = {
      node: trigger.node,
      start: trigger.start,
      end: trigger.end,
      expected: `@${trigger.query}`,
    };
    if (deleteNativeRange(trigger.editor, range)) return true;
    if (!(await selectTriggerText(trigger))) return false;
    ownerDocument.execCommand("delete");
    await new Promise<void>((resolve) => view.setTimeout(resolve, 0));
    return true;
  };

  const panelRectOf = (
    list: HTMLElement,
  ): { left: number; top: number; width: number; height: number } => {
    const panel =
      list.closest<HTMLElement>('[class*="suggestionMenu"]') ?? list.parentElement ?? list;
    const rect = panel.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };

  const BORDER = "var(--color-token-border-default, rgba(13, 13, 13, 0.08))";

  /**
   * Host the Jarvis panel ourselves instead of reusing the Native popup.
   *
   * The panel is bottom-anchored to the Composer's top edge and grows upward,
   * exactly like the native `@` popup. Its height follows the content, so a
   * one-result search shrinks back to the Composer instead of leaving the
   * native popup's previous height behind. The result list inside the section
   * is the scrolling surface.
   */
  const detachMode = (state: ModeState): void => {
    if (state.detachedHost) return;
    const rect = state.lastRect ?? { left: 24, top: 120, width: 360, height: 320 };
    const anchor = options.anchorForEditor(state.trigger.editor);
    const anchorRect = anchor?.getBoundingClientRect() ?? null;
    // The native popup lives inside Desktop's window-zoom subtree; this host
    // is a direct body child, so convert the same way the Agent picker does.
    const rawZoom = getComputedStyle(ownerDocument.documentElement)
      .getPropertyValue("--codex-window-zoom")
      .trim();
    const parsedZoom = Number.parseFloat(rawZoom);
    const zoom = Number.isFinite(parsedZoom) && parsedZoom > 0 ? parsedZoom : 1;
    const viewportWidth = view.innerWidth / zoom;
    const viewportHeight = view.innerHeight / zoom;
    const anchorTop =
      anchorRect && anchorRect.top > 8
        ? anchorRect.top / zoom
        : Math.max(8, (rect.top + rect.height) / zoom);
    const width = Math.max(
      280,
      Math.min((anchorRect?.width ?? rect.width) / zoom, viewportWidth - 16),
    );
    const left = Math.min(
      Math.max(8, (anchorRect?.left ?? rect.left) / zoom),
      Math.max(8, viewportWidth - width - 8),
    );
    const host = ownerDocument.createElement("div");
    host.setAttribute("data-codexhost-jarvis-detached", "true");
    host.className = "fixed z-[2147483647] flex flex-col overflow-hidden";
    host.style.cssText =
      "position:fixed;z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;" +
      `box-sizing:border-box;left:${left}px;width:${width}px;` +
      `bottom:${Math.max(8, viewportHeight - anchorTop + 4)}px;` +
      `max-height:${Math.max(160, anchorTop - 12)}px;` +
      `border:1px solid ${BORDER};border-radius:12px;` +
      "background:var(--color-token-dropdown-background, var(--color-surface-elevated-secondary, #fff));" +
      `color:${TEXT_PRIMARY};box-shadow:0 12px 32px rgba(0, 0, 0, 0.18);`;
    host.append(state.projectChrome.section);
    ownerDocument.body.append(host);
    state.detachedHost = host;
    state.projectChrome.input.focus({ preventScroll: true });
  };

  const wireChrome = (state: ModeState, chrome: JarvisStepChrome, kind: StepState["kind"]) => {
    chrome.back.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (kind === "bug") void returnToProjects(state);
      else exitMode(true);
    });
    chrome.input.addEventListener("pointerdown", (event) => event.stopPropagation());
    chrome.input.addEventListener("input", () => {
      chrome.clear.style.display = chrome.input.value.length === 0 ? "none" : "inline-flex";
      if (state.step.kind !== kind) return;
      if (kind === "project") scheduleProjectSearch(state);
      else scheduleBugSearch(state);
    });
    chrome.clear.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (chrome.input.value.length === 0) return;
      chrome.input.value = "";
      chrome.clear.style.display = "none";
      chrome.input.focus({ preventScroll: true });
      if (kind === "project") {
        state.projectQuery = "";
        void requestProjects(state, "");
      } else {
        scheduleBugSearch(state);
      }
    });
    chrome.input.addEventListener("keydown", (event) => event.stopPropagation());
  };

  const startMode = (
    trigger: Trigger,
    prefill: string,
    insertAtSelection: boolean,
    fallbackRect: { left: number; top: number; width: number; height: number } | null = null,
  ): void => {
    const list = nativeList(trigger.editor);
    if (!list && !fallbackRect) return;
    const state = buildMode(trigger);
    state.insertAtSelection = insertAtSelection;
    state.lastRect = list ? panelRectOf(list) : fallbackRect;
    if (list) hideNativePanel(state, list);
    detachMode(state);
    mode = state;
    wireChrome(state, state.projectChrome, "project");
    wireChrome(state, state.bugChrome, "bug");

    const hostId = state.hostId;
    const cache = hostId ? readJarvisProjectCache(storage(), hostId) : null;
    if (cache) {
      state.projectUserId = cache.userId;
      if (isJarvisProjectCacheFresh(cache, now())) {
        state.projectRows = cache.projects;
      }
    }
    const lastProject =
      hostId && cache && !prefill
        ? readJarvisLastProject(storage(), hostId, cache.userId, now())
        : null;
    if (lastProject) {
      state.project = lastProject;
      renderBugChips(state, []);
      state.step = { kind: "bug", entries: [], selected: -1 };
      showStep(state, state.step);
      void requestTitlePreview(state, "", true);
      // Revalidate the owner in the background so another account's cache is
      // never used for a later search.
      if (hostId) void revalidateProjects(state, hostId);
      return;
    }
    openProjectStep(state, prefill, true);
    if (prefill) {
      void requestProjects(state, prefill.trim());
    } else if (cache && isJarvisProjectCacheFresh(cache, now())) {
      if (hostId) void revalidateProjects(state, hostId);
    } else if (hostId) {
      void requestProjects(state, "");
    } else {
      state.projectChrome.listLabel.hidden = true;
      renderJarvisMessage(
        ownerDocument,
        state.projectChrome.results,
        failureMessage(state, "jarvis_failed"),
        failureAction(state, "jarvis_failed", () => {
          void requestProjects(state, "");
        }),
      );
    }
  };

  /** Refresh the project cache without touching whichever step is visible. */
  const revalidateProjects = async (state: ModeState, hostId: string): Promise<void> => {
    const result = await options.listProjects(hostId, {}).catch(() => null);
    if (mode !== state || !result) return;
    if (!result.available || !result.userId) return;
    const ownerChanged = state.projectUserId !== null && state.projectUserId !== result.userId;
    state.projectUserId = result.userId;
    state.projectRows = result.projects;
    writeJarvisProjectCache(storage(), hostId, result.userId, result.projects, now());
    if (ownerChanged) {
      // Drop the previous user's remembered project and show the correct list.
      state.previewGeneration += 1;
      state.previewRequest?.abort();
      state.previewRequest = null;
      state.parseGeneration += 1;
      state.parseRequest?.abort();
      state.parseRequest = null;
      if (state.parseTimer !== null) view.clearTimeout(state.parseTimer);
      state.parseTimer = null;
      state.parse = "idle";
      state.project = null;
      state.omit.clear();
      openProjectStep(state, "", true);
      applyProjectResult(state, result);
    }
  };

  function enterMode(trigger: Trigger, prefill = "", consumeTrigger = false): void {
    if (!consumeTrigger && !triggerIntact(trigger)) {
      removeEntry();
      return;
    }
    const list = nativeList(trigger.editor);
    const fallbackRect = list ? panelRectOf(list) : null;
    removeEntry();
    removeMode();
    if (!consumeTrigger) {
      startMode(trigger, prefill, false, fallbackRect);
      return;
    }
    void deleteTriggerText(trigger).then((removed) => {
      if (mode || !trigger.editor.isConnected) return;
      startMode(trigger, prefill, removed, fallbackRect);
    });
  }

  function exitMode(refocusComposer: boolean): void {
    if (!mode) return;
    const trigger = mode.trigger;
    suppressed = trigger.query;
    removeMode();
    if (refocusComposer && trigger.editor.isConnected) {
      trigger.editor.focus({ preventScroll: true });
    }
  }

  const selectTriggerText = async (trigger: Trigger): Promise<boolean> => {
    const selection = ownerDocument.getSelection();
    if (!selection) return false;
    const range = ownerDocument.createRange();
    range.setStart(trigger.node, trigger.start);
    range.setEnd(trigger.node, trigger.end);
    trigger.editor.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    await new Promise<void>((resolve) => view.setTimeout(resolve, 0));
    return true;
  };

  async function choose(state: ModeState, bug: JarvisBug): Promise<void> {
    if (mode !== state || inserting) return;
    const trigger = state.trigger;
    if (!state.insertAtSelection && !triggerIntact(trigger)) {
      exitMode(false);
      return;
    }
    const expected = `@${trigger.query}`;
    const label = jarvisBugLabel(bug);
    const path = jarvisMentionPath({ kind: "bug", id: bug.id, projectId: bug.projectId });
    const mention = { name: `jarvis-bug-${bug.id}`, displayName: label, path };
    const carrier = `${formatJarvisMentionLink({
      kind: "bug",
      id: bug.id,
      projectId: bug.projectId,
      label,
    })} `;
    if (state.insertAtSelection) {
      suppressed = trigger.query;
      removeMode();
      inserting = true;
      try {
        if (insertNativeAgentMentionAtSelection(trigger.editor, mention)) return;
        const pasted = dispatchPlainTextPaste(trigger.editor, carrier);
        if (!pasted) ownerDocument.execCommand("insertText", false, carrier);
      } finally {
        inserting = false;
      }
      return;
    }
    const range: NativeTextRange = {
      node: trigger.node,
      start: trigger.start,
      end: trigger.end,
      expected,
    };
    suppressed = trigger.query;
    removeMode();
    inserting = true;
    try {
      if (insertNativeAgentMention(trigger.editor, range, mention)) return;
      if (!(await selectTriggerText(trigger))) return;
      const pasted = dispatchPlainTextPaste(trigger.editor, carrier);
      if (!pasted) ownerDocument.execCommand("insertText", false, carrier);
    } finally {
      inserting = false;
    }
  }

  const schedule = (event?: Event): void => {
    if (inserting || composing) return;
    if (mode) {
      const target = event?.target ?? null;
      if (target && isInside(target as Node, mode.detachedHost)) return;
      if (event?.type === "input") {
        // Focus moved back to the Composer; the search field is no longer the
        // active surface, so leave the submenu.
        exitMode(false);
      }
      return;
    }
    const trigger = readTrigger();
    if (!trigger) {
      suppressed = null;
      removeEntry();
      return;
    }
    if (suppressed !== null && suppressed === trigger.query) return;
    suppressed = null;
    if (entry && entry.trigger.query === trigger.query && entry.trigger.node === trigger.node) {
      entry.trigger = trigger;
      return;
    }
    removeEntry();
    scheduleEntry(trigger);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (mode) {
      const state = mode;
      const step = state.step;
      let handled = true;
      if (event.key === "Escape") {
        if (step.kind === "bug") void returnToProjects(state);
        else exitMode(true);
      } else if (event.key === "ArrowDown") {
        if (step.entries.length === 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        selectRow(state, step.selected < 0 ? 0 : (step.selected + 1) % step.entries.length);
      } else if (event.key === "ArrowUp") {
        if (step.entries.length === 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        selectRow(state, step.selected <= 0 ? step.entries.length - 1 : step.selected - 1);
      } else if (event.key === "Enter" || event.key === "Tab") {
        const picked = step.selected >= 0 ? step.entries[step.selected] : undefined;
        if (picked) {
          if (step.kind === "project" && "project" in picked) {
            openProject(state, picked.project);
          } else if ("bug" in picked) {
            void choose(state, picked.bug);
          }
        } else if (step.kind === "bug" && event.key === "Enter") {
          // No row is highlighted: Enter interprets the text instead.
          void submitBugSearch(state);
        }
      } else {
        handled = false;
      }
      if (!handled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!entry) return;
    if (event.key !== "Escape") return;
    const selected = entry.row.getAttribute("aria-current") === "true";
    suppressed = entry.trigger.query;
    removeEntry();
    if (!selected) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (mode) {
      if (isInside(target, mode.detachedHost)) return;
      exitMode(false);
      return;
    }
    if (!entry) return;
    if (isInside(target, entry.section)) return;
    const list = nativeList(entry.trigger.editor);
    if (list?.contains(target)) return;
    removeEntry();
  };

  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    schedule();
  };

  const ensureAttached = (): void => {
    if (reattachScheduled) return;
    reattachScheduled = true;
    view.setTimeout(() => {
      reattachScheduled = false;
      if (mode) {
        // The Jarvis panel is always hosted by the controller; the native
        // popup may close without taking the mode with it.
        if (!mode.detachedHost) detachMode(mode);
        return;
      }
      if (!entry) {
        if (!entryPending) return;
        const pending = entryPending;
        const list = nativeList(pending.editor);
        if (list) attachEntry(pending);
        return;
      }
      const list = nativeList(entry.trigger.editor);
      if (!list) {
        removeEntry();
        return;
      }
      const section = ensureWorkbenchSection(ownerDocument, list, options.readLocale());
      if (entry.row.parentElement !== section.items) section.items.append(entry.row);
      entry.section = section.element;
    }, 60);
  };

  const observer = new MutationObserver(ensureAttached);
  observer.observe(ownerDocument.body, { childList: true, subtree: true });

  view.addEventListener("keydown", onKeyDown, true);
  ownerDocument.addEventListener("input", schedule, true);
  ownerDocument.addEventListener("selectionchange", schedule);
  ownerDocument.addEventListener("compositionstart", onCompositionStart, true);
  ownerDocument.addEventListener("compositionend", onCompositionEnd, true);
  ownerDocument.addEventListener("pointerdown", onPointerDown, true);

  return {
    refresh: schedule,
    dispose() {
      removeMode();
      removeEntry();
      observer.disconnect();
      view.removeEventListener("keydown", onKeyDown, true);
      ownerDocument.removeEventListener("input", schedule, true);
      ownerDocument.removeEventListener("selectionchange", schedule);
      ownerDocument.removeEventListener("compositionstart", onCompositionStart, true);
      ownerDocument.removeEventListener("compositionend", onCompositionEnd, true);
      ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
    },
  };
}

/** Mirrors Desktop's restore path when its controller is unavailable. */
function dispatchPlainTextPaste(editor: HTMLElement, text: string): boolean {
  const view = editor.ownerDocument.defaultView;
  if (!view?.DataTransfer || !view.ClipboardEvent) return false;
  const data = new view.DataTransfer();
  data.setData("text/plain", text);
  const event = new view.ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: data,
  });
  editor.dispatchEvent(event);
  return event.defaultPrevented;
}
