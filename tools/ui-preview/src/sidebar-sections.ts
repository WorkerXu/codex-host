import remoteSectionHtml from "../fixtures/native-sidebar-section-remote.html";
import localProjectHtml from "../fixtures/native-sidebar-project-local.html";
import { installRendererSidebarSections } from "../../../packages/renderer-extension/src/renderer-sidebar-sections.js";

export interface SidebarSectionsPreview {
  dispose(): void;
  /** Mount Desktop's new-chat draft directly on the section list. */
  simulateNewChat(): void;
}

const REMOTE_HOST = "fixture-remote-host";
const LOCAL_HOST = "fixture-local-host";

function renameProjectRows(project: Element, prefix: string): void {
  let index = 0;
  for (const row of project.querySelectorAll<HTMLElement>("[data-app-action-sidebar-thread-row]")) {
    index += 1;
    const label = `${prefix}对话 ${index}`;
    const hostId =
      project.getAttribute("data-sidebar-project-container-id") === "project:fixture-local"
        ? LOCAL_HOST
        : REMOTE_HOST;
    row.setAttribute("data-app-action-sidebar-thread-title", label);
    row.setAttribute("aria-label", label);
    row.setAttribute("data-app-action-sidebar-thread-host-id", hostId);
    row.setAttribute("data-app-action-sidebar-thread-id", `${hostId}:thread-${index}`);
    for (const title of row.querySelectorAll<HTMLElement>("[data-thread-title]")) {
      title.textContent = label;
    }
    for (const content of row.querySelectorAll<HTMLElement>("[data-marquee-content]")) {
      content.textContent = label;
    }
  }
}

function neutralAgentIcon(document: Document): HTMLElement {
  const icon = document.createElement("span");
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", "Agent");
  icon.style.cssText =
    "width:14px;height:14px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;color:var(--color-text-tertiary,#8b8b8b)";
  icon.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.4 12.8 5v6L8 13.6 3.2 11V5z"/><path d="M8 6.2v3.6"/></svg>';
  return icon;
}

function buildSection(): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = remoteSectionHtml.trim();
  const section = holder.firstElementChild;
  if (!(section instanceof HTMLElement)) throw new Error("Section fixture is missing");
  const list = [...section.querySelectorAll<HTMLElement>('div[role="list"]')].find((candidate) =>
    [...candidate.children].some(
      (child) =>
        child.getAttribute("role") === "listitem" &&
        child.querySelector('[data-sidebar-project-container-id^="project:"]') !== null,
    ),
  );
  if (!list) throw new Error("Section project list is missing");
  const template = document.createElement("template");
  template.innerHTML = localProjectHtml.trim();
  const unit = template.content.firstElementChild;
  if (!(unit instanceof HTMLElement)) throw new Error("Local project fixture is missing");
  list.append(unit);
  // The capture stripped remote image sources; draw a neutral agent glyph instead.
  for (const image of section.querySelectorAll("img"))
    image.replaceWith(neutralAgentIcon(document));

  const remote = section.querySelector(
    '[data-sidebar-project-container-id="project:fixture-remote"]',
  );
  const local = section.querySelector(
    '[data-sidebar-project-container-id="project:fixture-local"]',
  );
  if (!remote || !local) throw new Error("Project fixtures are missing");
  renameProjectRows(remote, "远端");
  renameProjectRows(local, "本机");
  // The capture has no agent icons; draw a neutral glyph where the renderer
  // extension inserts the real one.
  for (const row of section.querySelectorAll("[data-app-action-sidebar-thread-row]")) {
    const trigger = row.querySelector("[data-thread-title-trigger]");
    if (trigger && !trigger.querySelector('img, [role="img"]')) {
      trigger.prepend(neutralAgentIcon(document));
    }
  }
  return section;
}

/** Alternating recency so two projects visibly interleave in the merged list. */
function recencyMap(section: HTMLElement): Map<string, number> {
  const recency = new Map<string, number>();
  const counters = new Map<string, number>();
  for (const row of section.querySelectorAll<HTMLElement>("[data-app-action-sidebar-thread-row]")) {
    const project = row.closest<HTMLElement>('[data-sidebar-project-container-id^="project:"]');
    const projectId = project?.getAttribute("data-sidebar-project-container-id") ?? "";
    const index = counters.get(projectId) ?? 0;
    counters.set(projectId, index + 1);
    const hostId = row.getAttribute("data-app-action-sidebar-thread-host-id") ?? "";
    const threadId = (row.getAttribute("data-app-action-sidebar-thread-id") ?? "").split(":").pop();
    const base = projectId === "project:fixture-local" ? 4900 : 5000;
    if (threadId) recency.set(`${hostId}\u0000${threadId}`, base - index * 200);
  }
  return recency;
}

export function mountSidebarSectionsPreview(
  root: HTMLElement,
  mode: "merged" | "grouped" = "merged",
): SidebarSectionsPreview {
  document.documentElement.dataset.codexWindowType = "electron";
  root.replaceChildren();
  const shell = document.createElement("div");
  shell.style.cssText =
    "display:flex;height:924px;background:var(--color-surface,#fff);color:var(--color-text,#111)";
  shell.innerHTML = `
    <aside data-app-shell-left-panel-appearance="default" style="display:flex;width:306px;height:924px">
      <nav aria-label="应用导航" data-app-navigation-rail="true" style="width:52px;flex:0 0 52px"></nav>
      <div data-sidebar-navigation-root="true" style="display:flex;width:254px;flex:1;min-width:0">
        <div data-slate-sidebar-content="true" style="width:100%;height:924px">
          <div data-app-action-sidebar-scroll style="height:924px;overflow-y:auto"></div>
        </div>
      </div>
    </aside>`;
  const scroll = shell.querySelector<HTMLElement>("[data-app-action-sidebar-scroll]");
  if (!scroll) throw new Error("Sidebar fixture shell is missing");
  const section = buildSection();
  scroll.append(section);
  root.append(shell);

  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  if (mode === "grouped") {
    storage.setItem(
      "codexhost.sidebarSectionDisplay.v1",
      JSON.stringify({ "fixture-section": "grouped" }),
    );
  }
  const recency = recencyMap(section);
  const control = installRendererSidebarSections({
    window,
    document,
    storage,
    loadRecency: async () => recency,
  });
  return {
    dispose: () => control.dispose(),
    simulateNewChat() {
      const list = section.querySelector<HTMLElement>('div[role="list"]');
      const row = section.querySelector<HTMLElement>("[data-app-action-sidebar-thread-row]");
      const unit = row?.closest<HTMLElement>('[role="listitem"]');
      if (!list || !unit) throw new Error("Section row fixture is missing");
      const draft = unit.cloneNode(true) as HTMLElement;
      const draftRow = draft.querySelector<HTMLElement>("[data-app-action-sidebar-thread-row]");
      draftRow?.setAttribute("data-app-action-sidebar-thread-id", `${LOCAL_HOST}:draft-new-chat`);
      draftRow?.setAttribute("data-app-action-sidebar-thread-host-id", LOCAL_HOST);
      for (const title of draft.querySelectorAll<HTMLElement>(
        "[data-thread-title], [data-marquee-content]",
      )) {
        title.textContent = "新对话";
      }
      list.prepend(draft);
    },
  };
}
