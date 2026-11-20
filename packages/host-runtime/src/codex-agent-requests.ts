import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";
import {
  jsonValueSchema,
  CODEX_AGENT_LIST_METHOD,
  CODEX_AGENT_READ_METHOD,
  CODEX_AGENT_SAVE_METHOD,
  CODEX_AGENT_DELETE_METHOD,
  CODEX_AGENT_CATALOG_METHOD,
  codexAgentListResultSchema,
  codexAgentRecordSchema,
  codexAgentReadParamsSchema,
  codexAgentSaveParamsSchema,
  codexAgentDeleteParamsSchema,
  codexAgentDeleteResultSchema,
  DINGTALK_DISPATCH_GET_METHOD,
  DINGTALK_DISPATCH_SET_METHOD,
  DINGTALK_DISPATCH_STATUS_METHOD,
  DINGTALK_DISPATCH_SCORE_METHOD,
  DINGTALK_DISPATCH_RUN_METHOD,
  dingtalkDispatchSettingsSchema,
  dingtalkDispatchStatusSchema,
  dingtalkDispatchMessageParamsSchema,
  dingtalkDispatchRunParamsSchema,
  dingtalkDispatchScoreResultSchema,
  dingtalkDispatchRunResultSchema,
} from "@codexhost/shared-contracts";
import { codexAgentCatalogFromModelList } from "./codex-agent-models.js";
import { CodexAgentError, type CodexAgentStore } from "./codex-agents.js";
import type { DesktopDingTalkDispatch, NativeDingTalkRequest } from "./desktop-dingtalk.js";
import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import type { DingTalkDispatchAgent } from "./dingtalk-dispatch-settings.js";
import { stripUndefined } from "./dingtalk-requests.js";

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codexAgentParamError(
  issues: ReadonlyArray<{ path: readonly PropertyKey[] }>,
): CodexAgentError {
  const field = issues[0]?.path[0];
  if (field === "name") return new CodexAgentError("invalid_name", "Invalid agent name");
  if (field === "fileName") {
    return new CodexAgentError("invalid_file_name", "Invalid agent file name");
  }
  return new CodexAgentError("invalid_params", "Invalid agent settings");
}

export async function handleCodexAgentsRequest(
  request: JsonRpcRequest,
  store: CodexAgentStore,
  requestNative: NativeDingTalkRequest,
  diagnose: (error: unknown) => void,
): Promise<JsonObject> {
  try {
    let result: unknown;
    if (request.method === CODEX_AGENT_LIST_METHOD) {
      result = codexAgentListResultSchema.parse(await store.list());
    } else if (request.method === CODEX_AGENT_READ_METHOD) {
      const params = codexAgentReadParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new CodexAgentError("invalid_file_name", "Invalid agent file name");
      }
      result = codexAgentRecordSchema.parse(await store.read(params.data.fileName));
    } else if (request.method === CODEX_AGENT_SAVE_METHOD) {
      const params = codexAgentSaveParamsSchema.safeParse(request.params);
      if (!params.success) throw codexAgentParamError(params.error.issues);
      result = codexAgentRecordSchema.parse(await store.save(params.data));
    } else if (request.method === CODEX_AGENT_DELETE_METHOD) {
      const params = codexAgentDeleteParamsSchema.safeParse(request.params);
      if (!params.success) throw codexAgentParamError(params.error.issues);
      await store.delete(params.data.fileName, params.data.expectedRevision);
      result = codexAgentDeleteResultSchema.parse({ fileName: params.data.fileName });
    } else if (request.method === CODEX_AGENT_CATALOG_METHOD) {
      result = await readCodexAgentCatalog(requestNative, diagnose);
    } else {
      throw new CodexAgentError("invalid_params", "Unknown Codex agent method");
    }
    return rpcEnvelope(request, { result: jsonValueSchema.parse(stripUndefined(result)) });
  } catch (error) {
    if (error instanceof CodexAgentError) {
      return rpcError(request, -32095, error.code);
    }
    diagnose(error);
    return rpcError(request, -32095, "io_failed");
  }
}

async function readCodexAgentCatalog(
  requestNative: NativeDingTalkRequest,
  diagnose: (error: unknown) => void,
): Promise<unknown> {
  try {
    const response = await requestNative("model/list", {});
    if (isRecord(response.error)) {
      return { available: false, models: [], defaultModel: null };
    }
    return codexAgentCatalogFromModelList(response);
  } catch (error) {
    diagnose(error);
    return { available: false, models: [], defaultModel: null };
  }
}

export async function handleDingTalkDispatchRequest(
  request: JsonRpcRequest,
  service: DesktopDingTalkDispatch,
  diagnose: (error: unknown) => void,
): Promise<JsonObject> {
  const { settings: store, dispatcher, agents } = service;
  try {
    let result: unknown;
    if (request.method === DINGTALK_DISPATCH_GET_METHOD) {
      result = await store.read(await readDingTalkDispatchAgents(agents));
    } else if (request.method === DINGTALK_DISPATCH_SCORE_METHOD) {
      const params = dingtalkDispatchMessageParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new CodexAgentError("invalid_params", "Invalid DingTalk dispatch score request");
      }
      result = dingtalkDispatchScoreResultSchema.parse(
        await dispatcher.score(params.data.conversationId, params.data.messageId),
      );
    } else if (request.method === DINGTALK_DISPATCH_RUN_METHOD) {
      const params = dingtalkDispatchRunParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new CodexAgentError("invalid_params", "Invalid DingTalk dispatch request");
      }
      result = dingtalkDispatchRunResultSchema.parse(
        await dispatcher.run(params.data.conversationId, params.data.messageId, params.data.agents),
      );
    } else if (request.method === DINGTALK_DISPATCH_STATUS_METHOD) {
      result = dingtalkDispatchStatusSchema.parse(await dispatcher.status());
    } else if (request.method === DINGTALK_DISPATCH_SET_METHOD) {
      const params = dingtalkDispatchSettingsSchema.safeParse(request.params);
      if (!params.success) {
        throw new CodexAgentError("invalid_params", "Invalid DingTalk dispatch settings");
      }
      result = await store.write(params.data);
    } else {
      throw new CodexAgentError("invalid_params", "Unknown DingTalk dispatch method");
    }
    return rpcEnvelope(request, { result: jsonValueSchema.parse(stripUndefined(result)) });
  } catch (error) {
    if (error instanceof CodexAgentError) {
      return rpcError(request, -32095, error.code);
    }
    diagnose(error);
    return rpcError(request, -32095, "io_failed");
  }
}

/** Null keeps existing entries when the agent list cannot be read. */
async function readDingTalkDispatchAgents(
  store: CodexAgentStore,
): Promise<DingTalkDispatchAgent[] | null> {
  try {
    const listed = await store.list();
    return listed.agents.map((agent) => ({
      fileName: agent.fileName,
      name: agent.name,
      description: agent.description,
    }));
  } catch {
    return null;
  }
}
