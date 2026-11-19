import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import type {
  DingTalkDispatchRun,
  DingTalkDispatchRunResult,
  DingTalkDispatchThreadInput,
} from "./dingtalk-dispatch-types.js";
import { DINGTALK_DISPATCH_ENV } from "./dingtalk-dispatch-types.js";
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Native Thread RPC and completion tracking for the local dispatch runtime. */
export class DingTalkNativeRunner {
  #closed = false;
  constructor(readonly request: (method: string, params: JsonObject) => Promise<JsonObject>) {}
  #request(method: string, params: JsonObject): Promise<JsonObject> {
    return this.request(method, params);
  }
  readonly #dingTalkTurnWaiters = new Map<
    string,
    {
      resolve(result: DingTalkDispatchRunResult): void;
      timer: ReturnType<typeof setTimeout>;
      reminder: ReturnType<typeof setInterval>;
      texts: Map<string, string>;
      turnId?: string;
      onProgress?: (text: string) => void;
    }
  >();
  async start(input: DingTalkDispatchThreadInput): Promise<DingTalkDispatchRun> {
    if (this.#closed) throw new Error("Host connection closed");
    const config: JsonObject = {
      ...(input.readOnlySummary ? await this.#dingTalkSummaryConfig(input.cwd) : {}),
      [`shell_environment_policy.set.${DINGTALK_DISPATCH_ENV}`]: "1",
    };
    if (this.#closed) throw new Error("Host connection closed");
    const started = await this.#request("thread/start", {
      cwd: input.cwd,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.projectRoots.length > 0 ? { runtimeWorkspaceRoots: [...input.projectRoots] } : {}),
      config,
      ...(input.model ? { model: input.model } : {}),
      developerInstructions: input.developerInstructions,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      historyMode: "paginated",
    });
    const startedResult = isRecord(started.result) ? started.result : null;
    const thread = startedResult && isRecord(startedResult.thread) ? startedResult.thread : null;
    const threadId = thread && typeof thread.id === "string" ? thread.id : null;
    if (!threadId) throw new Error("Official thread/start returned no Thread identity");
    await this.#request("thread/name/set", { threadId, name: input.title }).catch(() => undefined);
    const completion = this.#watchDingTalkTurn(threadId, input.onProgress);
    let turnId: string;
    try {
      const turn = await this.#request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        sandboxPolicy: { type: "readOnly", networkAccess: !input.readOnlySummary },
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
      });
      const turnResult = isRecord(turn.result) ? turn.result : null;
      const turnValue = turnResult && isRecord(turnResult.turn) ? turnResult.turn : null;
      turnId = turnValue && typeof turnValue.id === "string" ? turnValue.id : "";
      if (!turnId) throw new Error("Official turn/start returned no Turn identity");
      const waiter = this.#dingTalkTurnWaiters.get(threadId);
      if (waiter) waiter.turnId = turnId;
    } catch (error) {
      this.#cancelDingTalkTurn(threadId);
      throw error;
    }
    return { threadId, turnId, completed: completion };
  }

  async #dingTalkSummaryConfig(cwd: string): Promise<JsonObject> {
    // Disabling shell alone leaves MCP/App write tools available. Fail closed if
    // the native config cannot be inspected to disable each configured server.
    const response = await this.#request("config/read", { includeLayers: false, cwd });
    if (!isRecord(response.result) || !isRecord(response.result.config))
      throw new Error("Cannot restrict tools for an approval summary");
    const config = response.result.config;
    const overrides: JsonObject = {
      "features.shell_tool": false,
      "features.unified_exec": false,
      "features.apply_patch_freeform": false,
      "features.apps": false,
      "features.multi_agent": false,
      "features.multi_agent_v2": false,
      "features.plugins": false,
      "features.remote_plugin": false,
      "features.hooks": false,
      "features.codex_hooks": false,
      "features.plugin_hooks": false,
      "features.agent_message_board_mcp": false,
      "features.js_repl": false,
      "features.code_mode": false,
      "features.browser_use": false,
      "features.computer_use": false,
      web_search: "disabled",
    };
    if (isRecord(config.mcp_servers))
      for (const name of Object.keys(config.mcp_servers))
        overrides[
          `mcp_servers.${/^[a-zA-Z0-9_-]+$/u.test(name) ? name : JSON.stringify(name)}.enabled`
        ] = false;
    return overrides;
  }

  #watchDingTalkTurn(
    threadId: string,
    onProgress?: (text: string) => void,
  ): Promise<DingTalkDispatchRunResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        this.#dingTalkTurnWaiters.get(threadId)?.resolve({
          answer: "",
          status: "failed",
          errorMessage: "处理时间过长，已停止",
        });
      }, 60 * 60_000);
      const reminder = setInterval(() => {
        const minutes = Math.floor((Date.now() - startedAt) / 60_000);
        onProgress?.(`仍在处理，已用时 ${minutes} 分钟`);
      }, 10 * 60_000);
      reminder.unref?.();
      timer.unref?.();
      this.#dingTalkTurnWaiters.set(threadId, {
        resolve: (result) => {
          clearTimeout(timer);
          clearInterval(reminder);
          this.#dingTalkTurnWaiters.delete(threadId);
          resolve(result);
        },
        timer,
        reminder,
        texts: new Map(),
        ...(onProgress ? { onProgress } : {}),
      });
    });
  }

  #cancelDingTalkTurn(threadId: string): void {
    const waiter = this.#dingTalkTurnWaiters.get(threadId);
    if (!waiter) return;
    waiter.resolve({ answer: "", status: "interrupted", errorMessage: "Host connection closed" });
  }

  observe(value: JsonValue): void {
    if (!isRecord(value) || !isRecord(value.params)) return;
    const params = value.params;
    if (typeof params.threadId !== "string") return;
    const waiter = this.#dingTalkTurnWaiters.get(params.threadId);
    if (!waiter) return;
    const turnId = isRecord(params.turn) ? params.turn.id : params.turnId;
    if (waiter.turnId && typeof turnId === "string" && turnId !== waiter.turnId) return;
    if (value.method === "item/completed" && isRecord(params.item)) {
      const item = params.item;
      if (
        item.type === "agentMessage" &&
        item.phase === "commentary" &&
        typeof item.text === "string"
      ) {
        waiter.onProgress?.(item.text);
      }
      if (item.type === "agentMessage" && item.phase !== "commentary") {
        const id = typeof item.id === "string" ? item.id : String(waiter.texts.size);
        if (typeof item.text === "string") waiter.texts.set(id, item.text);
      }
      return;
    }
    if (value.method === "turn/plan/updated" && Array.isArray(params.plan)) {
      const current = params.plan.find((step) => isRecord(step) && step.status === "in_progress");
      if (isRecord(current) && typeof current.step === "string") waiter.onProgress?.(current.step);
      return;
    }
    if (value.method !== "turn/completed") return;
    const turn = isRecord(params.turn) ? params.turn : {};
    const items = Array.isArray(turn.items) ? turn.items : [];
    const finalTexts = items
      .filter((item): item is JsonObject => isRecord(item))
      .filter(
        (item) =>
          item.type === "agentMessage" &&
          item.phase !== "commentary" &&
          typeof item.text === "string",
      )
      .map((item) => String(item.text))
      .filter((text) => text.trim().length > 0);
    const answer =
      finalTexts.length > 0 ? finalTexts.join("\n\n") : [...waiter.texts.values()].join("\n\n");
    const status =
      turn.status === "failed"
        ? "failed"
        : turn.status === "interrupted" || turn.status === "cancelled"
          ? "interrupted"
          : "completed";
    const error =
      isRecord(turn.error) && typeof turn.error.message === "string" ? turn.error.message : null;
    waiter.resolve({
      answer,
      status,
      errorMessage: error,
    });
  }

  dispose(): void {
    this.#closed = true;
    for (const id of this.#dingTalkTurnWaiters.keys()) this.#cancelDingTalkTurn(id);
  }
}
