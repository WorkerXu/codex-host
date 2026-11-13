import {
  CODEX_AGENT_DESCRIPTION_MAX_LENGTH,
  CODEX_AGENT_EFFORT_MAX_LENGTH,
  CODEX_AGENT_INSTRUCTIONS_MAX_LENGTH,
  CODEX_AGENT_MODEL_MAX_LENGTH,
  isCodexAgentName,
  type CodexAgentCatalogResult,
  type CodexAgentModelEffort,
  type CodexAgentRecord,
  type CodexAgentSaveParams,
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
  | "name_taken"
  | "description_required"
  | "instructions_required"
  | "too_long"
  | "model_invalid"
  | "effort_invalid";

export interface CodexAgentDraftProblem {
  field: CodexAgentDraftField;
  error: CodexAgentDraftError;
}

export interface ExistingAgentIdentity {
  name: string;
  fileName: string;
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

/** A duplicate always creates a new file so the original stays untouched. */
export function duplicateAgentDraft(
  record: CodexAgentRecord,
  existing: readonly ExistingAgentIdentity[],
): CodexAgentDraft {
  return {
    ...agentDraftFromRecord(record),
    fileName: null,
    expectedRevision: null,
    name: nextDuplicateName(record.name, existing),
  };
}

export function nextDuplicateName(
  name: string,
  existing: readonly ExistingAgentIdentity[],
): string {
  const taken = new Set(existing.map((agent) => agent.name));
  const base = `${name}-copy`.slice(0, 64).replace(/-+$/u, "");
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    const tail = `-${suffix}`;
    candidate = `${base.slice(0, 64 - tail.length)}${tail}`;
    suffix += 1;
  }
  return candidate;
}

export function effortOptionsForModel(
  catalog: CodexAgentCatalogResult | null,
  model: string,
): readonly CodexAgentModelEffort[] {
  const trimmed = model.trim();
  if (!trimmed || !catalog?.available) return [];
  return catalog.models.find((entry) => entry.model === trimmed)?.efforts ?? [];
}

export function validateAgentDraft(
  draft: CodexAgentDraft,
  existing: readonly ExistingAgentIdentity[],
): CodexAgentDraftProblem | null {
  const name = draft.name.trim();
  if (!isCodexAgentName(name)) return { field: "name", error: "invalid_name" };
  const others = existing.filter((agent) => agent.fileName !== draft.fileName);
  if (others.some((agent) => agent.name === name)) {
    return { field: "name", error: "name_taken" };
  }
  if (draft.fileName === null && others.some((agent) => agent.fileName === `${name}.toml`)) {
    return { field: "name", error: "name_taken" };
  }
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
