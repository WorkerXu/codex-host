import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HarnessAdapter,
  HarnessSession,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  encodeExternalTransportSelection,
  transportModelIdForHarness,
  type ExternalHarnessId,
  type JsonObject,
  type JsonValue,
} from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  type ThreadAgentSwitchParams,
} from "@codexhost/shared-contracts";

import { DELEGATION_THREAD_ID_ENV } from "./delegation-types.js";
import {
  createExternalThreadRecordInput,
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";
import { externalTurnInputText } from "./external-turn-input.js";
import {
  CLAUDE_HANDOFF_DIRECTORY,
  claudeSessionJsonl,
  handoffBlock,
  handoffMessagesFromTurns,
  handoffSnapshotTurns,
  type HandoffMessage,
  type ThreadHandoffStore,
} from "./thread-agent-switch.js";

const IMPORT_TIMEOUT_MS = 60_000;
const NATIVE_REF_TIMEOUT_MS = 10_000;

/** A switch failure with a JSON-RPC code and a message the person can read. */
export class ThreadAgentSwitchError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ThreadAgentSwitchError";
  }
}

/** The conversation being moved, as read by the Host that owns it. */
export interface ThreadAgentSwitchSource {
  threadId: string;
  /** `codex` or the external Harness that owns the Thread. */
  agent: string;
  title: string;
  cwd: string;
  projectId: string | null;
  /** Desktop-protocol Turns, earlier handed-over history included. */
  turns: readonly JsonValue[];
}

export interface ThreadAgentSwitcherOptions {
  adapters: ReadonlyMap<ExternalHarnessId, HarnessAdapter>;
  repository: ExternalThreadRepository;
  externalRuntime: ExternalThreadRuntime;
  handoffs: ThreadHandoffStore;
  environment: NodeJS.ProcessEnv;
  agentLabel(agent: string): string;
  /** Reads an idle source Thread; throws {@link ThreadAgentSwitchError} otherwise. */
  readSource(threadId: string): Promise<ThreadAgentSwitchSource>;
  requestOfficial(method: string, params: JsonObject): Promise<JsonObject>;
  registerExternalThread(input: {
    record: StoredThreadRecordV1;
    session: HarnessSession;
    sessionId: string;
    thread: JsonObject;
    turns: JsonObject[];
    restoredState?: HarnessSessionState;
  }): ExternalThread;
  /** Starts a Turn showing `text`; the Harness receives `harnessPrefix` before it. */
  startExternalTurn(
    thread: ExternalThread,
    text: string,
    turnId: string,
    harnessPrefix: string,
  ): Promise<void>;
  notifyExternalThreadStarted(thread: JsonObject): Promise<void>;
  /** Writes a notification to Desktop on this Host's connection. */
  notifyDesktop(message: JsonObject): Promise<void>;
  archiveSource(source: ThreadAgentSwitchSource): Promise<void>;
  diagnose(error: unknown): void;
  importTimeoutMs?: number;
}

interface ImportWaiter {
  paths: ReadonlySet<string>;
  importId: string | null;
  resolve(threadId: string): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Codex reads external sessions from `$HOME/.claude`, whatever Claude Code's own config dir is. */
function claudeHome(environment: NodeJS.ProcessEnv): string {
  return path.join(environment.HOME ?? environment.USERPROFILE ?? os.homedir(), ".claude");
}

function sessionResults(params: JsonValue | undefined): {
  importId: string | null;
  successes: JsonObject[];
  failures: JsonObject[];
} {
  const record = isRecord(params) ? params : {};
  const results = Array.isArray(record.itemTypeResults) ? record.itemTypeResults : [];
  const sessions = results.filter(
    (result): result is JsonObject => isRecord(result) && result.itemType === "SESSIONS",
  );
  const list = (key: "successes" | "failures") =>
    sessions.flatMap((result) => (Array.isArray(result[key]) ? result[key].filter(isRecord) : []));
  return {
    importId: typeof record.importId === "string" ? record.importId : null,
    successes: list("successes"),
    failures: list("failures"),
  };
}

/** Moves a conversation to another Agent on this Host and archives the source. */
export class ThreadAgentSwitcher {
  readonly #options: ThreadAgentSwitcherOptions;
  readonly #imports = new Set<ImportWaiter>();

  constructor(options: ThreadAgentSwitcherOptions) {
    this.#options = options;
  }

