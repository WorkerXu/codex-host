import type {
  DingTalkDispatchRunAgentResult,
  DingTalkDispatchScoreEntry,
  DingTalkDispatchScoreResult,
} from "@codexhost/shared-contracts";

import type { RendererDingTalkDispatchClient } from "../renderer-dingtalk-dispatch-client.js";
import { createAvatar, createElementNode, createIconButton } from "./dingtalk-page-view.js";
import type { DingTalkPageText } from "./dingtalk-page-strings.js";
import XIcon from "lucide/dist/esm/icons/x.mjs";

/** The panel starts with the best agent checked unless the score is too low. */
const DEFAULT_PICK_MIN = 0.3;

export interface DingTalkAgentPanelInput {
  conversationId: string;
  messageId: string;
  /** One-line message excerpt shown above the list; never stored. */
  excerpt: string;
}

export interface DingTalkAgentPanelOptions {
  document: Document;
  text: DingTalkPageText;
  client: RendererDingTalkDispatchClient | null;
  /** True when this message was already dispatched to the agent in this page. */
  hasDispatched(fileName: string): boolean;
  /** Applies one successful or failed agent result to the page state. */
  onRun(results: readonly DingTalkDispatchRunAgentResult[]): void;
  onClose(): void;
}

export interface DingTalkAgentPanel {
  readonly element: HTMLElement;
  readonly open: boolean;
  show(input: DingTalkAgentPanelInput): void;
  close(): void;
  dispose(): void;
}

function scoreLabel(value: number | null, text: DingTalkPageText): string {
  return value === null
    ? "—"
    : text.panelScore.replace("{percent}", String(Math.round(value * 100)));
}

