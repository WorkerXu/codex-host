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
import { createPreferenceGroup, createPreferenceSwitch, preferenceId } from "./preference-ui.js";

export interface DingTalkDispatchSection {
  readonly root: HTMLElement;
  setAgents(agents: readonly CodexAgentSummary[]): void;
  load(): Promise<void>;
  dispose(): void;
}

const INPUT_CLASS =
  "h-8 rounded-md border border-settings-border bg-settings-surface px-2.5 text-[13px] text-settings-text outline-none focus:border-settings-focus";
const CHECKBOX_CLASS = "m-0 size-4 accent-settings-focus";

export function createDingTalkDispatchSection(
  document: Document,
  client: RendererCodexAgentsClient,
  text: CodexAgentsMessages["dingtalk"],
): DingTalkDispatchSection {
  const { group, card } = createPreferenceGroup(document, text.section);
  const description = document.createElement("p");
  description.className = "m-0 px-4 pt-3 pb-3 text-xs leading-[18px] text-settings-muted";
  description.textContent = text.description;
  card.append(description);

  const enabledId = preferenceId("dingtalk-enabled");
  const enabledRow = row(document, text.enabledTitle, text.enabledDescription, enabledId);
  const enabled = createPreferenceSwitch(document, enabledId, enabledRow.description.id);
  enabledRow.row.append(enabled);
  card.append(enabledRow.row);

  const eventsRow = row(document, text.eventsTitle, text.eventsDescription);
  const eventInputs = new Map<DingTalkEventType, HTMLInputElement>();
  const eventLabels: Record<DingTalkEventType, string> = {
    mention_me: text.eventMentionMe,
    mention_all: text.eventMentionAll,
    approval_pending: text.eventApprovalPending,
  };
  const eventGroup = document.createElement("div");
  eventGroup.className = "flex flex-wrap gap-x-4 gap-y-2";
  for (const eventType of DINGTALK_EVENT_TYPES) {
    const label = document.createElement("label");
    label.className = "flex cursor-pointer items-center gap-2 text-[13px] text-settings-text";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = CHECKBOX_CLASS;
    input.value = eventType;
    eventInputs.set(eventType, input);
    label.append(input, eventLabels[eventType]);
    eventGroup.append(label);
  }
  eventsRow.row.append(eventGroup);
  card.append(eventsRow.row);

  const thresholdRow = row(document, text.thresholdTitle, text.thresholdDescription);
  const threshold = document.createElement("input");
  threshold.type = "number";
  threshold.min = "0";
  threshold.max = "1";
  threshold.step = "0.01";
  threshold.className = `${INPUT_CLASS} w-24 text-right tabular-nums`;
  threshold.setAttribute("aria-label", text.thresholdTitle);
  thresholdRow.row.append(threshold);
  card.append(thresholdRow.row);

  const replyRow = row(document, text.replyTitle, text.replyDescription);
  const replyGroup = document.createElement("div");
  replyGroup.className = "flex flex-wrap gap-x-4 gap-y-2";
  const replyInputs: HTMLInputElement[] = [];
  for (const [value, label] of [
    ["group", text.replyGroup],
    ["direct", text.replyDirect],
  ] as const) {
    const option = document.createElement("label");
    option.className = "flex cursor-pointer items-center gap-2 text-[13px] text-settings-text";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = preferenceId("dingtalk-reply");
    input.value = value;
    input.className = CHECKBOX_CLASS;
    replyInputs.push(input);
    option.append(input, label);
    replyGroup.append(option);
  }
  replyRow.row.append(replyGroup);
  card.append(replyRow.row);

  const agentsRow = row(document, text.agentsTitle, text.agentsDescription);
  const agentsBody = document.createElement("div");
  agentsBody.className = "flex min-w-0 flex-col items-end gap-2";
  const agentList = document.createElement("div");
  agentList.className = "flex max-h-40 flex-wrap justify-end gap-x-4 gap-y-2 overflow-y-auto";
  const bulk = document.createElement("div");
  bulk.className = "flex gap-3 text-xs";
  const selectAll = textButton(document, text.selectAll);
  const clearAll = textButton(document, text.clearAll);
  bulk.append(selectAll, clearAll);
  agentsBody.append(bulk, agentList);
  agentsRow.row.append(agentsBody);
  card.append(agentsRow.row);

  const approvalNote = document.createElement("p");
  approvalNote.className =
    "mx-4 mb-2 rounded-md border border-settings-border bg-settings-inset px-3 py-2 text-xs leading-[18px] text-settings-text";
  approvalNote.textContent = text.approvalNote;
  const policyNote = document.createElement("p");
  policyNote.className = "mx-4 mb-1 text-xs leading-[18px] text-settings-muted";
  policyNote.textContent = text.policyNote;
  const runtimeNote = document.createElement("p");
  runtimeNote.className = "mx-4 mb-3 text-xs leading-[18px] text-settings-muted";
  runtimeNote.textContent = text.runtimeNote;

  const footer = document.createElement("div");
  footer.className =
    "flex items-center justify-end gap-3 border-t border-settings-divider px-4 py-3";
  const status = document.createElement("span");
  status.className = "mr-auto text-xs text-settings-muted data-[failed=true]:text-settings-danger";
  status.setAttribute("role", "status");
  const save = document.createElement("button");
  save.type = "button";
  save.className = primaryButtonClass();
  save.textContent = text.save;
  footer.append(status, save);

  const root = group;
  card.append(approvalNote, policyNote, runtimeNote, footer);

  let agents: readonly CodexAgentSummary[] = [];
  let selected = new Set<string>();
  let dirty = false;
  let disposed = false;
  let generation = 0;

  const markDirty = (): void => {
    dirty = true;
    setStatus("");
  };

  const setStatus = (value: string, failed = false): void => {
    status.textContent = value;
    status.dataset.failed = failed ? "true" : "false";
  };

  const renderAgents = (): void => {
    agentList.replaceChildren();
    const dispatchable = agents.filter((agent) => isCodexAgentName(agent.name));
    if (dispatchable.length === 0) {
      const empty = document.createElement("span");
      empty.className = "text-xs text-settings-muted";
      empty.textContent = text.agentsEmpty;
      agentList.append(empty);
      return;
    }
    for (const agent of dispatchable) {
      const label = document.createElement("label");
      label.className = "flex cursor-pointer items-center gap-2 text-[13px] text-settings-text";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = CHECKBOX_CLASS;
      input.checked = selected.has(agent.name);
      input.addEventListener("change", () => {
        if (input.checked) selected.add(agent.name);
        else selected.delete(agent.name);
        markDirty();
      });
      label.append(input, agent.name);
      agentList.append(label);
    }
  };

  const applySettings = (settings: DingTalkDispatchSettings): void => {
    enabled.checked = settings.enabled;
    for (const [eventType, input] of eventInputs) {
      input.checked = settings.eventTypes.includes(eventType);
    }
    threshold.value = String(settings.matchThreshold);
    const reply = replyInputs.find((input) => input.value === settings.replyScope);
    if (reply) reply.checked = true;
    selected = new Set(settings.participatingAgents);
    dirty = false;
    renderAgents();
  };

  const load = async (): Promise<void> => {
    const current = ++generation;
    try {
      const settings = await client.dispatchSettings();
      if (disposed || current !== generation) return;
      applySettings(settings);
      setStatus("");
    } catch {
      if (!disposed && current === generation) {
        setStatus(text.loadFailed, true);
      }
    }
  };

  enabled.addEventListener("change", markDirty);
  threshold.addEventListener("input", markDirty);
  for (const input of replyInputs) input.addEventListener("change", markDirty);
  for (const input of eventInputs.values()) input.addEventListener("change", markDirty);

  selectAll.addEventListener("click", () => {
    for (const agent of agents) {
      if (isCodexAgentName(agent.name)) selected.add(agent.name);
    }
    markDirty();
    renderAgents();
  });
  clearAll.addEventListener("click", () => {
    selected.clear();
    markDirty();
    renderAgents();
  });

  save.addEventListener("click", () => {
    const value = parseDingTalkMatchThreshold(threshold.value);
    if (value === null) {
      setStatus(text.thresholdInvalid, true);
      threshold.focus();
      return;
    }
    const replyScope =
      replyInputs.find((input) => input.checked)?.value === "direct" ? "direct" : "group";
    save.disabled = true;
    setStatus(text.saving);
    void client
      .saveDispatchSettings({
        enabled: enabled.checked,
        eventTypes: DINGTALK_EVENT_TYPES.filter((eventType) => eventInputs.get(eventType)?.checked),
        matchThreshold: value,
        replyScope,
        participatingAgents: [...selected],
      })
      .then((settings) => {
        if (disposed) return;
        applySettings(settings);
        setStatus(text.saved);
      })
      .catch(() => {
        if (!disposed) setStatus(text.saveFailed, true);
      })
      .finally(() => {
        save.disabled = false;
      });
  });

  return {
    root,
    setAgents(next) {
      agents = next;
      const known = new Set(next.map((agent) => agent.name));
      for (const name of [...selected]) {
        if (!known.has(name)) selected.delete(name);
      }
      renderAgents();
      // With no saved file the Host fills defaults from the current agents, so a
      // created or deleted agent is reflected until the user edits this section.
      if (!dirty) void load();
    },
    load,
    dispose() {
      disposed = true;
      generation += 1;
    },
  };
}