  async switch(params: ThreadAgentSwitchParams): Promise<{ threadId: string }> {
    const source = await this.#options.readSource(params.threadId);
    if (params.agent === source.agent) {
      throw new ThreadAgentSwitchError(-32602, "这段对话已经在使用这个 Agent");
    }
    const messages = handoffMessagesFromTurns(source.turns);
    if (messages.length === 0) {
      throw new ThreadAgentSwitchError(-32602, "这段对话还没有可以带过去的内容");
    }
    const threadId =
      params.agent === "codex"
        ? await this.#toCodex(source, messages, params)
        : await this.#toExternal(source, messages, params);
    // The conversation already continues in the new Thread; a source that
    // could not be archived stays visible rather than failing the switch.
    await this.#options
      .archiveSource(source)
      .catch((error: unknown) => this.#options.diagnose(error));
    return { threadId };
  }

  /** Settles a pending import from Codex's progress and completion notifications. */
  observe(message: JsonValue): void {
    if (this.#imports.size === 0 || !isRecord(message)) return;
    const method = message.method;
    if (
      method !== "externalAgentConfig/import/progress" &&
      method !== "externalAgentConfig/import/completed"
    ) {
      return;
    }
    const { importId, successes, failures } = sessionResults(message.params);
    for (const waiter of this.#imports) {
      if (waiter.importId !== null && importId !== null && waiter.importId !== importId) continue;
      const success = successes.find(
        (entry) => typeof entry.source === "string" && waiter.paths.has(entry.source),
      );
      if (success && typeof success.target === "string" && success.target) {
        waiter.resolve(success.target);
        continue;
      }
      const failure = failures.find(
        (entry) => typeof entry.source === "string" && waiter.paths.has(entry.source),
      );
      if (failure) {
        waiter.reject(
          new ThreadAgentSwitchError(-32076, "Codex 没能导入这段对话的历史，请稍后重试"),
        );
      } else if (
        method === "externalAgentConfig/import/completed" &&
        waiter.importId !== null &&
        importId === waiter.importId
      ) {
        waiter.reject(new ThreadAgentSwitchError(-32076, "Codex 导入结束，但没有生成新对话"));
      }
    }
  }

  async #toCodex(
    source: ThreadAgentSwitchSource,
    messages: readonly HandoffMessage[],
    params: ThreadAgentSwitchParams,
  ): Promise<string> {
    if (params.input) {
      throw new ThreadAgentSwitchError(-32602, "切换到 Codex 时不带消息，切换后再发送");
    }
    const sessionId = randomUUID();
    const directory = path.join(
      claudeHome(this.#options.environment),
      "projects",
      CLAUDE_HANDOFF_DIRECTORY,
    );
    const file = path.join(directory, `${sessionId}.jsonl`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      file,
      claudeSessionJsonl({
        sessionId,
        cwd: source.cwd,
        title: source.title,
        messages,
        nowMs: Date.now(),
      }),
      { mode: 0o600 },
    );
    try {
      const paths = new Set([file, await realpath(file).catch(() => file)]);
      const threadId = await this.#importSession(file, paths, source);
      if (source.projectId) {
        await this.#options
          .requestOfficial("thread/metadata/update", { threadId, projectId: source.projectId })
          .catch((error: unknown) => this.#options.diagnose(error));
      }
      const read = await this.#options
        .requestOfficial("thread/read", { threadId, includeTurns: false })
        .catch(() => null);
      const thread = read && isRecord(read.result) ? read.result.thread : null;
      if (isRecord(thread)) {
        // Codex's import announces no new Thread; Desktop learns of it here.
        await this.#options.notifyDesktop({
          method: "thread/started",
          emittedAtMs: Date.now(),
          params: { thread: { ...thread, turns: [] } },
        });
      }
      return threadId;
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  async #importSession(
    file: string,
    paths: ReadonlySet<string>,
    source: ThreadAgentSwitchSource,
  ): Promise<string> {
    let waiter: ImportWaiter | undefined;
    const imported = new Promise<string>((resolve, reject) => {
      waiter = { paths, importId: null, resolve, reject };
    });
    const pending = waiter as ImportWaiter;
    this.#imports.add(pending);
    const timeout = setTimeout(
      () => pending.reject(new ThreadAgentSwitchError(-32076, "Codex 导入超时，请稍后重试")),
      this.#options.importTimeoutMs ?? IMPORT_TIMEOUT_MS,
    );
    try {
      const response = await this.#options.requestOfficial("externalAgentConfig/import", {
        migrationItems: [
          {
            itemType: "SESSIONS",
            description: "codexhost agent switch",
            cwd: null,
            details: {
              sessions: [{ path: file, cwd: source.cwd, title: source.title || null }],
            },
          },
        ],
      });
      if (isRecord(response.error)) {
        throw new ThreadAgentSwitchError(-32076, "Codex 拒绝了这次导入，请确认 Codex 已登录");
      }
      const result = isRecord(response.result) ? response.result : {};
      if (typeof result.importId === "string") pending.importId = result.importId;
      return await imported;
    } finally {
      clearTimeout(timeout);
      this.#imports.delete(pending);
    }
  }

