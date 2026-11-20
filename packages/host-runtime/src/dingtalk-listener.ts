import type { DingTalkCli, DingTalkEventStream, DwsEventRecord } from "./dingtalk-cli.js";

const IDLE_STOP_MS = 5 * 60_000;
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

export interface DingTalkEventListenerOptions {
  cli: Pick<DingTalkCli, "authStatus" | "openEvents">;
  /** Whether a local or SSH-backed dws stream is available. */
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
  #hold = false;
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
    this.#idleTimer = setTimeout(() => {
      if (!this.#hold) this.stop();
    }, IDLE_STOP_MS);
    this.#idleTimer.unref?.();
    if (!this.#stream && !this.#starting) void this.#start();
  }

  /** A dispatcher keeps the stream alive even when no page is reading. */
  setHold(value: boolean): void {
    this.#hold = value;
    if (value) {
      this.touch();
      return;
    }
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
    this.#idleTimer.unref?.();
  }

  async #start(): Promise<void> {
    if (this.#disposed || this.#stream || this.#starting) return;
    if (!this.#options.local()) return;
    this.#starting = true;
    try {
      if (!(await this.#options.authenticate())) {
        this.#onExit();
        return;
      }
      if (this.#disposed) return;
      let exited = false;
      const stream = await this.#options.cli.openEvents({
        onRecord: (record) => {
          if (this.#disposed) return;
          this.#lastActivity = this.#now();
          this.#options.onRecord(record);
        },
        onExit: () => {
          exited = true;
          this.#onExit();
        },
      });
      if (!stream || this.#disposed || !this.#wanted || exited) {
        stream?.stop();
        if (!this.#disposed && !exited) this.#onExit();
        return;
      }
      this.#stream = stream;
      if (this.#restartTimer) clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
      this.#attempt = 0;
    } catch {
      this.#onExit();
    } finally {
      this.#starting = false;
    }
  }

  #onExit(): void {
    this.#stream = null;
    if (this.#restartTimer) return;
    if (this.#disposed || !this.#wanted) return;
    if (this.#now() - this.#lastActivity >= IDLE_STOP_MS && !this.#hold) {
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
