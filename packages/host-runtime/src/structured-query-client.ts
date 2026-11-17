import type { ModelProvider } from "@codexhost/shared-contracts";
export const MODEL_SERVICE_MODELS = {
  openai: "gpt-4.1-mini",
  gemini: "gemini-3.5-flash-lite",
} as const;
export const STRUCTURED_QUERY_TIMEOUT_MS = 3_000;
export class StructuredQueryError extends Error {
  constructor(
    readonly code: string,
    readonly provider: ModelProvider = "openai",
  ) {
    super(code);
    this.name = "StructuredQueryError";
  }
}
/** Convert Gemini-style nullable schemas to strict JSON Schema for Chat Completions. */
export function strictJsonSchema(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "nullable") continue;
    if (key === "type" && typeof entry === "string") result.type = entry.toLowerCase();
    else if (key === "properties")
      result.properties = Object.fromEntries(
        Object.entries(entry as Record<string, Record<string, unknown>>).map(([name, child]) => [
          name,
          strictJsonSchema(child),
        ]),
      );
    else if (key === "items") result.items = strictJsonSchema(entry as Record<string, unknown>);
    else result[key] = entry;
  }
  if (result.type === "object") {
    result.additionalProperties = false;
    result.required = Object.keys(result.properties as object);
  }
  if (value.nullable === true) result.type = [result.type, "null"];
  return result;
}
export interface StructuredQueryClientOptions {
  provider: ModelProvider | (() => Promise<ModelProvider>);
  readApiKey(provider: ModelProvider): Promise<string | null>;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number;
}
export interface StructuredQueryRequest {
  instructions: string;
  input: unknown;
  schema: Record<string, unknown>;
  name: string;
}
function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "additionalProperties") continue;
    if (key === "type") {
      const types = Array.isArray(entry) ? entry : [entry];
      result.type = String(types.find((type) => type !== "null")).toUpperCase();
      if (types.includes("null")) result.nullable = true;
    } else result[key] = geminiSchema(entry);
  }
  return result;
}
export function createStructuredQueryClient(options: StructuredQueryClientOptions) {
  return {
    async query<T>(
      request: StructuredQueryRequest,
      validator: { parse(value: unknown): T },
      signal?: AbortSignal,
    ): Promise<T> {
      let provider: ModelProvider =
        typeof options.provider === "string" ? options.provider : "openai";
      const fail = (code: string) => new StructuredQueryError(code, provider);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const cancelled = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(fail(signal?.aborted ? "cancelled" : "timeout")),
          { once: true },
        );
        if (controller.signal.aborted) reject(fail("cancelled"));
      });
      const timer = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? STRUCTURED_QUERY_TIMEOUT_MS,
      );
      const run = async () => {
        provider =
          typeof options.provider === "function" ? await options.provider() : options.provider;
        controller.signal.throwIfAborted();
        const key = await options.readApiKey(provider);
        if (!key) throw fail("missing_key");
        controller.signal.throwIfAborted();
        const openai = provider === "openai";
        const endpoint = openai
          ? "https://api.openai.com/v1/chat/completions"
          : `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_SERVICE_MODELS.gemini}:generateContent`;
        const body = openai
          ? {
              model: MODEL_SERVICE_MODELS.openai,
              messages: [
                { role: "system", content: request.instructions },
                { role: "user", content: JSON.stringify(request.input) },
              ],
              response_format: {
                type: "json_schema",
                json_schema: { name: request.name, strict: true, schema: request.schema },
              },
              temperature: 0,
              max_tokens: 2_048,
            }
          : {
              systemInstruction: { parts: [{ text: request.instructions }] },
              contents: [{ role: "user", parts: [{ text: JSON.stringify(request.input) }] }],
              generationConfig: {
                responseMimeType: "application/json",
                responseSchema: geminiSchema(request.schema),
                temperature: 0,
                maxOutputTokens: 2_048,
              },
            };
        const response = await (options.fetchImpl ?? fetch)(endpoint, {
          method: "POST",
          headers: openai
            ? { "content-type": "application/json", authorization: `Bearer ${key}` }
            : { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          let quota = response.status === 402;
          if (response.status === 429) {
            const detail = (await response.json().catch(() => null)) as {
              error?: { code?: string; type?: string; message?: string };
            } | null;
            quota = /quota|credit|billing|prepayment/iu.test(
              `${detail?.error?.code ?? ""} ${detail?.error?.type ?? ""} ${detail?.error?.message ?? ""}`,
            );
          }
          throw fail(
            quota
              ? "quota_exhausted"
              : [401, 403].includes(response.status)
                ? "unauthorized"
                : response.status === 429
                  ? "rate_limited"
                  : "provider_failed",
          );
        }
        try {
          const value = (await response.json()) as {
            choices?: {
              finish_reason?: string;
              message?: { refusal?: unknown; content?: unknown };
            }[];
            candidates?: {
              finishReason?: string;
              content?: { parts?: { thought?: boolean; text?: string }[] };
            }[];
          } | null;
          let text: string;
          if (openai) {
            const choice = value?.choices?.[0];
            if (
              choice?.finish_reason !== "stop" ||
              choice?.message?.refusal ||
              typeof choice?.message?.content !== "string"
            )
              throw fail("invalid_response");
            text = choice.message.content;
          } else {
            const candidate = value?.candidates?.[0];
            if (candidate?.finishReason !== "STOP" || !Array.isArray(candidate.content?.parts))
              throw fail("invalid_response");
            text = candidate.content.parts
              .filter(
                (part: { thought?: boolean; text?: string }) =>
                  part.thought !== true && typeof part.text === "string",
              )
              .map((part) => part.text)
              .join("");
          }
          return validator.parse(JSON.parse(text));
        } catch {
          throw fail("invalid_response");
        }
      };
      try {
        return await Promise.race([run(), cancelled]);
      } catch (error) {
        if (signal?.aborted) throw fail("cancelled");
        throw error instanceof StructuredQueryError ? error : fail("network");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
