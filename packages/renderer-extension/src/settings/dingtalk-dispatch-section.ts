import {
  DINGTALK_EVENT_TYPES,
  isCodexAgentName,
  type CodexAgentSummary,
  type DingTalkDispatchSettings,
  type DingTalkEventType,
} from "@codexhost/shared-contracts";

import type { RendererCodexAgentsClient } from "../renderer-codex-agents-client.js";
import type { CodexAgentsMessages } from "./codex-agents-messages.js";
import { parseDingTalkMatchThreshold } from "./codex-agents-form.js";

export interface DingTalkDispatchSection {
  readonly root: HTMLElement;
  setAgents(agents: readonly CodexAgentSummary[]): void;
  load(): Promise<void>;
  dispose(): void;
}

type SectionStatus = "idle" | "loading" | "saving" | "saved" | "failed";

const EVENT_LABEL_KEYS: Record<DingTalkEventType, keyof CodexAgentsMessages["dingtalk"]> = {
  mention_me: "eventMentionMe",
  mention_all: "eventMentionAll",
  approval_pending: "eventApprovalPending",
};

export function createDingTalkDispatchSection(
  document: Document,
  client: RendererCodexAgentsClient,
  text: CodexAgentsMessages["dingtalk"],
): DingTalkDispatchSection {
  const root = document.createElement("section");
  root.className = "dingtalk-listener";
  const head = document.createElement("div");
  head.className = "dingtalk-listener-head";
  const heading = document.createElement("h3");
  heading.className = "dingtalk-listener-title";
  heading.textContent = text.section;
  const description = document.createElement("p");
  description.className = "dingtalk-listener-description";
  description.textContent = text.description;
  head.append(heading, description);
  const card = document.createElement("div");
  card.className = "dingtalk-listener-card";

  const switchRow = document.createElement("label");
  switchRow.className = "dingtalk-switch-row";
  const switchCopy = document.createElement("span");
  switchCopy.className = "dingtalk-switch-copy";
  const switchTitle = document.createElement("span");
  switchTitle.className = "dingtalk-switch-title";
  switchTitle.textContent = text.enabledTitle;
  const switchHint = document.createElement("span");
  switchHint.className = "dingtalk-switch-hint";
  switchHint.textContent = text.enabledDescription;
  switchCopy.append(switchTitle, switchHint);
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.className = "dingtalk-switch";
  enabled.setAttribute("aria-label", text.enabledTitle);
  switchRow.append(switchCopy, enabled);

  const body = document.createElement("div");
  body.className = "dingtalk-listener-body";

  const eventsField = document.createElement("div");
  eventsField.className = "dingtalk-listener-field dingtalk-listener-events";
  eventsField.append(fieldTitle(document, text.eventsTitle));
  const eventGroup = document.createElement("div");
  eventGroup.className = "dingtalk-check-list";
  const eventInputs = new Map<DingTalkEventType, HTMLInputElement>();
  for (const eventType of DINGTALK_EVENT_TYPES) {
    const label = document.createElement("label");
    label.className = "dingtalk-check-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "dingtalk-checkbox";
    input.value = eventType;
    eventInputs.set(eventType, input);
    label.append(input, document.createTextNode(text[EVENT_LABEL_KEYS[eventType]]));
    eventGroup.append(label);
  }
  eventsField.append(eventGroup);

  const thresholdField = document.createElement("div");
  thresholdField.className = "dingtalk-listener-field";
  const thresholdHead = document.createElement("div");
  thresholdHead.className = "dingtalk-field-head";
  thresholdHead.append(fieldTitle(document, text.thresholdTitle));
  const thresholdValue = document.createElement("output");
  thresholdValue.className = "dingtalk-threshold-value";
  thresholdHead.append(thresholdValue);
  const threshold = document.createElement("input");
  threshold.type = "range";
  threshold.min = "0";
  threshold.max = "1";
  threshold.step = "0.01";
  threshold.className = "dingtalk-threshold";
  threshold.setAttribute("aria-label", text.thresholdTitle);
  const thresholdHint = document.createElement("p");
  thresholdHint.className = "dingtalk-field-hint";
  thresholdHint.textContent = text.thresholdDescription;
  thresholdField.append(thresholdHead, threshold, thresholdHint);

  const replyField = document.createElement("div");
  replyField.className = "dingtalk-listener-field";
  replyField.append(fieldTitle(document, text.replyTitle));
  const replyGroup = document.createElement("div");
  replyGroup.className = "dingtalk-segmented";
  replyGroup.setAttribute("role", "group");
  replyGroup.setAttribute("aria-label", text.replyTitle);
  const replyInputs = new Map<"group" | "direct", HTMLButtonElement>();
  for (const [value, label] of [
    ["group", text.replyGroup],
    ["direct", text.replyDirect],
  ] as const) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "dingtalk-segment";
    option.dataset.value = value;
    option.textContent = label;
    option.setAttribute("aria-pressed", "false");
    option.addEventListener("click", () => {
      setReply(value);
      markDirty();
    });
    replyInputs.set(value, option);
    replyGroup.append(option);
  }
  replyField.append(replyGroup);

  const agentsField = document.createElement("div");
  agentsField.className = "dingtalk-listener-field";
  const agentsHead = document.createElement("div");
  agentsHead.className = "dingtalk-field-head";
  agentsHead.append(fieldTitle(document, text.agentsTitle));
  const agentsBulk = document.createElement("div");
  agentsBulk.className = "dingtalk-field-actions";
  const selectAll = textButton(document, text.selectAll);
  const clearAll = textButton(document, text.clearAll);
  agentsBulk.append(selectAll, clearAll);
  agentsHead.append(agentsBulk);
  const agentsHint = document.createElement("p");
  agentsHint.className = "dingtalk-field-hint";
  agentsHint.textContent = text.agentsDescription;
  const agentList = document.createElement("div");
  agentList.className = "dingtalk-check-list dingtalk-agent-list";
  agentsField.append(agentsHead, agentsHint, agentList);

  const note = document.createElement("p");
  note.className = "dingtalk-listener-note";
  note.textContent = text.approvalNote;

  const footer = document.createElement("div");
  footer.className = "dingtalk-listener-footer";
  const status = document.createElement("span");
  status.className = "dingtalk-listener-status";
  status.setAttribute("role", "status");
  const retry = textButton(document, text.retry);
  retry.hidden = true;
  footer.append(status, retry);

  body.append(eventsField, thresholdField, replyField, agentsField);
  card.append(switchRow, body, note, footer);
  root.append(head, card);

  let agents: readonly CodexAgentSummary[] = [];
  let selected = new Set<string>();
  let dirty = false;
  let disposed = false;
  let loadGeneration = 0;
  let saveTimer: number | null = null;
  let saving = false;
  let savingAgain = false;

  const setStatus = (value: SectionStatus): void => {
    status.textContent =
      value === "saving"
        ? text.saving
        : value === "saved"
          ? text.saved
          : value === "failed"
            ? text.saveFailed
            : value === "loading"
              ? ""
              : "";
    status.dataset.state = value;
    retry.hidden = value !== "failed";
  };

  const renderBody = (): void => {
    body.hidden = !enabled.checked;
    if (!enabled.checked) setStatus("idle");
  };

  const setReply = (value: "group" | "direct"): void => {
    for (const [key, button] of replyInputs) {
      button.setAttribute("aria-pressed", String(key === value));
    }
  };

  const readReply = (): "group" | "direct" =>
    replyInputs.get("direct")?.getAttribute("aria-pressed") === "true" ? "direct" : "group";

  const renderAgents = (): void => {
    agentList.replaceChildren();
    const dispatchable = agents.filter((agent) => isCodexAgentName(agent.name));
    if (dispatchable.length === 0) {
      const empty = document.createElement("span");
      empty.className = "dingtalk-field-hint";
      empty.textContent = text.agentsEmpty;
      agentList.append(empty);
      return;
    }
    for (const agent of dispatchable) {
      const label = document.createElement("label");
      label.className = "dingtalk-check-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "dingtalk-checkbox";
      input.checked = selected.has(agent.name);
      input.addEventListener("change", () => {
        if (input.checked) selected.add(agent.name);
        else selected.delete(agent.name);
        markDirty();
      });
      const copy = document.createElement("span");
      copy.className = "dingtalk-agent-copy";
      const name = document.createElement("span");
      name.className = "dingtalk-agent-name";
      name.textContent = agent.name;
      const meta = document.createElement("span");
      meta.className = "dingtalk-agent-meta";
      meta.textContent = [agent.model, agent.reasoningEffort].filter(Boolean).join(" · ");
      copy.append(name, meta);
      label.append(input, copy);
      agentList.append(label);
    }
  };

  const applySettings = (settings: DingTalkDispatchSettings): void => {
    enabled.checked = settings.enabled;
    for (const [eventType, input] of eventInputs) {
      input.checked = settings.eventTypes.includes(eventType);
    }
    threshold.value = String(settings.matchThreshold);
    thresholdValue.textContent = settings.matchThreshold.toFixed(2);
    setReply(settings.replyScope);
    selected = new Set(settings.participatingAgents);
    dirty = false;
    renderBody();
    renderAgents();
  };

  const readSettings = (): DingTalkDispatchSettings => {
    const value = parseDingTalkMatchThreshold(threshold.value);
    if (value === null) throw new Error("threshold_invalid");
    return {
      enabled: enabled.checked,
      eventTypes: DINGTALK_EVENT_TYPES.filter((eventType) => eventInputs.get(eventType)?.checked),
      matchThreshold: value,
      replyScope: readReply(),
      participatingAgents: [...selected],
    };
  };

  const save = async (): Promise<void> => {
    if (disposed) return;
    if (saving) {
      savingAgain = true;
      return;
    }
    let settings: DingTalkDispatchSettings;
    try {
      settings = readSettings();
    } catch {
      setStatus("failed");
      return;
    }
    saving = true;
    setStatus("saving");
    try {
      const next = await client.saveDispatchSettings(settings);
      if (disposed) return;
      applySettings(next);
      setStatus("saved");
    } catch {
      if (!disposed) setStatus("failed");
    } finally {
      saving = false;
      if (!disposed && savingAgain) {
        savingAgain = false;
        void save();
      }
    }
  };

  const markDirty = (): void => {
    dirty = true;
    setStatus("idle");
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void save();
    }, 350);
  };

  enabled.addEventListener("change", () => {
    renderBody();
    markDirty();
  });
  for (const input of eventInputs.values()) input.addEventListener("change", markDirty);
  threshold.addEventListener("input", () => {
    thresholdValue.textContent = (parseDingTalkMatchThreshold(threshold.value) ?? 0).toFixed(2);
    markDirty();
  });
  selectAll.addEventListener("click", () => {
    for (const agent of agents) {
      if (isCodexAgentName(agent.name)) selected.add(agent.name);
    }
    renderAgents();
    markDirty();
  });
  clearAll.addEventListener("click", () => {
    selected.clear();
    renderAgents();
    markDirty();
  });
  retry.addEventListener("click", () => void save());

  const load = async (): Promise<void> => {
    const generation = ++loadGeneration;
    setStatus("loading");
    try {
      const settings = await client.dispatchSettings();
      if (disposed || generation !== loadGeneration) return;
      applySettings(settings);
      setStatus("idle");
    } catch {
      if (!disposed && generation === loadGeneration) setStatus("failed");
    }
  };

  return {
    root,
    setAgents(next) {
      agents = next;
      const known = new Set(next.map((agent) => agent.name));
      for (const name of [...selected]) {
        if (!known.has(name)) selected.delete(name);
      }
      renderAgents();
      // With no saved selection the Host fills defaults from the current agents.
      if (!dirty) void load();
    },
    load,
    dispose() {
      disposed = true;
      loadGeneration += 1;
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = null;
    },
  };
}

function fieldTitle(document: Document, value: string): HTMLElement {
  const title = document.createElement("div");
  title.className = "dingtalk-field-title";
  title.textContent = value;
  return title;
}

function textButton(document: Document, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dingtalk-text-button";
  button.textContent = label;
  return button;
}
