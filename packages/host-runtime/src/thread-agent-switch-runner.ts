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
  HANDOFF_BUDGET_BYTES,
  claudeSessionJsonl,
  handoffBlock,
  handoffBudgetBytes,
  handoffItemsFromTurns,
  handoffSnapshotTurns,
  type HandoffItem,
} from "./thread-handoff-content.js";
import type { ThreadHandoffRecord, ThreadHandoffStore } from "./thread-handoff-store.js";

/** Where Codex's import accepts a session: under the Claude home's `projects`. */
export const CLAUDE_HANDOFF_DIRECTORY = "codexhost-handoff";

const IMPORT_TIMEOUT_MS = 60_000;
/** Codex reports an import within milliseconds; after this, look for the Thread itself. */
const IMPORT_POLL_AFTER_MS = 3_000;
const IMPORT_POLL_INTERVAL_MS = 3_000;
const NATIVE_REF_TIMEOUT_MS = 10_000;
/** A repeated request this soon after a switch is a retry of it, not a new switch. */
const RETRY_WINDOW_MS = 15 * 60_000;

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
  /** Whether a Thread a previous switch created still exists. */
  threadExists(threadId: string, agent: string): Promise<boolean>;
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
  importPollAfterMs?: number;
  now?: () => number;
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

function imageCount(input: readonly JsonValue[]): number {
  return input.filter(
    (item) => isRecord(item) && (item.type === "image" || item.type === "localImage"),
  ).length;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Moves a conversation to another Agent on this Host and archives the source. */
export class ThreadAgentSwitcher {
  readonly #options: ThreadAgentSwitcherOptions;
  readonly #imports = new Set<ImportWaiter>();
  /** One switch per source at a time; a concurrent duplicate shares its outcome. */
  readonly #inFlight = new Map<string, { agent: string; result: Promise<{ threadId: string }> }>();

  constructor(options: ThreadAgentSwitcherOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  switch(params: ThreadAgentSwitchParams): Promise<{ threadId: string }> {
    const running = this.#inFlight.get(params.threadId);
    if (running) {
      if (running.agent === params.agent) return running.result;
      return Promise.reject(new ThreadAgentSwitchError(-32072, "这段对话正在切换，请稍候"));
    }
    const result = this.#switch(params).finally(() => this.#inFlight.delete(params.threadId));
    this.#inFlight.set(params.threadId, { agent: params.agent, result });
    return result;
  }

  async #switch(params: ThreadAgentSwitchParams): Promise<{ threadId: string }> {
    const previous = await this.#options.handoffs.findBySource(params.threadId).catch(() => null);
    if (
      previous &&
      previous.targetAgent === params.agent &&
      this.#now() - Date.parse(previous.createdAt) < RETRY_WINDOW_MS &&
      (await this.#options.threadExists(previous.hostThreadId, params.agent).catch(() => false))
    ) {
      // A retry after a lost reply: the conversation already moved.
      return { threadId: previous.hostThreadId };
    }
    const source = await this.#options.readSource(params.threadId);
    if (params.agent === source.agent) {
      throw new ThreadAgentSwitchError(-32602, "这段对话已经在使用这个 Agent");
    }
    const items = handoffItemsFromTurns(source.turns);
    if (!items.some((item) => item.kind === "user")) {
      throw new ThreadAgentSwitchError(-32602, "这段对话还没有可以带过去的内容");
    }
    const threadId =
      params.agent === "codex"
        ? await this.#toCodex(source, items, params)
        : await this.#toExternal(source, items, params);
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

  #record(
    source: ThreadAgentSwitchSource,
    hostThreadId: string,
    targetAgent: string,
    items: HandoffItem[],
    turns: JsonObject[],
    deliveredItemIds: string[],
  ): ThreadHandoffRecord {
    return {
      formatVersion: 2,
      hostThreadId,
      sourceThreadId: source.threadId,
      sourceAgent: source.agent,
      sourceTitle: source.title,
      targetAgent,
      createdAt: new Date(this.#now()).toISOString(),
      items,
      turns,
      deliveredItemIds,
    };
  }

  async #toCodex(
    source: ThreadAgentSwitchSource,
    items: HandoffItem[],
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
        items,
        nowMs: this.#now(),
      }),
      { mode: 0o600 },
    );
    let threadId: string;
    try {
      const paths = new Set([file, await realpath(file).catch(() => file)]);
      threadId = await this.#importSession(file, paths, source);
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
    if (source.projectId) {
      await this.#options
        .requestOfficial("thread/metadata/update", { threadId, projectId: source.projectId })
        .catch((error: unknown) => this.#options.diagnose(error));
    }
    const messageIds = items
      .filter((item) => item.kind === "user" || item.kind === "assistant")
      .map(({ id }) => id);
    const activity = handoffBlock({
      fromAgent: source.agent,
      fromLabel: this.#options.agentLabel(source.agent),
      threadId,
      sourceThreadId: source.threadId,
      items,
      budgetBytes: HANDOFF_BUDGET_BYTES,
      activityOnly: true,
    });
    await this.#options.handoffs
      .save(
        this.#record(
          source,
          threadId,
          "codex",
          items,
          [],
          [...messageIds, ...activity.deliveredItemIds],
        ),
      )
      .catch((error: unknown) => this.#options.diagnose(error));
    if (items.some((item) => item.kind !== "user" && item.kind !== "assistant")) {
      await this.#injectActivity(threadId, activity.text).catch((error: unknown) =>
        this.#options.diagnose(error),
      );
    }
    const read = await this.#options
      .requestOfficial("thread/read", { threadId, includeTurns: false })
      .catch(() => null);
    const thread = read && isRecord(read.result) ? read.result.thread : null;
    if (isRecord(thread)) {
      // Codex's import announces no new Thread; Desktop learns of it here.
      await this.#options.notifyDesktop({
        method: "thread/started",
        emittedAtMs: this.#now(),
        params: { thread: { ...thread, turns: [] } },
      });
    }
    return threadId;
  }

  /**
   * Codex shows the imported messages; the commands, file changes and errors
   * around them reach its model as context, with how to read the rest.
   */
  async #injectActivity(threadId: string, block: string): Promise<void> {
    const resumed = await this.#options.requestOfficial("thread/resume", { threadId });
    if (isRecord(resumed.error)) throw new Error("Imported Codex Thread could not be resumed");
    const injected = await this.#options.requestOfficial("thread/inject_items", {
      threadId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: block }] }],
    });
    if (isRecord(injected.error)) throw new Error("Handoff activity could not reach Codex");
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
    const startedAt = this.#now();
    let settled = false;
    const timeout = setTimeout(
      () => pending.reject(new ThreadAgentSwitchError(-32076, "Codex 导入超时，请稍后重试")),
      this.#options.importTimeoutMs ?? IMPORT_TIMEOUT_MS,
    );
    void imported.then(
      () => (settled = true),
      () => (settled = true),
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
      // A missed progress notification must not orphan the imported Thread.
      void this.#pollImported(source, startedAt, () => settled).then((threadId) => {
        if (threadId) pending.resolve(threadId);
      });
      return await imported;
    } finally {
      settled = true;
      clearTimeout(timeout);
      this.#imports.delete(pending);
    }
  }

  async #pollImported(
    source: ThreadAgentSwitchSource,
    startedAt: number,
    settled: () => boolean,
  ): Promise<string | null> {
    await delay(this.#options.importPollAfterMs ?? IMPORT_POLL_AFTER_MS);
    while (!settled()) {
      const listed = await this.#options
        .requestOfficial("thread/list", {
          limit: 20,
          sortKey: "created_at",
          sortDirection: "desc",
        })
        .catch(() => null);
      const data = listed && isRecord(listed.result) ? listed.result.data : null;
      const match = Array.isArray(data)
        ? data.find(
            (thread) =>
              isRecord(thread) &&
              typeof thread.id === "string" &&
              thread.cwd === source.cwd &&
              (!source.title || thread.name === source.title) &&
              typeof thread.createdAt === "number" &&
              thread.createdAt * 1000 >= startedAt - 5_000,
          )
        : undefined;
      if (isRecord(match) && typeof match.id === "string") return match.id;
      await delay(IMPORT_POLL_INTERVAL_MS);
    }
    return null;
  }

  async #toExternal(
    source: ThreadAgentSwitchSource,
    items: HandoffItem[],
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
    const hostThreadId = hostThreadIdSchema.parse(randomUUID());
    const turnId = hostTurnIdSchema.parse(randomUUID());
    const block = handoffBlock({
      fromAgent: source.agent,
      fromLabel: this.#options.agentLabel(source.agent),
      threadId: hostThreadId,
      sourceThreadId: source.threadId,
      items,
      budgetBytes: handoffBudgetBytes(request, imageCount(params.input)),
    });
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
        await handoffs.save(
          this.#record(
            source,
            hostThreadId,
            params.agent,
            items,
            handoffSnapshotTurns(source.turns, `handoff-${hostThreadId}`),
            block.deliveredItemIds,
          ),
        );
        const opened = await adapter.open({
          kind: "create",
          cwd: record.cwd,
          environment: { ...this.#options.environment, [DELEGATION_THREAD_ID_ENV]: hostThreadId },
        });
        if (!opened.ok) {
          throw new ThreadAgentSwitchError(-32070, `${label} 没能启动：${opened.error.message}`);
        }
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
        await this.#options.startExternalTurn(thread, request, turnId, `${block.text}\n\n`);
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
