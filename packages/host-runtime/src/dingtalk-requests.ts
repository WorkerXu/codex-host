import {
  jsonValueSchema,
  DINGTALK_STATUS_METHOD,
  DINGTALK_SETTINGS_GET_METHOD,
  DINGTALK_SETTINGS_SET_METHOD,
  DINGTALK_CONVERSATIONS_METHOD,
  DINGTALK_PREVIEW_METHOD,
  DINGTALK_DETAILS_METHOD,
  DINGTALK_MESSAGES_METHOD,
  DINGTALK_MEMBERS_METHOD,
  DINGTALK_RESOURCE_METHOD,
  DINGTALK_SEND_METHOD,
  DINGTALK_SEARCH_METHOD,
  DINGTALK_RESOLVE_METHOD,
  DINGTALK_VIEWED_METHOD,
  DINGTALK_PREFETCH_METHOD,
  DINGTALK_DIAGNOSTICS_METHOD,
  DINGTALK_TIMING_METHOD,
  DINGTALK_CHANGED_METHOD,
  dingtalkStatusParamsSchema,
  dingtalkConversationsParamsSchema,
  dingtalkPreviewParamsSchema,
  dingtalkDetailsSchema,
  dingtalkMessagesParamsSchema,
  dingtalkMembersParamsSchema,
  dingtalkResourceParamsSchema,
  dingtalkSendParamsSchema,
  dingtalkSearchParamsSchema,
  dingtalkResolveParamsSchema,
  dingtalkViewedParamsSchema,
  dingtalkPrefetchParamsSchema,
  dingtalkDiagnosticsParamsSchema,
  dingtalkTimingParamsSchema,
  dingtalkSettingsSetParamsSchema,
} from "@codexhost/shared-contracts";
import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";
import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import { DingTalkServiceError, type DingTalkService } from "./dingtalk-service.js";

/** JSON-RPC results omit optional properties that were not supplied by dws. */
export function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined).map(stripUndefined);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, stripUndefined(item)]),
  );
}

export function dingtalkChanged(event: { conversationId: string | null }): JsonObject {
  return { method: DINGTALK_CHANGED_METHOD, params: event };
}

export async function handleDingTalkRequest(
  request: JsonRpcRequest,
  service: DingTalkService,
  diagnose: (error: unknown) => void,
): Promise<JsonObject> {
  try {
    const result = await runDingTalkMethod(service, request);
    return rpcEnvelope(request, { result: jsonValueSchema.parse(stripUndefined(result)) });
  } catch (error) {
    if (error instanceof DingTalkServiceError) return rpcError(request, -32094, error.code);
    diagnose(error);
    return rpcError(request, -32094, "dingtalk_failed");
  }
}

async function runDingTalkMethod(
  service: DingTalkService,
  request: JsonRpcRequest,
): Promise<unknown> {
  if (request.method === DINGTALK_STATUS_METHOD) {
    const params = dingtalkStatusParamsSchema.parse(request.params ?? {});
    return await service.status(params.refresh);
  }
  if (request.method === DINGTALK_SETTINGS_GET_METHOD) return await service.settings();
  if (request.method === DINGTALK_CONVERSATIONS_METHOD) {
    const parsed = dingtalkConversationsParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk conversation request");
    }
    return await service.conversations();
  }
  if (request.method === DINGTALK_DETAILS_METHOD) {
    const parsed = dingtalkDetailsSchema.safeParse(request.params);
    if (!parsed.success)
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk details request");
    return await service.details(parsed.data.conversations);
  }
  if (request.method === DINGTALK_PREVIEW_METHOD) {
    const parsed = dingtalkPreviewParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk preview request");
    }
    return await service.preview(parsed.data.conversationId);
  }
  if (request.method === DINGTALK_MESSAGES_METHOD) {
    const parsed = dingtalkMessagesParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk message request");
    }
    return await service.messages(parsed.data);
  }
  if (request.method === DINGTALK_MEMBERS_METHOD) {
    const parsed = dingtalkMembersParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk member request");
    }
    return await service.members(parsed.data.conversationId);
  }
  if (request.method === DINGTALK_RESOURCE_METHOD) {
    const parsed = dingtalkResourceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk resource request");
    }
    return await service.resource(parsed.data);
  }
  if (request.method === DINGTALK_SEND_METHOD) {
    const parsed = dingtalkSendParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk message");
    }
    return await service.send(parsed.data);
  }
  if (request.method === DINGTALK_SEARCH_METHOD) {
    const parsed = dingtalkSearchParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk search");
    }
    return await service.search(parsed.data);
  }
  if (request.method === DINGTALK_RESOLVE_METHOD) {
    const parsed = dingtalkResolveParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk reference");
    }
    const mention =
      parsed.data.messageIds && parsed.data.messageIds.length > 0
        ? {
            kind: "messages" as const,
            conversationId: parsed.data.conversationId,
            messageIds: parsed.data.messageIds,
            label: "",
          }
        : {
            kind: "conversation" as const,
            conversationId: parsed.data.conversationId,
            label: "",
          };
    return await service.resolve(mention);
  }
  if (request.method === DINGTALK_VIEWED_METHOD) {
    const parsed = dingtalkViewedParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk view state");
    }
    return await service.markViewed(
      parsed.data.conversationId,
      parsed.data.lastMessageAt,
      parsed.data.active !== false,
    );
  }
  if (request.method === DINGTALK_SETTINGS_SET_METHOD) {
    const parsed = dingtalkSettingsSetParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk settings");
    }
    return await service.updateSettings(parsed.data);
  }
  if (request.method === DINGTALK_PREFETCH_METHOD) {
    const parsed = dingtalkPrefetchParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk prefetch request");
    }
    return await service.prefetch(parsed.data);
  }
  if (request.method === DINGTALK_DIAGNOSTICS_METHOD) {
    const parsed = dingtalkDiagnosticsParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk diagnostics request");
    }
    return await service.diagnostics(parsed.data);
  }
  if (request.method === DINGTALK_TIMING_METHOD) {
    const parsed = dingtalkTimingParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new DingTalkServiceError("invalid_params", "Invalid DingTalk timing request");
    }
    return await service.recordTiming(parsed.data);
  }
  throw new DingTalkServiceError("unknown_method", "Unknown DingTalk method");
}