/** Right-side sheet that scores enabled agents for exactly one message. */
export function createDingTalkAgentPanel(options: DingTalkAgentPanelOptions): DingTalkAgentPanel {
  const { document, text } = options;
  const root = createElementNode(document, "div", "dingtalk-agent-panel");
  root.hidden = true;
  const scrim = createElementNode(document, "div", "dingtalk-agent-panel-scrim");
  const sheet = createElementNode(document, "section", "dingtalk-agent-panel-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", text.panelTitle);

  const head = createElementNode(document, "header", "dingtalk-agent-panel-head");
  const titles = createElementNode(document, "div", "dingtalk-agent-panel-titles");
  const title = createElementNode(document, "h3", "dingtalk-agent-panel-title", text.panelTitle);
  const subtitle = createElementNode(
    document,
    "p",
    "dingtalk-agent-panel-subtitle",
    text.panelSubtitle,
  );
  titles.append(title, subtitle);
  const closeButton = createIconButton(document, text.panelClose, XIcon, {
    className: "dingtalk-agent-panel-close",
    size: 16,
  });
  head.append(titles, closeButton);

  const excerpt = createElementNode(document, "p", "dingtalk-agent-panel-excerpt");
  const notice = createElementNode(document, "p", "dingtalk-agent-panel-notice");
  notice.hidden = true;
  const list = createElementNode(document, "div", "dingtalk-agent-panel-list");
  list.setAttribute("role", "group");

  const confirm = createElementNode(document, "div", "dingtalk-agent-panel-confirm");
  confirm.hidden = true;
  const confirmText = createElementNode(
    document,
    "p",
    "dingtalk-agent-panel-confirm-text",
    text.panelAlready,
  );
  const confirmActions = createElementNode(document, "div", "dingtalk-agent-panel-confirm-actions");
  const confirmYes = document.createElement("button");
  confirmYes.type = "button";
  confirmYes.className = "dingtalk-agent-panel-primary";
  confirmYes.textContent = text.panelStillDispatch;
  const confirmNo = document.createElement("button");
  confirmNo.type = "button";
  confirmNo.className = "dingtalk-agent-panel-secondary";
  confirmNo.textContent = text.panelCancel;
  confirmActions.append(confirmNo, confirmYes);
  confirm.append(confirmText, confirmActions);

  const footer = createElementNode(document, "footer", "dingtalk-agent-panel-footer");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dingtalk-agent-panel-secondary";
  cancel.textContent = text.panelCancel;
  const dispatch = document.createElement("button");
  dispatch.type = "button";
  dispatch.className = "dingtalk-agent-panel-primary";
  dispatch.disabled = true;
  footer.append(cancel, dispatch);

  sheet.append(head, excerpt, notice, list, confirm, footer);
  root.append(scrim, sheet);

  let current: DingTalkAgentPanelInput | null = null;
  let entries: DingTalkDispatchScoreEntry[] = [];
  let selected = new Set<string>();
  let loading = false;
  let dispatching = false;
  let generation = 0;
  let panelOpen = false;

  const checked = (): string[] => [...selected];

  const updateFooter = (): void => {
    const count = selected.size;
    dispatch.textContent = loading
      ? text.panelScoring
      : dispatching
        ? text.panelDispatching
        : text.panelDispatch.replace("{count}", String(count));
    dispatch.disabled = loading || dispatching || count === 0;
    cancel.disabled = dispatching;
    for (const row of list.querySelectorAll<HTMLElement>(".dingtalk-agent-row")) {
      const fileName = row.dataset.agentFile ?? "";
      const checkbox = row.querySelector<HTMLInputElement>(".dingtalk-agent-row-check");
      if (checkbox) checkbox.checked = selected.has(fileName);
    }
  };

  const applyDefaultSelection = (result: DingTalkDispatchScoreResult): void => {
    selected = new Set();
    if (result.agents.length === 0) return;
    const top = result.agents[0];
    if (result.failed || !top || top.score === null) return;
    if (top.score < DEFAULT_PICK_MIN || !top.agent.ready) return;
    selected.add(top.agent.fileName);
  };

  const renderRows = (result: DingTalkDispatchScoreResult): void => {
    // The Host sorts too; sorting here keeps failure fallback by name even when
    // a proxy returns the original order.
    entries = [...result.agents].sort((left, right) => {
      if (left.score === null && right.score === null) {
        return left.agent.name.localeCompare(right.agent.name, "zh-CN");
      }
      if (left.score === null) return 1;
      if (right.score === null) return -1;
      return right.score - left.score;
    });
    list.replaceChildren();
    notice.hidden = !result.failed;
    notice.textContent = result.failed ? text.panelFailed : "";
    if (entries.length === 0) {
      const empty = createElementNode(document, "p", "dingtalk-agent-panel-empty", text.panelEmpty);
      list.append(empty);
      updateFooter();
      return;
    }
    for (const entry of entries) {
      const row = createElementNode(document, "label", "dingtalk-agent-row");
      row.dataset.agentFile = entry.agent.fileName;
      if (!entry.agent.ready) row.dataset.disabled = "true";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "dingtalk-agent-row-check";
      check.disabled = !entry.agent.ready || dispatching;
      check.checked = selected.has(entry.agent.fileName);
      check.addEventListener("change", () => {
        if (check.checked) selected.add(entry.agent.fileName);
        else selected.delete(entry.agent.fileName);
        updateFooter();
      });
      const avatar = createAvatar(
        document,
        {
          conversationId: entry.agent.fileName,
          title: entry.agent.name,
          singleChat: true,
        },
        28,
      );
      const copy = createElementNode(document, "span", "dingtalk-agent-row-copy");
      const line = createElementNode(document, "span", "dingtalk-agent-row-line");
      const name = createElementNode(document, "span", "dingtalk-agent-row-name", entry.agent.name);
      const score = createElementNode(
        document,
        "span",
        "dingtalk-agent-row-score",
        scoreLabel(entry.score, text),
      );
      line.append(name, score);
      const duty = createElementNode(
        document,
        "span",
        "dingtalk-agent-row-duty",
        entry.agent.description,
      );
      duty.title = entry.agent.description;
      copy.append(line, duty);
      if (!entry.agent.ready) {
        copy.append(
          createElementNode(document, "span", "dingtalk-agent-row-hint", text.panelNeedsTarget),
        );
      }
      row.append(check, avatar, copy);
      if (entry.score !== null && entry.agent.ready) {
        const bar = createElementNode(document, "span", "dingtalk-agent-row-bar");
        const fill = createElementNode(document, "span", "dingtalk-agent-row-bar-fill");
        fill.style.width = `${Math.round(entry.score * 100)}%`;
        bar.append(fill);
        row.append(bar);
      }
      list.append(row);
    }
    updateFooter();
  };

  const loadScore = async (input: DingTalkAgentPanelInput): Promise<void> => {
    const run = ++generation;
    loading = true;
    entries = [];
    selected = new Set();
    list.replaceChildren(
      createElementNode(document, "p", "dingtalk-agent-panel-empty", text.panelLoading),
    );
    notice.hidden = true;
    confirm.hidden = true;
    updateFooter();
    if (!options.client) {
      loading = false;
      renderRows({ agents: [], failed: true });
      return;
    }
    const result = await options.client
      .score(input.conversationId, input.messageId)
      .catch(() => ({ agents: [], failed: true }));
    if (run !== generation || !panelOpen) return;
    loading = false;
    applyDefaultSelection(result);
    renderRows(result);
  };

  const runDispatch = async (): Promise<void> => {
    if (!current || !options.client || dispatching) return;
    const agents = checked();
    if (agents.length === 0) return;
    if (!confirm.hidden) confirm.hidden = true;
    dispatching = true;
    for (const check of list.querySelectorAll<HTMLInputElement>(".dingtalk-agent-row-check")) {
      check.disabled = true;
    }
    updateFooter();
    const results = await options.client
      .run(current.conversationId, current.messageId, agents)
      .catch(() => null);
    dispatching = false;
    if (!results) {
      notice.hidden = false;
      notice.textContent = text.panelFailed;
      updateFooter();
      return;
    }
    options.onRun(results.results);
    api.close();
  };

  const requestDispatch = (): void => {
    if (dispatching || loading) return;
    const agents = checked();
    if (agents.length === 0) return;
    if (agents.some((fileName) => options.hasDispatched(fileName))) {
      confirm.hidden = false;
      confirmYes.focus();
      return;
    }
    void runDispatch();
  };

  closeButton.addEventListener("click", () => api.close());
  cancel.addEventListener("click", () => api.close());
  scrim.addEventListener("click", () => api.close());
  confirmNo.addEventListener("click", () => {
    confirm.hidden = true;
    updateFooter();
  });
  confirmYes.addEventListener("click", () => void runDispatch());
  dispatch.addEventListener("click", requestDispatch);

  const api: DingTalkAgentPanel = {
    element: root,
    get open() {
      return panelOpen;
    },
    show(input) {
      current = input;
      panelOpen = true;
      root.hidden = false;
      excerpt.textContent = input.excerpt;
      void loadScore(input);
    },
    close() {
      if (!panelOpen) return;
      panelOpen = false;
      generation += 1;
      loading = false;
      dispatching = false;
      current = null;
      root.hidden = true;
      confirm.hidden = true;
      options.onClose();
    },
    dispose() {
      panelOpen = false;
      generation += 1;
      root.remove();
    },
  };
  return api;
}
