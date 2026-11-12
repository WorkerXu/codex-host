import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DelegationControlError,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
  type ThreadSendInput,
} from "../src/delegation-types.js";
import { DelegationWatchService } from "../src/delegation-watch.js";

const POLL_MS = 100;
const PEER_POLL_MS = 1_000;

function snapshot(threadId: string, status: DelegationThreadStatus): DelegationThreadSnapshot {
  return {
    threadId,
    harnessId: "grok",
    status,
    turn: { turnId: `turn-${threadId}`, status },
    progress: [],
    result: { availability: "pending" },
    nextCursor: null,
  } as DelegationThreadSnapshot;
}

function localRuntime() {
  const sent: ThreadSendInput[] = [];
  const read = vi.fn(async ({ threadId }: { threadId: string }) => snapshot(threadId, "completed"));
  const send = vi.fn(async (input: ThreadSendInput) => {
    sent.push(input);
    return {
      threadId: input.threadId,
      turnId: "notified-turn",
      harnessId: "codex" as const,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    };
  });
  return { read, send, sent };
}

describe("DelegationWatchService cross-host watches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls the peer on its own interval and notifies once with a host-qualified link", async () => {
    const local = localRuntime();
    let status: DelegationThreadStatus = "running";
    const readPeer = vi.fn(async ({ threadId }: { hostId: string; threadId: string }) =>
      snapshot(threadId, status),
    );
    const service = new DelegationWatchService(local, {
      pollIntervalMs: POLL_MS,
      peerPollIntervalMs: PEER_POLL_MS,
      readPeer,
    });
    await expect(
      service.watch({
        threadId: "child",
        notifyThreadId: "parent",
        timeoutMs: 60_000,
        hostId: "oracle-sg",
      }),
    ).resolves.toMatchObject({ state: "watching", hostId: "oracle-sg" });
    expect(readPeer).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PEER_POLL_MS - POLL_MS);
    expect(readPeer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(readPeer).toHaveBeenCalledTimes(2);

    status = "completed";
    await vi.advanceTimersByTimeAsync(PEER_POLL_MS + POLL_MS);
    expect(local.sent).toHaveLength(1);
    expect(local.sent[0]?.message).toContain(
      "thread://child?hostId=oracle-sg: completed (Turn turn-child).",
    );
    expect(local.sent[0]?.message).toContain("[codexhost thread watch]");
    expect(await service.watches()).toEqual({ watches: [] });

    await vi.advanceTimersByTimeAsync(PEER_POLL_MS * 5);
    expect(local.sent).toHaveLength(1);
  });

  it("backs off after peer read failures and resets after recovery", async () => {
    const local = localRuntime();
    let fail = false;
    const readPeer = vi.fn(async ({ threadId }: { hostId: string; threadId: string }) => {
      if (fail) throw new DelegationControlError("RUNTIME_UNREACHABLE", "peer down");
      return snapshot(threadId, "running");
    });
    const service = new DelegationWatchService(local, {
      pollIntervalMs: POLL_MS,
      peerPollIntervalMs: PEER_POLL_MS,
      peerMaxBackoffMs: 4_000,
      readPeer,
    });
    await service.watch({
      threadId: "child",
      notifyThreadId: "parent",
      timeoutMs: 60_000,
      hostId: "oracle-sg",
    });

    fail = true;
    await vi.advanceTimersByTimeAsync(PEER_POLL_MS + POLL_MS);
    expect(readPeer).toHaveBeenCalledTimes(2);
    // First failure doubles the interval to 2s.
    await vi.advanceTimersByTimeAsync(PEER_POLL_MS + POLL_MS);
    expect(readPeer).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PEER_POLL_MS);
    expect(readPeer).toHaveBeenCalledTimes(3);
    // Second failure doubles again to 4s.
    await vi.advanceTimersByTimeAsync(PEER_POLL_MS * 3);
    expect(readPeer).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(PEER_POLL_MS);
    expect(readPeer).toHaveBeenCalledTimes(4);

    fail = false;
    await vi.advanceTimersByTimeAsync(PEER_POLL_MS * 4);
    const beforeRecovery = readPeer.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PEER_POLL_MS * 2);
    expect(readPeer.mock.calls.length).toBeGreaterThan(beforeRecovery);
    expect(local.sent).toEqual([]);
  });

  it("reports timeout for a peer Thread that never stops", async () => {
    const local = localRuntime();
    const readPeer = vi.fn(async ({ threadId }: { hostId: string; threadId: string }) =>
      snapshot(threadId, "running"),
    );
    const service = new DelegationWatchService(local, {
      pollIntervalMs: POLL_MS,
      peerPollIntervalMs: PEER_POLL_MS,
      readPeer,
    });
    await service.watch({
      threadId: "child",
      notifyThreadId: "parent",
      timeoutMs: 3_000,
      hostId: "oracle-sg",
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(local.sent).toHaveLength(1);
    expect(local.sent[0]?.message).toContain("has not reached a terminal state after 3 s");
    expect(local.sent[0]?.message).toContain("thread://child?hostId=oracle-sg");
  });

  it("lists and cancels a cross-host watch without notifying", async () => {
    const local = localRuntime();
    const readPeer = vi.fn(async ({ threadId }: { hostId: string; threadId: string }) =>
      snapshot(threadId, "running"),
    );
    const service = new DelegationWatchService(local, {
      pollIntervalMs: POLL_MS,
      peerPollIntervalMs: PEER_POLL_MS,
      readPeer,
    });
    await service.watch({
      threadId: "child",
      notifyThreadId: "parent",
      timeoutMs: 60_000,
      hostId: "oracle-sg",
    });
    await expect(service.watches()).resolves.toMatchObject({
      watches: [
        {
          threadId: "child",
          notifyThreadId: "parent",
          hostId: "oracle-sg",
          state: "watching",
        },
      ],
    });
    await expect(
      service.cancelWatch({
        threadId: "child",
        notifyThreadId: "parent",
        hostId: "oracle-sg",
      }),
    ).resolves.toMatchObject({ cancelled: true, hostId: "oracle-sg" });
    await expect(service.watches()).resolves.toEqual({ watches: [] });
    await vi.advanceTimersByTimeAsync(PEER_POLL_MS * 5);
    expect(local.sent).toEqual([]);
    await expect(
      service.cancelWatch({
        threadId: "child",
        notifyThreadId: "parent",
        hostId: "oracle-sg",
      }),
    ).resolves.toMatchObject({ cancelled: false });
  });

  it("separates watches for the same Thread on different machines", async () => {
    const local = localRuntime();
    const readPeer = vi.fn(async ({ threadId }: { hostId: string; threadId: string }) =>
      snapshot(threadId, "running"),
    );
    const service = new DelegationWatchService(local, {
      pollIntervalMs: POLL_MS,
      peerPollIntervalMs: PEER_POLL_MS,
      readPeer,
    });
    await service.watch({
      threadId: "child",
      notifyThreadId: "parent",
      timeoutMs: 60_000,
      hostId: "oracle-sg",
    });
    await service.watch({
      threadId: "child",
      notifyThreadId: "parent",
      timeoutMs: 60_000,
      hostId: "colab",
    });
    await expect(service.watches()).resolves.toMatchObject({
      watches: [{ hostId: "oracle-sg" }, { hostId: "colab" }],
    });
  });

  it("fails registration clearly when the peer is unreachable", async () => {
    const local = localRuntime();
    const service = new DelegationWatchService(local, {
      pollIntervalMs: POLL_MS,
      peerPollIntervalMs: PEER_POLL_MS,
      readPeer: async () => {
        throw new DelegationControlError("RUNTIME_UNREACHABLE", "peer down");
      },
    });
    await expect(
      service.watch({
        threadId: "child",
        notifyThreadId: "parent",
        timeoutMs: 60_000,
        hostId: "oracle-sg",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE", message: "peer down" });
    await expect(service.watches()).resolves.toEqual({ watches: [] });
  });
});