  async #toExternal(
    source: ThreadAgentSwitchSource,
    messages: readonly HandoffMessage[],
    params: ThreadAgentSwitchParams,
  ): Promise<string> {
    const harnessId = params.agent as ExternalHarnessId;
    const adapter = this.#options.adapters.get(harnessId);
    const label = this.#options.agentLabel(params.agent);
    if (!adapter) throw new ThreadAgentSwitchError(-32070, `这台机器上没有可用的 ${label}`);
    if (!params.input) {
      throw new ThreadAgentSwitchError(-32602, `切换到 ${label} 需要一条消息`);
    }
    let request: string;
    try {
      request = externalTurnInputText(params.input);
    } catch {
      throw new ThreadAgentSwitchError(-32602, "这条消息的内容无法交给新的 Agent");
    }
    const prefix = `${handoffBlock({
      fromAgent: source.agent,
      fromLabel: this.#options.agentLabel(source.agent),
      threadId: source.threadId,
      messages,
    })}\n\n`;
    const hostThreadId = hostThreadIdSchema.parse(randomUUID());
    const turnId = hostTurnIdSchema.parse(randomUUID());
    const { repository, externalRuntime, handoffs } = this.#options;
    let record = await repository.createProvisional(
      createExternalThreadRecordInput({
        hostThreadId,
        harnessId: harnessIdSchema.parse(harnessId),
        cwd: source.cwd,
        title: source.title,
        transportModelId: transportModelIdForHarness(harnessId),
        ephemeral: false,
        historyMode: "paginated",
      }),
    );
    let session: HarnessSession | null = null;
    return externalRuntime.idleRelease.runOperation(hostThreadId, async () => {
      try {
        if (source.projectId) {
          record = await repository.updateMetadata(hostThreadId, { projectId: source.projectId });
        }
        await handoffs.save({
          formatVersion: 1,
          hostThreadId,
          sourceThreadId: source.threadId,
          sourceAgent: source.agent,
          createdAt: new Date().toISOString(),
          turns: handoffSnapshotTurns(messages, `handoff-${hostThreadId}`),
        });
        const opened = await adapter.open({
          kind: "create",
          cwd: record.cwd,
          environment: { ...this.#options.environment, [DELEGATION_THREAD_ID_ENV]: hostThreadId },
        });
        if (!opened.ok)
          throw new ThreadAgentSwitchError(-32070, `${label} 没能启动：${opened.error.message}`);
        session = opened.value;
        if (session.initialState.nativeRef) {
          record = await repository.commitNative(hostThreadId, session.initialState.nativeRef);
        }
        const thread = this.#options.registerExternalThread({
          record,
          session,
          sessionId: hostThreadId,
          thread: externalThreadValue({
            record,
            turns: [],
            sessionId: hostThreadId,
            running: true,
          }),
          turns: [],
          ...(session.initialState.nativeRef ? {} : { restoredState: session.initialState }),
        });
        const beforeRevision = thread.stateObserver.revision;
        await this.#options.startExternalTurn(thread, request, turnId, prefix);
        let revision = beforeRevision;
        const deadline = Date.now() + NATIVE_REF_TIMEOUT_MS;
        while (!thread.record.nativeSessionRef) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error(`${label} 没有返回会话标识`);
          await thread.stateObserver.waitForChange(revision, remaining);
          revision = thread.stateObserver.revision;
        }
        const state = thread.stateObserver.state;
        if (state.effectiveModel && state.effectivePermissionModeId) {
          const transportModelId = encodeExternalTransportSelection(harnessId, {
            model: state.effectiveModel,
            permissionModeId: state.effectivePermissionModeId,
            ...(state.effectiveThinkingOptionId
              ? { thinkingOptionId: state.effectiveThinkingOptionId }
              : {}),
          });
          thread.record = await repository.setTransportModelId(hostThreadId, transportModelId);
          thread.transportModelId = transportModelId;
          thread.requestedPermissionModeId = state.effectivePermissionModeId;
          thread.thread = externalThreadValue({
            record: thread.record,
            turns: thread.turns,
            sessionId: thread.sessionId,
            running: thread.running,
          });
        }
        await this.#options.notifyExternalThreadStarted(thread.thread);
        return hostThreadId;
      } catch (error) {
        if (session) await (session as HarnessSession).close().catch(() => undefined);
        externalRuntime.remove(hostThreadId);
        await repository.removeThread(hostThreadId).catch(() => undefined);
        await handoffs.remove(hostThreadId).catch(() => undefined);
        if (error instanceof ThreadAgentSwitchError) throw error;
        throw new ThreadAgentSwitchError(
          -32076,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  }
}
