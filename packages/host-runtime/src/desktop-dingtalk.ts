import type { JsonObject } from "@codexhost/protocol-core";

import { CodexAgentStore } from "./codex-agents.js";
import { DesktopProjectCatalogReader } from "./desktop-project-catalog.js";
import { createDingTalkDispatchMatcher } from "./dingtalk-dispatch-matcher.js";
import { DingTalkDispatchSettingsStore } from "./dingtalk-dispatch-settings.js";
import { DingTalkDispatchStateStore } from "./dingtalk-dispatch-state.js";
import { DingTalkDispatcher } from "./dingtalk-dispatcher.js";
import { DingTalkNativeRunner } from "./dingtalk-native-runner.js";
import type { DingTalkService } from "./dingtalk-service.js";
import { ModelServiceSettingsStore } from "./model-service-settings.js";

export type NativeDingTalkRequest = (method: string, params: JsonObject) => Promise<JsonObject>;

export interface DesktopDingTalkDispatch {
  agents: CodexAgentStore;
  settings: DingTalkDispatchSettingsStore;
  dispatcher: Pick<DingTalkDispatcher, "score" | "run" | "status">;
}

export function ownsDesktopDingTalk(environment: NodeJS.ProcessEnv): boolean {
  return process.platform === "darwin" && environment.CODEXHOST_REMOTE_SSH_MANAGED !== "1";
}

/** Creates one dispatcher and native Turn observer for the Mac Host Runtime. */
export function createDesktopDingTalkDispatch(
  environment: NodeJS.ProcessEnv,
  service: DingTalkService,
  requestNative: NativeDingTalkRequest,
) {
  const agents = new CodexAgentStore({ environment });
  const settings = new DingTalkDispatchSettingsStore({ environment });
  const runner = new DingTalkNativeRunner(requestNative);
  const diagnose = () => process.stderr.write("codexhost: DingTalk dispatch failed\n");
  const dispatcher = new DingTalkDispatcher({
    service,
    agents,
    settings,
    state: new DingTalkDispatchStateStore(),
    projects: new DesktopProjectCatalogReader({ environment }),
    readNativeProject: (projectId) => readNativeProject(requestNative, projectId),
    matcher: createDingTalkDispatchMatcher({
      settings: new ModelServiceSettingsStore({ environment }),
    }),
    startThread: (input) => runner.start(input),
    diagnose,
  });
  void dispatcher.start().catch(diagnose);
  return {
    service: { agents, settings, dispatcher } satisfies DesktopDingTalkDispatch,
    observe: (notification: Parameters<typeof runner.observe>[0]) => runner.observe(notification),
    dispose() {
      runner.dispose();
      dispatcher.dispose();
    },
  };
}

async function readNativeProject(requestNative: NativeDingTalkRequest, projectId: string) {
  const { result } = await requestNative("project/read", { projectId });
  const project =
    result && typeof result === "object" && !Array.isArray(result) ? result.project : null;
  if (
    !project ||
    typeof project !== "object" ||
    Array.isArray(project) ||
    project.id !== projectId ||
    !Array.isArray(project.roots)
  ) {
    throw new Error("工作项目已不存在，请在智能体设置里重新选择");
  }
  const roots = project.roots.flatMap((root) =>
    root && typeof root === "object" && !Array.isArray(root) && typeof root.path === "string"
      ? [root.path]
      : [],
  );
  return { id: projectId, roots };
}
