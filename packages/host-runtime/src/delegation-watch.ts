import {
  DEFAULT_WATCH_TIMEOUT_MS,
  DelegationControlError,
  type DelegationControlApi,
  type DelegationThreadSnapshot,
  type ThreadWatchCancelInput,
  type ThreadWatchCancelResult,
  type ThreadWatchEntry,
  type ThreadWatchInput,
  type ThreadWatchListResult,
  type ThreadWatchOutcome,
  type ThreadWatchResult,
} from "./delegation-types.js";

export { DEFAULT_WATCH_TIMEOUT_MS };
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_PEER_POLL_INTERVAL_MS = 5_000;
const MAX_PEER_BACKOFF_MS = 60_000;
/** How long a fired notification may wait for a busy or unreachable subscriber. */
const DELIVERY_WINDOW_MS = 6 * 60 * 60_000;
const MAX_UNDELIVERABLE_ENTRIES = 50;
/** Reads failing for this long are reported instead of waiting for the timeout. */
const UNREADABLE_GRACE_MS = 60_000;

interface Watch extends ThreadWatchEntry {
  timeoutMs: number;
  deadline: number;
  deliveryDeadline?: number;
  unreadableSince?: number;
  lastReadError?: string;
  /** Cross-host watches poll on their own interval and back off on failures. */
  pollIntervalMs?: number;
  backoffMs?: number;
  nextPollAt?: number;
}

