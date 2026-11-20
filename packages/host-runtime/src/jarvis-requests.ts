import {
  JARVIS_BUG_SEARCH_CANCEL_METHOD,
  JARVIS_BUG_SEARCH_METHOD,
  JARVIS_DOWNLOAD_CHUNK_METHOD,
  JARVIS_DOWNLOAD_START_METHOD,
  JARVIS_INSTALL_METHOD,
  JARVIS_INSTALL_UPLOAD_METHOD,
  JARVIS_LOGIN_FORWARD_METHOD,
  JARVIS_LOGIN_START_METHOD,
  JARVIS_LOGIN_STOP_METHOD,
  JARVIS_PROJECT_BUG_SEARCH_METHOD,
  JARVIS_PROJECT_BUG_TITLE_METHOD,
  JARVIS_PROJECT_LIST_METHOD,
  JARVIS_SETTINGS_GET_METHOD,
  JARVIS_SETTINGS_SET_METHOD,
  JARVIS_SETTINGS_TEST_METHOD,
  JARVIS_STATUS_METHOD,
  jarvisBugSearchCancelParamsSchema,
  jarvisBugSearchParamsSchema,
  jarvisDownloadChunkParamsSchema,
  jarvisDownloadStartParamsSchema,
  jarvisInstallParamsSchema,
  jarvisInstallUploadParamsSchema,
  jarvisLoginForwardParamsSchema,
  jarvisLoginStopParamsSchema,
  jarvisProjectBugSearchParamsSchema,
  jarvisProjectBugTitleParamsSchema,
  jarvisProjectListParamsSchema,
  jarvisSettingsSetParamsSchema,
  jsonValueSchema,
} from "@codexhost/shared-contracts";
import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";
import { rpcEnvelope, rpcError, type HostRequestOrigin } from "./desktop-rpc.js";
import { JarvisServiceError, type JarvisService } from "./jarvis-service.js";
import type { ModelService } from "./model-service.js";
import { ZodError } from "zod";

export async function handleJarvisRequest(
  request: JsonRpcRequest,
  origin: HostRequestOrigin,
  jarvis?: JarvisService,
  modelService?: ModelService,
): Promise<JsonObject> {
  if (request.method.startsWith("codexhost/model-service/")) {
    if (origin !== "desktop" || !modelService) return rpcError(request, -32601, "local_only");
    try {
      const result = await modelService.request(request.method, request.params);
      return rpcEnvelope(request, { result: jsonValueSchema.parse(result) });
    } catch (error) {
      if (error instanceof ZodError) return rpcError(request, -32602, "invalid_params");
      if (error instanceof Error && error.message === "unknown_method")
        return rpcError(request, -32601, "unknown_method");
      return rpcError(request, -32095, "model_service_failed");
    }
  }
  if (origin !== "desktop" || !jarvis) return rpcError(request, -32601, "unavailable");
  try {
    const result = await runJarvisMethod(jarvis, request);
    // Service schemas may retain undefined optional fields. Keep wire replies JSON-only.
    return rpcEnvelope(request, {
      result: jsonValueSchema.parse(JSON.parse(JSON.stringify(result))),
    });
  } catch (error) {
    const code = error instanceof JarvisServiceError ? error.code : "jarvis_failed";
    return rpcError(request, code === "unknown_method" ? -32601 : -32094, code);
  }
}

async function runJarvisMethod(service: JarvisService, request: JsonRpcRequest): Promise<unknown> {
  if (request.method === JARVIS_STATUS_METHOD) return await service.status();
  if (request.method === JARVIS_SETTINGS_GET_METHOD) return await service.settings();
  if (request.method === JARVIS_SETTINGS_TEST_METHOD) return await service.testSettings();
  if (request.method === JARVIS_LOGIN_START_METHOD) return await service.startLogin();
  if (request.method === JARVIS_INSTALL_METHOD) {
    const parsed = jarvisInstallParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) throw new JarvisServiceError("invalid_params", "Invalid install request");
    return await service.install();
  }
  if (request.method === JARVIS_BUG_SEARCH_CANCEL_METHOD) {
    const parsed = jarvisBugSearchCancelParamsSchema.safeParse(request.params);
    if (!parsed.success)
      throw new JarvisServiceError("invalid_params", "Invalid search cancellation");
    service.cancelSearch(parsed.data.requestId);
    return {};
  }
  if (request.method === JARVIS_PROJECT_LIST_METHOD) {
    const parsed = jarvisProjectListParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) {
      throw new JarvisServiceError("invalid_params", "Invalid Jarvis project list request");
    }
    return await service.listProjects(parsed.data);
  }
  if (request.method === JARVIS_PROJECT_BUG_TITLE_METHOD) {
    const parsed = jarvisProjectBugTitleParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new JarvisServiceError("invalid_params", "Invalid Jarvis title preview request");
    }
    return await service.previewProjectBugTitle(parsed.data);
  }
  if (request.method === JARVIS_PROJECT_BUG_SEARCH_METHOD) {
    const parsed = jarvisProjectBugSearchParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new JarvisServiceError("invalid_params", "Invalid Jarvis project search request");
    }
    return await service.searchProjectBugs(parsed.data);
  }
  if (request.method === JARVIS_BUG_SEARCH_METHOD) {
    const parsed = jarvisBugSearchParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new JarvisServiceError("invalid_params", "Invalid Jarvis bug search request");
    }
    return await service.searchBugs(parsed.data);
  }
  if (request.method === JARVIS_SETTINGS_SET_METHOD) {
    const parsed = jarvisSettingsSetParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new JarvisServiceError("invalid_params", "Invalid Jarvis settings");
    }
    return await service.updateSettings(parsed.data);
  }
  if (request.method === JARVIS_DOWNLOAD_START_METHOD) {
    const parsed = jarvisDownloadStartParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new JarvisServiceError("invalid_params", "Invalid download request");
    return await service.startDownload(parsed.data.release);
  }
  if (request.method === JARVIS_DOWNLOAD_CHUNK_METHOD) {
    const parsed = jarvisDownloadChunkParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new JarvisServiceError("invalid_params", "Invalid download chunk");
    return await service.downloadChunk(parsed.data.token, parsed.data.offset, parsed.data.length);
  }
  if (request.method === JARVIS_INSTALL_UPLOAD_METHOD) {
    const parsed = jarvisInstallUploadParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new JarvisServiceError("invalid_params", "Invalid upload chunk");
    return await service.uploadChunk(parsed.data);
  }
  if (request.method === JARVIS_LOGIN_FORWARD_METHOD) {
    const parsed = jarvisLoginForwardParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new JarvisServiceError("invalid_params", "Invalid login forward");
    return await service.forwardLogin(parsed.data);
  }
  if (request.method === JARVIS_LOGIN_STOP_METHOD) {
    const parsed = jarvisLoginStopParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new JarvisServiceError("invalid_params", "Invalid login stop");
    service.stopForward(parsed.data.forwardId);
    return {};
  }
  throw new JarvisServiceError("unknown_method", "Unknown Jarvis method");
}
