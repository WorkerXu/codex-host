import {
  CODEX_AGENT_DESCRIPTION_MAX_LENGTH,
  CODEX_AGENT_EFFORT_MAX_LENGTH,
  CODEX_AGENT_INSTRUCTIONS_MAX_LENGTH,
  CODEX_AGENT_MODEL_MAX_LENGTH,
  defaultDingTalkAgentDispatch,
  dingtalkAgentDispatchFor,
  isCodexAgentName,
  type CodexAgentCatalogResult,
  type CodexAgentModelEffort,
  type CodexAgentRecord,
  type CodexAgentSaveParams,
  type DingTalkAgentDispatch,
  type DingTalkDispatchSettings,
} from "@codexhost/shared-contracts";

export interface CodexAgentDraft {
  /** Null creates a new file named after the agent. */
  fileName: string | null;
  /** Null for a create; the loaded revision for an update. */
  expectedRevision: string | null;
  name: string;
  description: string;
  model: string;
  reasoningEffort: string;
  developerInstructions: string;
}

export type CodexAgentDraftField =
  "name" | "description" | "model" | "reasoningEffort" | "developerInstructions";

export type CodexAgentDraftError =
  | "invalid_name"
  | "description_required"
  | "instructions_required"
  | "too_long"
  | "model_invalid"
  | "effort_invalid";

export interface CodexAgentDraftProblem {
  field: CodexAgentDraftField;
  error: CodexAgentDraftError;
}

export function emptyAgentDraft(): CodexAgentDraft {
  return {
    fileName: null,
    expectedRevision: null,
    name: "",
    description: "",
    model: "",
    reasoningEffort: "",
    developerInstructions: "",
  };
}

export function agentDraftFromRecord(record: CodexAgentRecord): CodexAgentDraft {
  return {
    fileName: record.fileName,
    expectedRevision: record.revision,
    name: record.name,
    description: record.description,
    model: record.model ?? "",
    reasoningEffort: record.reasoningEffort ?? "",
    developerInstructions: record.developerInstructions,
  };
}

/** A duplicate keeps the name and creates a new file, so the original stays untouched. */
export function duplicateAgentDraft(record: CodexAgentRecord): CodexAgentDraft {
  return {
    ...agentDraftFromRecord(record),
    fileName: null,
    expectedRevision: null,
  };
}

export function effortOptionsForModel(
  catalog: CodexAgentCatalogResult | null,
  model: string,
): readonly CodexAgentModelEffort[] {
  const trimmed = model.trim();
  if (!trimmed || !catalog?.available) return [];
  return catalog.models.find((entry) => entry.model === trimmed)?.efforts ?? [];
}

export function validateAgentDraft(draft: CodexAgentDraft): CodexAgentDraftProblem | null {
  if (!isCodexAgentName(draft.name)) return { field: "name", error: "invalid_name" };
  if (!draft.description.trim()) {
    return { field: "description", error: "description_required" };
  }
  if (draft.description.length > CODEX_AGENT_DESCRIPTION_MAX_LENGTH) {
    return { field: "description", error: "too_long" };
  }
  if (!draft.developerInstructions.trim()) {
    return { field: "developerInstructions", error: "instructions_required" };
  }
  if (draft.developerInstructions.length > CODEX_AGENT_INSTRUCTIONS_MAX_LENGTH) {
    return { field: "developerInstructions", error: "too_long" };
  }
  if (!isSingleLineOption(draft.model, CODEX_AGENT_MODEL_MAX_LENGTH)) {
    return { field: "model", error: "model_invalid" };
  }
  if (!isSingleLineOption(draft.reasoningEffort, CODEX_AGENT_EFFORT_MAX_LENGTH)) {
    return { field: "reasoningEffort", error: "effort_invalid" };
  }
  return null;
}

/** 0–1, or null when the field is empty or outside the accepted range. */
export function parseDingTalkMatchThreshold(raw: string): number | null {
  const value = raw.trim() ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** The editor starts from the saved choice, or from every type and group replies. */
export function agentDingTalkDraft(
  settings: DingTalkDispatchSettings,
  fileName: string | null,
): DingTalkAgentDispatch {
  return fileName === null
    ? defaultDingTalkAgentDispatch()
    : dingtalkAgentDispatchFor(settings, fileName);
}

/**
 * Applies one agent's DingTalk choice without touching other agents or the
 * threshold. A brand-new agent that is left off keeps no entry at all.
 */
export function withAgentDingTalk(
  settings: DingTalkDispatchSettings,
  fileName: string,
  draft: DingTalkAgentDispatch,
): DingTalkDispatchSettings {
  if (!draft.enabled && !(fileName in settings.agents)) return settings;
  return {
    ...settings,
    agents: {
      ...settings.agents,
      [fileName]: { ...draft, eventTypes: [...draft.eventTypes] },
    },
  };
}

export function agentSaveParamsFromDraft(draft: CodexAgentDraft): CodexAgentSaveParams {
  return {
    fileName: draft.fileName,
    expectedRevision: draft.expectedRevision,
    name: draft.name.trim(),
    description: draft.description,
    model: draft.model.trim() || null,
    reasoningEffort: draft.reasoningEffort.trim() || null,
    developerInstructions: draft.developerInstructions,
  };
}

function isSingleLineOption(value: string, maximum: number): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || (trimmed.length <= maximum && !/[\r\n]/u.test(trimmed));
}
