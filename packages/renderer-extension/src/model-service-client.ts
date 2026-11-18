import {
  MODEL_SERVICE_GET_METHOD,
  MODEL_SERVICE_SET_METHOD,
  MODEL_SERVICE_TEST_METHOD,
  modelServiceSettingsSchema,
  modelServiceTestResultSchema,
  type ModelProvider,
  type ModelServiceSettings,
  type ModelServiceSet,
  type ModelServiceTestResult,
} from "@codexhost/shared-contracts";
import type { RendererRequestOptions } from "./renderer-request-sender.js";
interface RendererModelServiceManager {
  sendRequest(
    method: string,
    params: unknown,
    options?: RendererRequestOptions,
  ): Promise<unknown> | unknown;
}
export interface RendererModelServiceClient {
  read(): Promise<ModelServiceSettings>;
  update(value: ModelServiceSet): Promise<ModelServiceSettings>;
  test(provider: ModelProvider): Promise<ModelServiceTestResult>;
}
export function modelServiceErrorText(
  code: string | null | undefined,
  provider: string = "openai",
): string {
  const name = provider === "gemini" ? "Gemini" : "OpenAI";
  const messages: Record<string, string> = {
    missing_key: `未配置 ${name} Key`,
    quota_exhausted: `${name} 额度不足`,
    unauthorized: `${name} Key 无效`,
    invalid_key: `${name} Key 无效`,
    timeout: "连接超时，模型未响应",
    network: "网络连接失败",
    rate_limited: "请求过于频繁，请稍后重试",
    invalid_response: "解析结果无效，请重试",
    provider_failed: "模型服务暂不可用，请重试",
  };
  return (code && messages[code]) || "无法连接本地模型服务";
}
export function createRendererModelServiceClient(
  manager: () => RendererModelServiceManager | null,
): RendererModelServiceClient {
  const request = async (method: string, params: unknown) => {
    const target = manager();
    if (!target) throw new Error("local_only");
    return target.sendRequest(method, params, {
      priority: "interactive",
      timeoutMs: method === MODEL_SERVICE_TEST_METHOD ? 25_000 : 5_000,
    });
  };
  return {
    read: async () => modelServiceSettingsSchema.parse(await request(MODEL_SERVICE_GET_METHOD, {})),
    update: async (value) =>
      modelServiceSettingsSchema.parse(await request(MODEL_SERVICE_SET_METHOD, value)),
    test: async (provider) =>
      modelServiceTestResultSchema.parse(await request(MODEL_SERVICE_TEST_METHOD, { provider })),
  };
}
