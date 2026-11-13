import type { DingTalkCli, DingTalkEventStream, DwsEventRecord } from "./dingtalk-cli.js";

const IDLE_STOP_MS = 5 * 60_000;
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

export interface DingTalkEventListenerOptions {
  cli: Pick<DingTalkCli, "authStatus" | "openEvents">;
  /** Only the Host that owns the dws login may open the stream. */
  local: () => boolean;
  authenticate(): Promise<boolean>;
  onRecord(record: DwsEventRecord): void;
  now?: () => number;
}

/**
 * One long-lived `dws` event stream per Host. It starts on first use, restarts
 * with backoff, and stops after five minutes without a request. The CLI cancels
 * its own subscription on SIGTERM.
 */
export class DingTalkEventListener {
  readonly #options: DingTalkEventListenerOptions;
  readonly #now: () => number;
  #stream: DingTalkEventStream | null = null;
  #starting = false;
  #attempt = 0;
  #wanted = false;
  #lastActivity = 0;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: DingTalkEventListenerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get running(): boolean {
    return this.#stream !== null;
  }

  /** Called by every read request; also releases an idle stream. */
  touch(): void {
    this.#lastActivity = this.#now();
    this.#wanted = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
    this.#idleTimer.unref?.();
    if (!this.#stream && !this.#starting) void this.#start();
  }

  async #start(): Promise<void> {
    if (this.#disposed || this.#stream || this.#starting) return;
    if (!this.#options.local()) return;
    this.#starting = true;
    try {
      if (!(await this.#options.authenticate())) return;
      if (this.#disposed) return;
      const stream = await this.#options.cli.openEvents({
        onRecord: (record) => {
          if (this.#disposed) return;
          this.#lastActivity = this.#now();
          this.#options.onRecord(record);
        },
        onExit: () => this.#onExit(),
      });
      if (!stream || this.#disposed) {
        stream?.stop();
        return;
      }
      this.#stream = stream;
      this.#attempt = 0;
    } finally {
      this.#starting = false;
    }
  }

  #onExit(): void {
    this.#stream = null;
    if (this.#disposed || !this.#wanted) return;
    if (this.#now() - this.#lastActivity >= IDLE_STOP_MS) {
      this.#wanted = false;
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 60_000;
    this.#attempt += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#start();
    }, delay);
    this.#restartTimer.unref?.();
  }

  stop(): void {
    this.#wanted = false;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const stream = this.#stream;
    this.#stream = null;
    try {
      stream?.stop();
    } catch {
      /* A dead stream must not block idle release. */
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.stop();
  }
}