function row(
  document: Document,
  title: string,
  description: string,
  controlId?: string,
): { row: HTMLElement; description: HTMLElement } {
  const element = document.createElement("div");
  element.className =
    "flex min-h-[60px] items-center justify-between gap-6 border-t border-settings-divider px-4 py-3 first:border-t-0";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-0.5";
  const heading = document.createElement("div");
  heading.className = "text-[13px] leading-5 font-medium text-settings-text";
  heading.textContent = title;
  if (controlId) {
    const label = document.createElement("label");
    label.htmlFor = controlId;
    label.className = "cursor-pointer text-[13px] leading-5 font-medium text-settings-text";
    label.textContent = title;
    heading.replaceChildren(label);
  }
  const hint = document.createElement("div");
  hint.id = preferenceId("dingtalk-description");
  hint.className = "text-xs leading-[18px] text-settings-muted";
  hint.textContent = description;
  copy.append(heading, hint);
  element.append(copy);
  return { row: element, description: hint };
}

function textButton(document: Document, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "border-0 bg-transparent p-0 text-xs text-settings-focus hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus";
  button.textContent = label;
  return button;
}

function primaryButtonClass(): string {
  return "inline-flex h-8 items-center gap-1.5 rounded-md border-0 bg-settings-primary px-3 text-[13px] font-medium text-settings-primary-text transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:cursor-not-allowed disabled:opacity-50";
}
