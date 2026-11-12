import type { DesktopRemoteConnection } from "@codexhost/shared-contracts";

import {
  groupProviderModels,
  type ProviderModelGroup,
  type ProviderConfigLike,
} from "./renderer-project-mirror-model.js";

export interface CrossHostModel {
  id: string;
  label: string;
  defaultReasoningEffort: string | null;
  isDefault: boolean;
}

export interface CrossHostProvider {
  providerId: string;
  providerLabel: string;
  models: CrossHostModel[];
}

export interface CrossHostMachine {
  hostId: string;
  label: string;
  state: "ready" | "offline" | "error";
  defaultProviderId: string | null;
  providers: CrossHostProvider[];
}

export interface CrossHostModelCatalog {
  machines: CrossHostMachine[];
}

export interface CrossHostCatalogRequest {
  (hostId: string, method: string, params: unknown): Promise<unknown>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function responseData(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (record(value) && Array.isArray(value.data)) return value.data;
  return [];
}

function modelFromRow(value: unknown): CrossHostModel | null {
  if (!record(value) || typeof value.id !== "string" || value.id.length === 0) return null;
  const displayName = typeof value.displayName === "string" ? value.displayName : null;
  return {
    id: value.id,
    label: displayName ?? value.id,
    defaultReasoningEffort:
      typeof value.defaultReasoningEffort === "string" ? value.defaultReasoningEffort : null,
    isDefault: value.isDefault === true,
  };
}

function providersFromConfig(value: unknown): {
  providers: Record<string, ProviderConfigLike>;
  defaultProviderId: string | null;
} {
  const config = record(value) && record(value.config) ? value.config : value;
  if (!record(config)) return { providers: {}, defaultProviderId: null };
  const rawProviders = record(config.model_providers) ? config.model_providers : {};
  const providers: Record<string, ProviderConfigLike> = {};
  for (const [id, entry] of Object.entries(rawProviders)) {
    providers[id] = {
      name: record(entry) && typeof entry.name === "string" ? entry.name : null,
    };
  }
  return {
    providers,
    defaultProviderId: typeof config.model_provider === "string" ? config.model_provider : null,
  };
}

export function crossHostMachineLabel(
  hostId: string,
  connections: readonly DesktopRemoteConnection[],
): string {
  const connection = connections.find((candidate) => candidate.hostId === hostId);
  const label = connection?.displayName?.trim() || connection?.alias?.trim();
  if (label) return label;
  const separator = hostId.indexOf(":");
  return separator >= 0 ? hostId.slice(separator + 1) : hostId;
}

export async function loadCrossHostModelCatalog(input: {
  hostIds: readonly string[];
  connections: readonly DesktopRemoteConnection[];
  isOnline: (hostId: string) => boolean;
  request: CrossHostCatalogRequest;
}): Promise<CrossHostModelCatalog> {
  const machines = await Promise.all(
    input.hostIds.map(async (hostId): Promise<CrossHostMachine> => {
      const label = crossHostMachineLabel(hostId, input.connections);
      if (!input.isOnline(hostId))
        return { hostId, label, state: "offline", defaultProviderId: null, providers: [] };
      try {
        const [modelsResponse, configResponse] = await Promise.all([
          input.request(hostId, "model/list", {}),
          input.request(hostId, "config/read", { includeLayers: false }),
        ]);
        const models = responseData(modelsResponse)
          .map(modelFromRow)
          .filter((model): model is CrossHostModel => model !== null);
        const { providers, defaultProviderId } = providersFromConfig(configResponse);
        const groups: ProviderModelGroup[] = groupProviderModels(
          models,
          providers,
          defaultProviderId,
        );
        return {
          hostId,
          label,
          state: "ready",
          defaultProviderId,
          providers: groups.map((group) => ({
            providerId: group.providerId,
            providerLabel: group.providerLabel,
            models: group.models.map((model) => ({
              id: model.id,
              label: model.label ?? model.displayName ?? model.id,
              defaultReasoningEffort: model.defaultReasoningEffort ?? null,
              isDefault: model.isDefault === true,
            })),
          })),
        };
      } catch {
        return { hostId, label, state: "error", defaultProviderId: null, providers: [] };
      }
    }),
  );
  return {
    machines: machines.sort((left, right) => left.label.localeCompare(right.label)),
  };
}
