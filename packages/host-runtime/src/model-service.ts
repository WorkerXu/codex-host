import {
  MODEL_SERVICE_GET_METHOD,
  MODEL_SERVICE_SET_METHOD,
  MODEL_SERVICE_TEST_METHOD,
  modelServiceSetSchema,
  modelServiceTestParamsSchema,
} from "@codexhost/shared-contracts";
import { ModelServiceSettingsStore } from "./model-service-settings.js";
import { createJarvisDecisions } from "./jarvis-decisions.js";

/** Registered only on the Desktop-local Host. Credentials stay inside this service. */
export class ModelService {
  constructor(
    readonly settings = new ModelServiceSettingsStore(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}
  async request(method: string, params: unknown): Promise<unknown> {
    if (method === MODEL_SERVICE_GET_METHOD) return this.settings.read();
    if (method === MODEL_SERVICE_SET_METHOD)
      return this.settings.update(modelServiceSetSchema.parse(params));
    if (method !== MODEL_SERVICE_TEST_METHOD) throw new Error("unknown_method");
    modelServiceTestParamsSchema.parse(params);
    const result = await createJarvisDecisions({
      readApiKey: () => this.settings.readKey("gemini"),
      fetchImpl: this.fetchImpl,
      now: this.now,
    }).test();
    const errorCode =
      result.errorCode === "http_402"
        ? "quota_exhausted"
        : result.errorCode === "http_429"
          ? "rate_limited"
          : result.errorCode?.startsWith("http_")
            ? "provider_failed"
            : result.errorCode;
    return { ...result, errorCode };
  }
}
