import type { DingTalkDispatchMatcher } from "./dingtalk-dispatcher.js";
import { createJarvisDecisions, JarvisDecisionError } from "./jarvis-decisions.js";
import type { ModelServiceSettingsStore } from "./model-service-settings.js";

/** DingTalk always uses Gemini Decisions; General settings supply only its Gemini key. */
export function createDingTalkDispatchMatcher(options: {
  settings: ModelServiceSettingsStore;
  fetchImpl?: typeof fetch;
}): DingTalkDispatchMatcher {
  const decisions = createJarvisDecisions({
    readApiKey: () => options.settings.readKey("gemini"),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return {
    async scoreDingTalkCandidates(text, candidates) {
      try {
        return {
          available: true,
          ...(await decisions.scoreCandidates(text, candidates)),
          errorCode: null,
        };
      } catch (error) {
        return {
          available: false,
          scores: {},
          errorCode: error instanceof JarvisDecisionError ? error.code : "failed",
        };
      }
    },
  };
}
