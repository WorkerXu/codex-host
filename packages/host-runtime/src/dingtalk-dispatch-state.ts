import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  dingtalkDispatchStatusSchema,
  type DingTalkDispatchAgentStatus,
  type DingTalkDispatchStatus,
} from "@codexhost/shared-contracts";
import { z } from "zod";

export const DINGTALK_DISPATCH_STATE_FILE = "dingtalk-dispatch-state.json";
const MAX_PROCESSED = 4_000;
const MAX_STATE_BYTES = 1024 * 1024;

const stateSchema = z
  .object({
    processed: z.record(z.string(), z.number()).default({}),
    status: dingtalkDispatchStatusSchema.default({}),
    listeningSince: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();

export type DingTalkDispatchState = z.infer<typeof stateSchema>;

function defaultDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(environment.HOME?.trim() || os.homedir(), ".codexhost");
}

/** Durable processed-message ids and per-agent last dispatch result. */
export class DingTalkDispatchStateStore {
  readonly #directory: string;
  #state: DingTalkDispatchState = { processed: {}, status: {}, listeningSince: null };
  #loading: Promise<DingTalkDispatchState> | null = null;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { homeDirectory?: string; environment?: NodeJS.ProcessEnv } = {}) {
    this.#directory = options.homeDirectory ?? defaultDirectory(options.environment ?? process.env);
  }

  get filePath(): string {
    return path.join(this.#directory, DINGTALK_DISPATCH_STATE_FILE);
  }

  async read(): Promise<DingTalkDispatchState> {
    return (this.#loading ??= this.#load());
  }

  async #load(): Promise<DingTalkDispatchState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      if (raw.length > MAX_STATE_BYTES) return this.#state;
      const parsed = stateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) this.#state = parsed.data;
    } catch {
      /* A missing or corrupt state starts clean. */
    }
    return this.#state;
  }

  async isProcessed(messageId: string): Promise<boolean> {
    const state = await this.read();
    return state.processed[messageId] !== undefined;
  }

  async markProcessed(messageId: string, at = Date.now()): Promise<void> {
    const state = await this.read();
    state.processed[messageId] = at;
    const entries = Object.entries(state.processed).sort((left, right) => right[1] - left[1]);
    if (entries.length > MAX_PROCESSED) {
      state.processed = Object.fromEntries(entries.slice(0, MAX_PROCESSED));
    }
    await this.#flush();
  }

  async listeningSince(): Promise<number | null> {
    return (await this.read()).listeningSince;
  }

  async setListeningSince(value: number | null): Promise<void> {
    const state = await this.read();
    if (state.listeningSince === value) return;
    state.listeningSince = value;
    await this.#flush();
  }

  async status(): Promise<DingTalkDispatchStatus> {
    return (await this.read()).status;
  }

  async setStatus(fileName: string, value: DingTalkDispatchAgentStatus): Promise<void> {
    const state = await this.read();
    state.status[fileName] = value;
    state.status = Object.fromEntries(
      Object.entries(state.status)
        .sort((a, b) => b[1].lastDispatchAt - a[1].lastDispatchAt)
        .slice(0, 64),
    );
    await this.#flush();
  }

  async #flush(): Promise<void> {
    const state = this.#state;
    this.#writeQueue = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        await chmod(this.#directory, 0o700).catch(() => undefined);
        const temporary = path.join(
          this.#directory,
          `.${DINGTALK_DISPATCH_STATE_FILE}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
        );
        try {
          await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
          await rename(temporary, this.filePath);
          await chmod(this.filePath, 0o600).catch(() => undefined);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      });
    await this.#writeQueue;
  }
}
