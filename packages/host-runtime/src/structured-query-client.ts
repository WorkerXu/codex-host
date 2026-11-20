export const GEMINI_QUERY_MODEL = "gemini-3.5-flash-lite";
export const STRUCTURED_QUERY_TIMEOUT_MS = 20_000;
export class StructuredQueryError extends Error {
  readonly provider = "gemini";
  constructor(readonly code: string) {
    super(code);
    this.name = "StructuredQueryError";
  }
}

export interface StructuredQueryClientOptions {
  readApiKey(): Promise<string | null>;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number;
}
export interface StructuredQueryRequest {
  instructions: string;
  input: unknown;
  schema: Record<string, unknown>;
  thinkingLevel?: "minimal" | "low";
}
export function createStructuredQueryClient(options: StructuredQueryClientOptions) {
  return {
    async query<T>(
      request: StructuredQueryRequest,
      validator: { parse(value: unknown): T },
      signal?: AbortSignal,
    ): Promise<T> {
      const fail = (code: string) => new StructuredQueryError(code);
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
        controller.signal.throwIfAborted();
        const key = await options.readApiKey();
        if (!key) throw fail("missing_key");
        controller.signal.throwIfAborted();
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_QUERY_MODEL}:generateContent`;
        const body = {
          systemInstruction: { parts: [{ text: request.instructions }] },
          contents: [{ role: "user", parts: [{ text: JSON.stringify(request.input) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: request.schema,
            temperature: 0,
            maxOutputTokens: 2_048,
            ...(request.thinkingLevel
              ? { thinkingConfig: { thinkingLevel: request.thinkingLevel } }
              : {}),
          },
        };
        const response = await (options.fetchImpl ?? fetch)(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw fail(
            response.status === 402 || response.status === 429
              ? "quota_exhausted"
              : response.status === 401 || response.status === 403
                ? "unauthorized"
                : "provider_failed",
          );
        }
        try {
          const value = (await response.json()) as {
            candidates?: {
              finishReason?: string;
              content?: { parts?: { thought?: boolean; text?: string }[] };
            }[];
          } | null;
          const candidate = value?.candidates?.[0];
          if (candidate?.finishReason !== "STOP" || !Array.isArray(candidate.content?.parts))
            throw fail("invalid_response");
          const text = candidate.content.parts
            .filter((part) => part.thought !== true && typeof part.text === "string")
            .map((part) => part.text)
            .join("");
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