function terminal(status: DelegationThreadSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function errorCode(error: unknown): string | undefined {
  return error instanceof DelegationControlError ? error.code : undefined;
}

/**
 * A failed send is retried only when the call chain proves no Turn started.
 * - permanent: the notified Thread is missing or read-only; retrying cannot help.
 * - rejected: THREAD_BUSY is decided before any start, and `notStarted` marks a
 *   start the target explicitly refused, so a retry cannot duplicate it.
 * - unknown: anything else. A structured error is not proof: an adapter may
 *   report a timed-out start whose native Turn was accepted, so a retry could
 *   deliver the notification twice.
 */
function deliveryFailure(error: unknown): "permanent" | "rejected" | "unknown" {
  if (!(error instanceof DelegationControlError)) return "unknown";
  if (error.code === "THREAD_NOT_FOUND" || error.details?.readOnly === true) return "permanent";
  if (error.code === "THREAD_BUSY" || error.details?.notStarted === true) return "rejected";
  return "unknown";
}

function threadLink(threadId: string, hostId?: string): string {
  return hostId
    ? `thread://${threadId}?hostId=${encodeURIComponent(hostId)}`
    : `codex://threads/${threadId}`;
}

function duration(milliseconds: number): string {
  return milliseconds < 60_000
    ? `${Math.round(milliseconds / 1_000)} s`
    : `${Math.round(milliseconds / 60_000)} min`;
}

function describe(watch: Watch): string {
  const link = threadLink(watch.threadId, watch.hostId);
  switch (watch.outcome) {
    case "timedOut":
      return `${link} has not reached a terminal state after ${duration(watch.timeoutMs)}; this watch expired. Run 'codexhost thread watch' again to keep waiting.`;
    case "unreadable":
      return `${link} could not be read for ${Math.round(UNREADABLE_GRACE_MS / 1_000)} s, so its state is unknown (${watch.lastReadError ?? "unknown error"}).`;
    case "notFound":
      return `${link} no longer exists.`;
    default:
      // The Turn tells a re-registered watch's notifications apart.
      return watch.turnId
        ? `${link}: ${watch.outcome} (Turn ${watch.turnId}).`
        : `${link}: ${watch.outcome}.`;
  }
}

function notification(watches: readonly Watch[]): string {
  return [
    "[codexhost thread watch] Watched Threads stopped or the watch expired. This reports execution state only, not that the work is correct or accepted. Inspect each Thread with 'codexhost thread read <thread>' before relying on it.",
    ...watches.map((watch) => `- ${describe(watch)}`),
  ].join("\n");
}

/**
 * One-shot notifications when a watched Thread stops, built only on the public
 * `read` and `send` operations, so it is independent of Harness, Desktop and
 * delegation lineage. State is in memory: watches do not survive a Host Runtime
 * restart.
 */
export class DelegationWatchService {
  readonly #api: Pick<DelegationControlApi, "read" | "send">;
  readonly #pollIntervalMs: number;
  readonly #peerPollIntervalMs: number;
  readonly #peerMaxBackoffMs: number;
  readonly #readPeer:
    | ((input: { hostId: string; threadId: string }) => Promise<DelegationThreadSnapshot>)
    | undefined;
  readonly #diagnose: (error: unknown) => void;
  readonly #watches: Watch[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    api: Pick<DelegationControlApi, "read" | "send">,
    options: {
      pollIntervalMs?: number;
      peerPollIntervalMs?: number;
      peerMaxBackoffMs?: number;
      readPeer?: (input: { hostId: string; threadId: string }) => Promise<DelegationThreadSnapshot>;
      diagnose?: (error: unknown) => void;
    } = {},
  ) {
    this.#api = api;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#peerPollIntervalMs = options.peerPollIntervalMs ?? DEFAULT_PEER_POLL_INTERVAL_MS;
    this.#peerMaxBackoffMs = options.peerMaxBackoffMs ?? MAX_PEER_BACKOFF_MS;
    this.#readPeer = options.readPeer;
    this.#diagnose = options.diagnose ?? (() => undefined);
  }

  async watch(input: ThreadWatchInput): Promise<ThreadWatchResult> {
    if (this.#closed) throw new DelegationControlError("INTERNAL_ERROR", "Host Runtime is closing");
    if (typeof input.threadId !== "string" || !input.threadId.trim())
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
    if (typeof input.notifyThreadId !== "string" || !input.notifyThreadId.trim())
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Notified Thread is required; pass --notify <thread>",
      );
    if (input.threadId === input.notifyThreadId)
      throw new DelegationControlError("INVALID_ARGUMENT", "A Thread cannot watch itself");
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
      throw new DelegationControlError("INVALID_ARGUMENT", "timeoutMs must be a positive integer");
    if (input.hostId !== undefined && (typeof input.hostId !== "string" || !input.hostId.trim())) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Host identifier is invalid");
    }
    if (input.hostId && !this.#readPeer) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "This Runtime does not support cross-host watches",
      );
    }

    // Both reads reject unknown Threads, so a watch is never reported for a missing end.
    const target = await this.#readTarget(input.hostId, input.threadId);
    await this.#api.read({ threadId: input.notifyThreadId, view: "result" });
    const result = {
      threadId: input.threadId,
      notifyThreadId: input.notifyThreadId,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      status: target.status,
      timeoutMs: input.timeoutMs,
    };
    if (terminal(target.status)) return { ...result, state: "alreadyTerminal" };
    const existing = this.#watches.find(
      (watch) =>
        watch.state === "watching" &&
        watch.threadId === input.threadId &&
        watch.notifyThreadId === input.notifyThreadId &&
        watch.hostId === input.hostId,
    );
    if (existing) return { ...result, state: "watching", timeoutMs: existing.timeoutMs };
    if (this.#closed) throw new DelegationControlError("INTERNAL_ERROR", "Host Runtime is closing");
    this.#watches.push({
      threadId: input.threadId,
      notifyThreadId: input.notifyThreadId,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      state: "watching",
      registeredAt: new Date().toISOString(),
      timeoutMs: input.timeoutMs,
      deadline: Date.now() + input.timeoutMs,
      ...(input.hostId
        ? {
            pollIntervalMs: this.#peerPollIntervalMs,
            backoffMs: this.#peerPollIntervalMs,
            nextPollAt: Date.now() + this.#peerPollIntervalMs,
          }
        : {}),
    });
    this.#schedule();
    return { ...result, state: "watching" };
  }

  async watches(): Promise<ThreadWatchListResult> {
    return {
      watches: this.#watches.map(
        ({ threadId, notifyThreadId, hostId, state, outcome, turnId, reason, registeredAt }) => ({
          threadId,
          notifyThreadId,
          ...(hostId ? { hostId } : {}),
          state,
          ...(outcome ? { outcome } : {}),
          ...(turnId ? { turnId } : {}),
          ...(reason ? { reason } : {}),
          registeredAt,
        }),
      ),
    };
  }

  async cancelWatch(input: ThreadWatchCancelInput): Promise<ThreadWatchCancelResult> {
    if (typeof input.threadId !== "string" || !input.threadId.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
    }
    if (typeof input.notifyThreadId !== "string" || !input.notifyThreadId.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Notified Thread is required");
    }
    const index = this.#watches.findIndex(
      (watch) =>
        watch.threadId === input.threadId &&
        watch.notifyThreadId === input.notifyThreadId &&
        watch.hostId === input.hostId,
    );
    if (index < 0) {
      return {
        threadId: input.threadId,
        notifyThreadId: input.notifyThreadId,
        ...(input.hostId ? { hostId: input.hostId } : {}),
        cancelled: false,
      };
    }
    this.#watches.splice(index, 1);
    return {
      threadId: input.threadId,
      notifyThreadId: input.notifyThreadId,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      cancelled: true,
    };
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#watches.length = 0;
  }

  #schedule(): void {
    if (this.#closed || this.#timer) return;
    if (!this.#watches.some((watch) => watch.state !== "undeliverable")) return;
    this.#timer = setTimeout(() => {
      // A background loop must never take the Host Runtime down with it.
      void this.#tick()
        .catch((error: unknown) => this.#diagnose(error))
        .finally(() => {
          this.#timer = undefined;
          this.#schedule();
        });
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    const now = Date.now();
    for (const watch of [...this.#watches]) {
      if (this.#closed) return;
      if (watch.state !== "watching") continue;
      if (watch.nextPollAt !== undefined && now < watch.nextPollAt) continue;
      const observed = await this.#observe(watch);
      if (watch.hostId) {
        watch.nextPollAt = Date.now() + (watch.backoffMs ?? this.#peerPollIntervalMs);
      }
      if (!observed) continue;
      const { outcome, turnId } = observed;
      watch.state = "pendingDelivery";
      watch.outcome = outcome;
      if (turnId) watch.turnId = turnId;
      watch.deliveryDeadline = Date.now() + DELIVERY_WINDOW_MS;
    }
    const subscribers = new Set(
      this.#watches
        .filter((watch) => watch.state === "pendingDelivery")
        .map((watch) => watch.notifyThreadId),
    );
    for (const notifyThreadId of subscribers) {
      if (this.#closed) return;
      await this.#deliver(notifyThreadId);
    }
  }

  #readTarget(hostId: string | undefined, threadId: string): Promise<DelegationThreadSnapshot> {
    if (!hostId) return this.#api.read({ threadId, view: "result" });
    if (!this.#readPeer) {
      return Promise.reject(
        new DelegationControlError(
          "INVALID_ARGUMENT",
          "This Runtime does not support cross-host watches",
        ),
      );
    }
    return this.#readPeer({ hostId, threadId });
  }

  async #observe(
    watch: Watch,
  ): Promise<{ outcome: ThreadWatchOutcome; turnId?: string } | undefined> {
    try {
      const snapshot = await this.#readTarget(watch.hostId, watch.threadId);
      if (terminal(snapshot.status)) {
        return {
          outcome: snapshot.status as ThreadWatchOutcome,
          ...(snapshot.turn ? { turnId: snapshot.turn.turnId } : {}),
        };
      }
      delete watch.unreadableSince;
      if (watch.hostId) watch.backoffMs = this.#peerPollIntervalMs;
    } catch (error) {
      if (errorCode(error) === "THREAD_NOT_FOUND") return { outcome: "notFound" };
      // Other read failures may be transient, so only a sustained failure is reported.
      watch.unreadableSince ??= Date.now();
      watch.lastReadError = error instanceof Error ? error.message : String(error);
      if (watch.hostId) {
        watch.backoffMs = Math.min(
          (watch.backoffMs ?? this.#peerPollIntervalMs) * 2,
          this.#peerMaxBackoffMs,
        );
      }
      if (Date.now() - watch.unreadableSince >= UNREADABLE_GRACE_MS)
        return { outcome: "unreadable" };
    }
    return Date.now() >= watch.deadline ? { outcome: "timedOut" } : undefined;
  }

  /** All notifications pending for one subscriber start a single Turn. */
  async #deliver(notifyThreadId: string): Promise<void> {
    const pending = this.#watches.filter(
      (watch) => watch.state === "pendingDelivery" && watch.notifyThreadId === notifyThreadId,
    );
    try {
      await this.#api.send({ threadId: notifyThreadId, message: notification(pending) });
      for (const watch of pending) this.#remove(watch);
    } catch (error) {
      const failure = deliveryFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      for (const watch of pending) {
        // A rejected send is retried and never treated as delivered.
        if (failure !== "rejected" || Date.now() >= (watch.deliveryDeadline ?? 0)) {
          watch.state = "undeliverable";
          watch.reason =
            failure === "unknown"
              ? `Delivery outcome unknown; the notification may already have started a Turn, so it is not retried (${message})`
              : message;
        }
      }
      this.#trimUndeliverable();
    }
  }

  #remove(watch: Watch): void {
    const index = this.#watches.indexOf(watch);
    if (index >= 0) this.#watches.splice(index, 1);
  }

  #trimUndeliverable(): void {
    const undeliverable = this.#watches.filter((watch) => watch.state === "undeliverable");
    for (const watch of undeliverable.slice(0, -MAX_UNDELIVERABLE_ENTRIES)) this.#remove(watch);
  }
}
