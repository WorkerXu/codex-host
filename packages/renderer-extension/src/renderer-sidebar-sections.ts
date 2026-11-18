/**
 * Merged conversation view for Desktop custom sidebar sections.
 *
 * Sections and their project membership belong to Desktop. This controller only
 * reads the native sidebar, marks the existing project wrappers for CSS layout,
 * and remembers one display choice per section. Any unexpected structure keeps
 * the section native.
 */

import { threadIdFromSidebarRowElement } from "./renderer-sidebar-agent-icons.js";
import {
  SIDEBAR_PROJECT_COLLAPSED_ATTRIBUTE,
  SIDEBAR_PROJECT_ROW_ATTRIBUTE,
  SIDEBAR_PROJECT_SHOW_ALL_ATTRIBUTE,
  SIDEBAR_SECTION_CONTAINER_SELECTOR,
  SIDEBAR_THREAD_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_ATTRIBUTE,
  findSectionElement,
  readRowThreadId,
  readSectionId,
  readSectionSnapshot,
  type SidebarSectionFallbackReason,
  type SidebarSectionSnapshot,
} from "./renderer-sidebar-sections-dom.js";
import {
  createSectionDisplayToggle,
  placeSectionDisplayToggle,
} from "./renderer-sidebar-sections-control.js";
import {
  MERGED_SECTION_STATE_ATTRIBUTE,
  MERGE_ORDER_ATTRIBUTE,
  SidebarSectionsStyle,
  applyMergeMarks,
  clearMergeMarks,
  mergeStyleCss,
} from "./renderer-sidebar-sections-layout.js";
import {
  mergeSidebarThreads,
  readSectionDisplayMode,
  writeSectionDisplayMode,
  type SidebarSectionDisplayMode,
  type SidebarSectionDisplayStorage,
} from "./renderer-sidebar-sections-model.js";

export interface RendererSidebarSectionsApi {
  refresh(): void;
  dispose(): void;
}

export interface RendererSidebarSectionsOptions {
  document?: Document;
  window?: Window;
  storage?: SidebarSectionDisplayStorage | null;
  loadRecency?: () => Promise<Map<string, number> | null>;
}

declare global {
  interface Window {
    __codexhostSidebarSectionsV1?: RendererSidebarSectionsApi;
  }
}

const REFRESH_DELAY_MS = 60;
const RECENCY_TTL_MS = 1_000;
const THREAD_KEY_SEPARATOR = "\u0000";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function threadKey(hostId: string, threadId: string): string {
  return `${hostId}${THREAD_KEY_SEPARATOR}${threadId}`;
}

function readBootstrapRecency(value: unknown): Map<string, number> | null {
  if (!record(value) || !Array.isArray(value.catalogEntries)) return null;
  const recency = new Map<string, number>();
  for (const entry of value.catalogEntries) {
    if (!record(entry)) continue;
    const { hostId, threadId, sourceRecencyAt } = entry;
    if (
      typeof hostId !== "string" ||
      typeof threadId !== "string" ||
      typeof sourceRecencyAt !== "number" ||
      !Number.isFinite(sourceRecencyAt)
    ) {
      continue;
    }
    recency.set(threadKey(hostId, threadId), sourceRecencyAt);
  }
  return recency;
}

function bootstrapLoader(view: Window): (() => Promise<unknown>) | null {
  const bridge = (view as unknown as { electronBridge?: { getInitialSidebarBootstrap?: unknown } })
    .electronBridge;
  if (!bridge || typeof bridge.getInitialSidebarBootstrap !== "function") return null;
  const load = bridge.getInitialSidebarBootstrap as () => Promise<unknown>;
  return () => Promise.resolve(load.call(bridge));
}

function rendererStorage(view: Window): SidebarSectionDisplayStorage | null {
  try {
    return view.localStorage;
  } catch {
    return null;
  }
}

