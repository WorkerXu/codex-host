import { z } from "zod";

export const MODEL_SERVICE_GET_METHOD = "codexhost/model-service/get";
export const MODEL_SERVICE_SET_METHOD = "codexhost/model-service/set";
export const MODEL_SERVICE_TEST_METHOD = "codexhost/model-service/test";
export const modelProviderSchema = z.enum(["openai", "gemini"]);
export type ModelProvider = z.infer<typeof modelProviderSchema>;
const keyState = z.strictObject({
  configured: z.boolean(),
  lastFour: z.string().max(4).nullable(),
});
export const modelServiceSettingsSchema = z.strictObject({
  provider: modelProviderSchema,
  openai: keyState,
  gemini: keyState,
});
export type ModelServiceSettings = z.infer<typeof modelServiceSettingsSchema>;
export const modelServiceSetSchema = z
  .strictObject({
    provider: modelProviderSchema.optional(),
    key: z
      .strictObject({
        provider: modelProviderSchema,
        value: z.string().trim().min(8).max(512).regex(/^\S+$/u).nullable(),
      })
      .optional(),
  })
  .refine((value) => value.provider !== undefined || value.key !== undefined);
export type ModelServiceSet = z.infer<typeof modelServiceSetSchema>;
export const modelServiceTestParamsSchema = z.strictObject({ provider: modelProviderSchema });
export const modelServiceTestResultSchema = z.strictObject({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().nullable(),
  errorCode: z.string().max(64).nullable(),
});
export type ModelServiceTestResult = z.infer<typeof modelServiceTestResultSchema>;
