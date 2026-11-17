import {
  MODEL_SERVICE_GET_METHOD,
  MODEL_SERVICE_SET_METHOD,
  MODEL_SERVICE_TEST_METHOD,
  modelServiceSetSchema,
  modelServiceTestParamsSchema,
} from "@codexhost/shared-contracts";
import { ModelServiceSettingsStore } from "./model-service-settings.js";
import { createStructuredQueryClient, StructuredQueryError } from "./structured-query-client.js";

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
    const { provider } = modelServiceTestParamsSchema.parse(params);
    const started = this.now();
    try {
      await createStructuredQueryClient({
        provider,
        readApiKey: (p) => this.settings.readKey(p),
        fetchImpl: this.fetchImpl,
      }).query(
        {
          name: "connection_test",
          instructions: 'Return the JSON object {"ok":true}.',
          input: "test",
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
        {
          parse(value) {
            if (
              !value ||
              typeof value !== "object" ||
              !("ok" in value) ||
              value.ok !== true ||
              Object.keys(value).length !== 1
            )
              throw new Error("invalid_response");
            return value;
          },
        },
      );
      return { ok: true, latencyMs: Math.max(0, this.now() - started), errorCode: null };
    } catch (error) {
      return {
        ok: false,
        latencyMs: null,
        errorCode: error instanceof StructuredQueryError ? error.code : "network",
      };
    }
  }
}