function rowThreadIdentity(row: { element: HTMLElement; threadId: string }): string {
  return threadIdFromSidebarRowElement(row.element) ?? readRowThreadId(row.element) ?? row.threadId;
}

function mergedOrder(
  snapshot: SidebarSectionSnapshot,
  recency: ReadonlyMap<string, number> | null,
): { orderByRow: Map<HTMLElement, number>; maxOrder: number } {
  const elementsByKey = new Map<string, HTMLElement>();
  const groups = snapshot.projects.map((project, projectIndex) =>
    project.rows.map((row, rowIndex) => {
      const baseKey = threadKey(row.hostId, rowThreadIdentity(row));
      const uniqueKey = `${baseKey}\u0001${projectIndex}:${rowIndex}`;
      elementsByKey.set(uniqueKey, row.element);
      return { threadId: uniqueKey, pinned: row.pinned, recency: recency?.get(baseKey) ?? null };
    }),
  );
  const merged = mergeSidebarThreads(groups);
  const orderByRow = new Map<HTMLElement, number>();
  merged.forEach((key, index) => {
    const element = elementsByKey.get(key);
    if (element) orderByRow.set(element, index);
  });
  return { orderByRow, maxOrder: Math.max(merged.length - 1, 0) };
}

export function installRendererSidebarSections(
  options: RendererSidebarSectionsOptions = {},
): RendererSidebarSectionsApi {
  const target = options.window ?? window;
  const existing = target.__codexhostSidebarSectionsV1;
  if (existing) return existing;
  const document = options.document ?? target.document;
  const storage = options.storage === undefined ? rendererStorage(target) : options.storage;
  const style = new SidebarSectionsStyle(document);
  const toggles = new WeakMap<HTMLElement, HTMLButtonElement>();
  const warned = new Set<string>();
  const load =
    options.loadRecency ??
    (() => {
      const loader = bootstrapLoader(target);
      return loader ? loader().then(readBootstrapRecency) : Promise.resolve(null);
    });

  let disposed = false;
  let timer: number | null = null;
  let recency: Map<string, number> | null = null;
  let recencyAt = 0;
  let recencyPending = false;
  let maxOrder = 0;

  const sectionContainers = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>(SIDEBAR_SECTION_CONTAINER_SELECTOR)].filter(
      (container) => {
        const rect = container.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
    );

  const containersById = (sectionId: string): HTMLElement[] =>
    sectionContainers().filter((container) => readSectionId(container) === sectionId);

  const warnOnce = (sectionId: string, reason: SidebarSectionFallbackReason): void => {
    const key = `${sectionId}:${reason}`;
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`codexhost sidebar section kept native layout: ${reason}`);
  };

  const ensureRecency = (): void => {
    if (recencyPending || Date.now() - recencyAt < RECENCY_TTL_MS) return;
    let promise: Promise<Map<string, number> | null>;
    try {
      promise = load();
    } catch {
      recencyAt = Date.now();
      return;
    }
    recencyPending = true;
    void promise
      .then((value) => {
        recencyPending = false;
        if (disposed) return;
        recencyAt = Date.now();
        if (value) recency = value;
        refresh();
      })
      .catch(() => {
        recencyPending = false;
        recencyAt = Date.now();
      });
  };

  const toggleSection = (sectionId: string): void => {
    const current = readSectionDisplayMode(sectionId, storage);
    const next: SidebarSectionDisplayMode = current === "merged" ? "grouped" : "merged";
    if (!writeSectionDisplayMode(sectionId, next, storage)) return;
    refresh();
    if (next === "merged") {
      const failed = containersById(sectionId).some((container) =>
        container.getAttribute(MERGED_SECTION_STATE_ATTRIBUTE)?.startsWith("fallback"),
      );
      if (failed) {
        writeSectionDisplayMode(sectionId, "grouped", storage);
        refresh();
      }
    }
  };

  const ensureToggle = (
    snapshot: SidebarSectionSnapshot,
    mode: SidebarSectionDisplayMode,
  ): HTMLButtonElement | null => {
    let button = toggles.get(snapshot.section);
    if (!button) {
      button = createSectionDisplayToggle(document, mode === "grouped", () => {
        toggleSection(snapshot.sectionId);
      });
      toggles.set(snapshot.section, button);
    }
    button.setAttribute("aria-pressed", String(mode === "grouped"));
    if (!placeSectionDisplayToggle(snapshot.section, button)) {
      button.remove();
      return null;
    }
    return button;
  };

  function refresh(): void {
    if (disposed) return;
    ensureRecency();
    maxOrder = 0;
    for (const container of sectionContainers()) {
      const sectionId = readSectionId(container);
      if (!sectionId) continue;
      const mode = readSectionDisplayMode(sectionId, storage);
      const sectionElement = findSectionElement(container);
      const existingToggle = sectionElement ? toggles.get(sectionElement) : undefined;
      existingToggle?.setAttribute("aria-pressed", String(mode === "grouped"));
      const result = readSectionSnapshot(container);
      if (!result.ok) {
        clearMergeMarks(container);
        container.setAttribute(MERGED_SECTION_STATE_ATTRIBUTE, `fallback:${result.reason}`);
        warnOnce(sectionId, result.reason);
        continue;
      }
      if (!ensureToggle(result.snapshot, mode)) {
        clearMergeMarks(container);
        container.setAttribute(MERGED_SECTION_STATE_ATTRIBUTE, "fallback:toggle-missing");
        warnOnce(sectionId, "toggle-missing");
        continue;
      }
      if (mode === "grouped") {
        clearMergeMarks(container);
        container.setAttribute(MERGED_SECTION_STATE_ATTRIBUTE, "grouped");
        continue;
      }
      const { orderByRow, maxOrder: sectionMaxOrder } = mergedOrder(result.snapshot, recency);
      maxOrder = Math.max(maxOrder, sectionMaxOrder);
      for (const project of result.snapshot.projects) {
        for (const row of project.rows) row.element.removeAttribute(MERGE_ORDER_ATTRIBUTE);
      }
      applyMergeMarks(result.snapshot, orderByRow);
      container.setAttribute(MERGED_SECTION_STATE_ATTRIBUTE, "merged");
    }
    style.apply(mergeStyleCss(maxOrder));
  }

  const schedule = (): void => {
    if (disposed || timer !== null) return;
    timer = target.setTimeout(() => {
      timer = null;
      refresh();
    }, REFRESH_DELAY_MS);
  };

  const observer = new MutationObserver(schedule);
  const observerRoot = document.body ?? document.documentElement;
  observer.observe(observerRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      SIDEBAR_THREAD_ROW_ATTRIBUTE,
      SIDEBAR_THREAD_ID_ATTRIBUTE,
      SIDEBAR_PROJECT_ROW_ATTRIBUTE,
      SIDEBAR_PROJECT_COLLAPSED_ATTRIBUTE,
      SIDEBAR_PROJECT_SHOW_ALL_ATTRIBUTE,
    ],
  });
  target.addEventListener("storage", schedule);
  target.addEventListener("resize", schedule);
  refresh();

  const api: RendererSidebarSectionsApi = {
    refresh,
    dispose() {
      disposed = true;
      observer.disconnect();
      target.removeEventListener("storage", schedule);
      target.removeEventListener("resize", schedule);
      if (timer !== null) target.clearTimeout(timer);
      for (const container of document.querySelectorAll<HTMLElement>(
        SIDEBAR_SECTION_CONTAINER_SELECTOR,
      )) {
        for (const button of container.querySelectorAll(
          `[data-codexhost-section-display-toggle]`,
        )) {
          button.remove();
        }
        clearMergeMarks(container);
      }
      style.dispose();
      delete target.__codexhostSidebarSectionsV1;
    },
  };
  Object.defineProperty(target, "__codexhostSidebarSectionsV1", {
    configurable: true,
    value: api,
  });
  return api;
}
