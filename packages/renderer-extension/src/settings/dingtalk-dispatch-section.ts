import type { CodexAgentsMessages } from "./codex-agents-messages.js";
import { parseDingTalkMatchThreshold } from "./codex-agents-form.js";

export interface DingTalkDispatchSection {
  readonly root: HTMLElement;
  setThreshold(value: number): void;
  setStatus(state: SectionStatus): void;
  dispose(): void;
}

export type SectionStatus = "idle" | "saving" | "saved" | "failed";

export interface DingTalkDispatchSectionOptions {
  /** Persists the threshold; the page keeps every per-agent entry untouched. */
  onSave(threshold: number): void;
}

/** The shared DingTalk group: only the match threshold and the approval note. */
export function createDingTalkDispatchSection(
  document: Document,
  text: CodexAgentsMessages["dingtalk"],
  options: DingTalkDispatchSectionOptions,
): DingTalkDispatchSection {
  const root = document.createElement("section");
  root.className = "dingtalk-listener";
  const head = document.createElement("div");
  head.className = "dingtalk-listener-head";
  const heading = document.createElement("h3");
  heading.className = "dingtalk-listener-title";
  heading.textContent = text.section;
  head.append(heading);

  const card = document.createElement("div");
  card.className = "dingtalk-listener-card";

  const thresholdField = document.createElement("div");
  thresholdField.className = "dingtalk-listener-field dingtalk-listener-field--first";
  const thresholdTitle = document.createElement("div");
  thresholdTitle.className = "dingtalk-field-title";
  thresholdTitle.textContent = text.thresholdTitle;
  const thresholdValue = document.createElement("output");
  thresholdValue.className = "dingtalk-threshold-value";
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
  const thresholdRow = document.createElement("div");
  thresholdRow.className = "dingtalk-threshold-row";
  thresholdRow.append(threshold, thresholdValue);
  thresholdField.append(thresholdTitle, thresholdRow, thresholdHint);

  const note = document.createElement("p");
  note.className = "dingtalk-listener-note";
  note.textContent = text.approvalNote;

  const footer = document.createElement("div");
  footer.className = "dingtalk-listener-footer";
  const status = document.createElement("span");
  status.className = "dingtalk-listener-status";
  status.setAttribute("role", "status");
  footer.append(status);

  card.append(thresholdField, note, footer);
  root.append(head, card);

  const setStatus = (state: SectionStatus): void => {
    status.textContent =
      state === "saving"
        ? text.saving
        : state === "saved"
          ? text.saved
          : state === "failed"
            ? text.saveFailed
            : "";
    status.dataset.state = state;
  };

  const setThreshold = (value: number): void => {
    threshold.value = String(value);
    thresholdValue.textContent = value.toFixed(2);
  };

  let saveTimer: number | null = null;
  const scheduleSave = (): void => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      const value = parseDingTalkMatchThreshold(threshold.value);
      if (value === null) {
        setStatus("failed");
        return;
      }
      setStatus("saving");
      options.onSave(value);
    }, 350);
  };

  threshold.addEventListener("input", () => {
    thresholdValue.textContent = (parseDingTalkMatchThreshold(threshold.value) ?? 0).toFixed(2);
    scheduleSave();
  });

  return {
    root,
    setThreshold,
    setStatus,
    dispose() {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = null;
    },
  };
}
