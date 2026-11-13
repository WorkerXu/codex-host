import {
  CODEX_AGENT_CATALOG_METHOD,
  CODEX_AGENT_DELETE_METHOD,
  CODEX_AGENT_ERROR_CODES,
  CODEX_AGENT_LIST_METHOD,
  CODEX_AGENT_READ_METHOD,
  CODEX_AGENT_SAVE_METHOD,
  DINGTALK_DISPATCH_GET_METHOD,
  DINGTALK_DISPATCH_SET_METHOD,
  codexAgentCatalogResultSchema,
  codexAgentDeleteResultSchema,
  codexAgentListResultSchema,
  codexAgentRecordSchema,
  dingtalkDispatchSettingsSchema,
  type CodexAgentCatalogResult,
  type CodexAgentErrorCode,
  type CodexAgentListResult,
  type CodexAgentRecord,
  type CodexAgentSaveParams,
  type DingTalkDispatchSettings,
} from "@codexhost/shared-contracts";

export interface RendererCodexAgentsRequestOptions {
  priority?: "background" | "interactive";
  timeoutMs?: number;
}

export interface RendererCodexAgentsManager {
  sendRequest(
    method: string,
    params: unknown,
    options?: RendererCodexAgentsRequestOptions,
  ): Promise<unknown> | unknown;
}

export interface RendererCodexAgentsRoute {
  hostId: string;
  manager: RendererCodexAgentsManager;
}

export interface RendererCodexAgentsClientOptions {
  forHost(hostId: string): RendererCodexAgentsRoute | null;
}

export interface RendererCodexAgentsClient {
  available(): boolean;
  list(): Promise<CodexAgentListResult>;
  read(fileName: string): Promise<CodexAgentRecord>;
  save(input: CodexAgentSaveParams): Promise<CodexAgentRecord>;
  remove(fileName: string, expectedRevision: string): Promise<void>;
  catalog(): Promise<CodexAgentCatalogResult>;
  dispatchSettings(): Promise<DingTalkDispatchSettings>;
  saveDispatchSettings(settings: DingTalkDispatchSettings): Promise<DingTalkDispatchSettings>;
}

const LOCAL_HOST = "local";
const UNAVAILABLE = "unavailable";
const FAILED = "failed";

export type RendererCodexAgentErrorCode = CodexAgentErrorCode | typeof FAILED;

/** RPC errors carry a stable code; localize it instead of showing the raw text. */
export function codexAgentCodeFromError(error: unknown): RendererCodexAgentErrorCode {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? (error as { message?: unknown }).message
      : undefined;
  if (
    typeof message === "string" &&
    (CODEX_AGENT_ERROR_CODES as readonly string[]).includes(message)
  ) {
    return message as CodexAgentErrorCode;
  }
  if (message === UNAVAILABLE) return "unavailable";
  return FAILED;
}

export function createRendererCodexAgentsClient(
  options: RendererCodexAgentsClientOptions,
): RendererCodexAgentsClient {
  const route = (): RendererCodexAgentsRoute | null => {
    try {
      return options.forHost(LOCAL_HOST);
    } catch {
      return null;
    }
  };

  const request = async <T>(
    method: string,
    params: unknown,
    schema: { parse(value: unknown): T },
    timeoutMs: number,
  ): Promise<T> => {
    const target = route();
    if (!target) throw new Error(UNAVAILABLE);
    const result = await target.manager.sendRequest(method, params, {
      priority: "interactive",
      timeoutMs,
    });
    return schema.parse(result);
  };

  return {
    available: () => route() !== null,
    list: () => request(CODEX_AGENT_LIST_METHOD, {}, codexAgentListResultSchema, 10_000),
    read: (fileName) =>
      request(CODEX_AGENT_READ_METHOD, { fileName }, codexAgentRecordSchema, 10_000),
    save: (input) => request(CODEX_AGENT_SAVE_METHOD, input, codexAgentRecordSchema, 10_000),
    async remove(fileName, expectedRevision) {
      codexAgentDeleteResultSchema.parse(
        await request(
          CODEX_AGENT_DELETE_METHOD,
          { fileName, expectedRevision },
          codexAgentDeleteResultSchema,
          10_000,
        ),
      );
    },
    catalog: () => request(CODEX_AGENT_CATALOG_METHOD, {}, codexAgentCatalogResultSchema, 20_000),
    dispatchSettings: () =>
      request(DINGTALK_DISPATCH_GET_METHOD, {}, dingtalkDispatchSettingsSchema, 10_000),
    saveDispatchSettings: (settings) =>
      request(DINGTALK_DISPATCH_SET_METHOD, settings, dingtalkDispatchSettingsSchema, 10_000),
  };
}
