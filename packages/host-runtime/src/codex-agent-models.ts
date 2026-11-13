import type {
  CodexAgentCatalogResult,
  CodexAgentModel,
  CodexAgentModelEffort,
} from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project the official `model/list` result into the agent form's picker data.
 * The official catalog is the only source of model ids and the reasoning
 * efforts each model accepts; the form falls back to free text when the Host
 * cannot reach it.
 */
export function codexAgentCatalogFromModelList(response: unknown): CodexAgentCatalogResult {
  if (isRecord(response) && isRecord(response.error)) {
    return { available: false, models: [], defaultModel: null };
  }
  const result = isRecord(response) && isRecord(response.result) ? response.result : null;
  if (!result) return { available: false, models: [], defaultModel: null };
  const data = Array.isArray(result.data) ? result.data : [];
  const models: CodexAgentModel[] = [];
  const seen = new Set<string>();
  let defaultModel: string | null = null;
  for (const candidate of data) {
    if (!isRecord(candidate) || typeof candidate.model !== "string") continue;
    const model = candidate.model.trim();
    if (!model || model.length > 128 || seen.has(model)) continue;
    seen.add(model);
    const efforts: CodexAgentModelEffort[] = [];
    if (Array.isArray(candidate.supportedReasoningEfforts)) {
      const seenEfforts = new Set<string>();
      for (const option of candidate.supportedReasoningEfforts) {
        if (!isRecord(option) || typeof option.reasoningEffort !== "string") continue;
        const id = option.reasoningEffort.trim();
        if (!id || id.length > 64 || seenEfforts.has(id)) continue;
        seenEfforts.add(id);
        efforts.push({
          id,
          description:
            typeof option.description === "string" ? option.description.slice(0, 256) : id,
        });
      }
    }
    models.push({
      model,
      displayName:
        typeof candidate.displayName === "string" && candidate.displayName.trim()
          ? candidate.displayName.trim().slice(0, 256)
          : model,
      efforts,
      isDefault: candidate.isDefault === true,
    });
    if (candidate.isDefault === true && defaultModel === null) defaultModel = model;
  }
  return { available: true, models, defaultModel };
}
