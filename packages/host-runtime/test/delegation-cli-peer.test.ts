import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { writePeerConfig } from "../src/peer-config.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
} from "../src/delegation-types.js";
import type { PeerProcess, PeerSpawn } from "../src/peer-transport.js";

const roots: string[] = [];

async function environment(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(path.join(tmpdir(), "cx-cli-peer-"));
  roots.push(root);
  const environment = { CODEXHOST_USER_DIR: root };
  await writePeerConfig(environment, {
    formatVersion: 1,
    peers: {
      mac: { ssh: "mac", hostIds: ["remote-ssh-discovered:mac"] },
    },
    self: { hostIds: ["remote-ssh-discovered:self"] },
  });
  return environment;
}

function outputText(stream: PassThrough): string {
  return stream.read()?.toString() ?? "";
}

class FakeProcess implements PeerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #listeners = new Map<string, ((...arguments_: never[]) => void)[]>();

  kill(): boolean {
    return true;
  }

  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: string, listener: (...arguments_: never[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...arguments_: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...(arguments_ as never[]));
    }
  }
}

function peerSpawn(responses: (((input: Record<string, unknown>) => unknown) | unknown)[]): {
  spawnImpl: PeerSpawn;
  inputs: Record<string, unknown>[];
} {
  const inputs: Record<string, unknown>[] = [];
  let index = 0;
  const spawnImpl: PeerSpawn = () => {
    const child = new FakeProcess();
    let input = "";
    child.stdin.on("data", (chunk) => {
      input += chunk.toString();
    });
    child.stdin.on("end", () => {
      const envelope = JSON.parse(input) as Record<string, unknown>;
      inputs.push(envelope);
      const response = responses[index];
      index += 1;
      const value = typeof response === "function" ? response(envelope) : response;
      setImmediate(() => {
        child.stdout.write(JSON.stringify(value));
        child.emit("close", 0, null);
      });
    });
    return child;
  };
  return { spawnImpl, inputs };
}

function snapshot(): Record<string, unknown> {
  return {
    threadId: "t",
    harnessId: "pi",
    status: "completed",
    turn: null,
    progress: [],
    result: { availability: "available", text: "done" },
    nextCursor: null,
  };
}

async function run(
  arguments_: string[],
  input: {
    environment: NodeJS.ProcessEnv;
    spawnImpl?: PeerSpawn;
    fetchImpl?: typeof fetch;
  },
): Promise<{ code: number; output: string; diagnostics: string }> {
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const code = await runDelegationCli({
    arguments: arguments_,
    environment: input.environment,
    output,
    diagnosticOutput: diagnostics,
    ...(input.spawnImpl ? { spawnImpl: input.spawnImpl } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  return { code, output: outputText(output), diagnostics: outputText(diagnostics) };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("delegation CLI peer routing", () => {
  it.each([
    ["harness list", ["harness", "list", "--host", "mac"], "/v1/harness/list", {}],
    [
      "harness inspect",
      ["harness", "inspect", "pi", "--host", "mac"],
      "/v1/harness/inspect",
      { harnessId: "pi" },
    ],
  ])("routes %s to a peer", async (_name, arguments_, route, body) => {
    const env = await environment();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { spawnImpl, inputs } = peerSpawn([{ harnesses: ["pi"], harnessId: "pi" }]);
    const result = await run(arguments_, { environment: env, spawnImpl, fetchImpl });
    expect(result.code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(inputs).toEqual([{ route, body }]);
  });

  it("starts without a parent and returns host-qualified links", async () => {
    const env = await environment();
    env[DELEGATION_THREAD_ID_ENV] = "local-parent";
    const startResponse = {
      delegationId: "delegation",
      threadId: "child",
      turnId: "turn",
      harnessId: "pi",
      deepLink: "codex://threads/child",
      status: "running",
      next: {
        read: "codexhost thread read child",
        wait: "codexhost thread wait child --timeout-ms 30000",
      },
    };
    const { spawnImpl, inputs } = peerSpawn([startResponse]);
    const result = await run(
      [
        "delegate",
        "start",
        "--harness",
        "pi",
        "--task",
        "review",
        "--host",
        "mac",
        "--format",
        "compact",
      ],
      { environment: env, spawnImpl },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      thread: "thread://child?hostId=remote-ssh-discovered%3Amac",
      harnessId: "pi",
      status: "running",
    });
    expect(inputs[0]).toEqual({
      route: "/v1/delegate/start",
      body: {
        harnessId: "pi",
        task: "review",
        origin: {
          kind: "peer",
          hostId: "remote-ssh-discovered:self",
          threadId: "local-parent",
        },
      },
    });

    const full = await run(
      ["delegate", "start", "--harness", "pi", "--task", "review", "--host", "mac"],
      { environment: env, spawnImpl: peerSpawn([startResponse]).spawnImpl },
    );
    expect(full.code).toBe(0);
    expect(JSON.parse(full.output)).toMatchObject({
      deepLink: "thread://child?hostId=remote-ssh-discovered%3Amac",
      next: {
        read: "codexhost thread read child --host mac",
        wait: "codexhost thread wait child --timeout-ms 30000 --host mac",
      },
    });
  });

  it("rejects unsupported cross-machine start options before contacting the peer", async () => {
    const env = await environment();
    for (const extra of [["--parent-thread", "parent"]]) {
      const { spawnImpl, inputs } = peerSpawn([{}]);
      const result = await run(
        ["delegate", "start", "--harness", "pi", "--task", "review", "--host", "mac", ...extra],
        { environment: env, spawnImpl },
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.diagnostics)).toMatchObject({
        error: { code: "INVALID_ARGUMENT" },
      });
      expect(inputs).toEqual([]);
    }
  });

  it("registers a cross-host watch on the caller Runtime after a peer start", async () => {
    const env = await environment();
    env[DELEGATION_THREAD_ID_ENV] = "local-parent";
    env[DELEGATION_RUNTIME_ENDPOINT_ENV] = "http://127.0.0.1:4321";
    env[DELEGATION_RUNTIME_TOKEN_ENV] = "token";
    const { spawnImpl, inputs } = peerSpawn([
      {
        delegationId: "delegation",
        threadId: "child",
        turnId: "turn",
        harnessId: "pi",
        deepLink: "codex://threads/child",
        status: "running",
        next: { read: "read", wait: "wait" },
      },
    ]);
    const watchResponse = {
      threadId: "child",
      notifyThreadId: "local-parent",
      hostId: "mac",
      state: "watching",
      status: "running",
      timeoutMs: 60_000,
    };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(watchResponse), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await run(
      [
        "delegate",
        "start",
        "--harness",
        "pi",
        "--task",
        "review",
        "--host",
        "mac",
        "--watch",
        "true",
        "--watch-timeout-ms",
        "60000",
      ],
      { environment: env, spawnImpl, fetchImpl },
    );
    expect(result.code).toBe(0);
    expect(inputs[0]).toEqual({
      route: "/v1/delegate/start",
      body: {
        harnessId: "pi",
        task: "review",
        origin: {
          kind: "peer",
          hostId: "remote-ssh-discovered:self",
          threadId: "local-parent",
        },
      },
    });
    const watchCall = vi.mocked(fetchImpl).mock.calls[0];
    if (!watchCall) throw new Error("Local watch request was not sent");
    expect(String(watchCall[0])).toContain("/v1/thread/watch");
    expect(JSON.parse(String(watchCall[1]?.body))).toEqual({
      threadId: "child",
      notifyThreadId: "local-parent",
      timeoutMs: 60_000,
      hostId: "mac",
    });
    expect(JSON.parse(result.output)).toMatchObject({
      deepLink: "thread://child?hostId=remote-ssh-discovered%3Amac",
      watch: { state: "watching", hostId: "mac" },
    });
  });

  it("reports an unregistered cross-host watch when there is no caller Thread", async () => {
    const env = await environment();
    const { spawnImpl } = peerSpawn([
      { threadId: "child", harnessId: "pi", status: "running", next: {} },
    ]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await run(
      [
        "delegate",
        "start",
        "--harness",
        "pi",
        "--task",
        "review",
        "--host",
        "mac",
        "--watch",
        "true",
      ],
      { environment: env, spawnImpl, fetchImpl },
    );
    expect(result.code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({
      watch: { state: "notRegistered", reason: expect.stringContaining("caller Thread") },
    });
  });

  it("fails a compact peer command when SSH hides the remote exit code", async () => {
    const env = await environment();
    const { spawnImpl } = peerSpawn([
      { error: { code: "THREAD_NOT_FOUND", message: "Thread 't' does not exist" } },
    ]);
    const result = await run(["thread", "read", "t", "--host", "mac", "--format", "compact"], {
      environment: env,
      spawnImpl,
    });
    expect(result.code).toBe(1);
    expect(result.output).toBe("");
    expect(JSON.parse(result.diagnostics)).toEqual({
      error: { code: "THREAD_NOT_FOUND", message: "Thread 't' does not exist" },
    });
  });

  it("routes reads and waits from thread references and peer flags", async () => {
    const env = await environment();
    const read = peerSpawn([snapshot()]);
    const readResult = await run(
      ["thread", "read", "thread://t?hostId=remote-ssh-discovered%3Amac", "--format", "compact"],
      { environment: env, spawnImpl: read.spawnImpl },
    );
    expect(readResult.code).toBe(0);
    expect(JSON.parse(readResult.output)).toMatchObject({
      thread: "thread://t?hostId=remote-ssh-discovered%3Amac",
      status: "completed",
    });
    expect(read.inputs[0]).toEqual({
      route: "/v1/thread/read",
      body: { threadId: "t", view: "result" },
    });

    const waitResponses = [
      { status: "running", timedOut: true },
      { status: "running", timedOut: true },
      { status: "completed", timedOut: false },
    ];
    const wait = peerSpawn([
      () => {
        vi.setSystemTime(Date.now() + 240_000);
        return waitResponses[0];
      },
      () => {
        vi.setSystemTime(Date.now() + 240_000);
        return waitResponses[1];
      },
      () => waitResponses[2],
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const waitResult = await run(
      ["thread", "wait", "t", "--host", "mac", "--timeout-ms", "600000"],
      { environment: env, spawnImpl: wait.spawnImpl },
    );
    expect(waitResult.code).toBe(0);
    expect(JSON.parse(waitResult.output)).toMatchObject({ status: "completed", timedOut: false });
    expect(wait.inputs.map((input) => input.body)).toEqual([
      { threadId: "t", view: "result", timeoutMs: 240_000 },
      { threadId: "t", view: "result", timeoutMs: 240_000 },
      { threadId: "t", view: "result", timeoutMs: 120_000 },
    ]);
  });

  it("routes send and cancel and keeps the peer Host in compact links", async () => {
    const env = await environment();
    const send = peerSpawn([
      {
        threadId: "t",
        turnId: "turn",
        harnessId: "pi",
        status: "running",
        next: { read: "read", wait: "wait" },
      },
    ]);
    const sendResult = await run(
      [
        "thread",
        "send",
        "thread://t?hostId=remote-ssh-discovered%3Amac",
        "--message",
        "go",
        "--format",
        "compact",
      ],
      { environment: env, spawnImpl: send.spawnImpl },
    );
    expect(sendResult.code).toBe(0);
    expect(JSON.parse(sendResult.output)).toEqual({
      thread: "thread://t?hostId=remote-ssh-discovered%3Amac",
      harnessId: "pi",
      status: "running",
    });
    expect(send.inputs[0]).toEqual({
      route: "/v1/thread/send",
      body: { threadId: "t", message: "go" },
    });

    const sendFull = peerSpawn([
      {
        threadId: "t",
        turnId: "turn",
        harnessId: "pi",
        status: "running",
        next: { read: "codexhost thread read t", wait: "codexhost thread wait t" },
      },
    ]);
    const sendFullResult = await run(["thread", "send", "t", "--host", "mac", "--message", "go"], {
      environment: env,
      spawnImpl: sendFull.spawnImpl,
    });
    expect(sendFullResult.code).toBe(0);
    expect(JSON.parse(sendFullResult.output)).toMatchObject({
      hostId: "remote-ssh-discovered:mac",
      next: {
        read: "codexhost thread read t --host mac",
        wait: "codexhost thread wait t --host mac",
      },
    });

    const cancel = peerSpawn([{ threadId: "t", turnId: null, harnessId: "pi", cancelled: true }]);
    const cancelResult = await run(
      ["thread", "cancel", "t", "--host", "mac", "--format", "compact"],
      {
        environment: env,
        spawnImpl: cancel.spawnImpl,
      },
    );
    expect(cancelResult.code).toBe(0);
    expect(JSON.parse(cancelResult.output)).toEqual({
      thread: "thread://t?hostId=remote-ssh-discovered%3Amac",
      harnessId: "pi",
      cancelRequested: true,
    });
  });

  it("keeps configured self Host IDs local", async () => {
    const env = {
      ...(await environment()),
      [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
      [DELEGATION_RUNTIME_TOKEN_ENV]: "token",
    };
    const fetchImpl = vi.fn(
      async (url: unknown) =>
        new Response(
          JSON.stringify(String(url).endsWith("/v1/thread/watches") ? { watches: [] } : snapshot()),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const read = await run(["thread", "read", "thread://t?hostId=remote-ssh-discovered%3Aself"], {
      environment: env,
      fetchImpl,
    });
    expect(read.code).toBe(0);
    const readCall = vi.mocked(fetchImpl).mock.calls[0];
    if (!readCall) throw new Error("Runtime fetch was not called");
    expect(String(readCall[0])).toContain("/v1/thread/read");
    expect(JSON.parse(String(readCall[1]?.body))).toEqual({ threadId: "t", view: "result" });

    const watches = await run(["thread", "watches", "--host", "remote-ssh-discovered:self"], {
      environment: env,
      fetchImpl,
    });
    expect(watches.code).toBe(0);
    expect(String(vi.mocked(fetchImpl).mock.calls[1]?.[0])).toContain("/v1/thread/watches");
  });

  it("keeps Desktop remote reads as the fallback when no peer matches", async () => {
    const env = {
      ...(await environment()),
      [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
      [DELEGATION_RUNTIME_TOKEN_ENV]: "token",
    };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(snapshot()), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await run(["thread", "read", "t", "--host", "remote-ssh-discovered:unknown"], {
      environment: env,
      fetchImpl,
    });
    expect(result.code).toBe(0);
    const call = vi.mocked(fetchImpl).mock.calls[0];
    if (!call) throw new Error("Runtime fetch was not called");
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      threadId: "t",
      hostId: "remote-ssh-discovered:unknown",
      view: "result",
    });
  });

  it("registers and cancels a cross-host watch through the caller Runtime", async () => {
    const env = {
      ...(await environment()),
      [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
      [DELEGATION_RUNTIME_TOKEN_ENV]: "token",
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            threadId: "t",
            notifyThreadId: "parent",
            hostId: "mac",
            state: "watching",
            status: "running",
            timeoutMs: 60_000,
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const watched = await run(["thread", "watch", "t", "--host", "mac", "--notify", "parent"], {
      environment: env,
      fetchImpl,
    });
    expect(watched.code).toBe(0);
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body))).toEqual({
      threadId: "t",
      notifyThreadId: "parent",
      hostId: "mac",
      timeoutMs: expect.any(Number),
    });

    const cancelled = await run(
      ["thread", "watch", "t", "--host", "mac", "--notify", "parent", "--cancel"],
      { environment: env, fetchImpl },
    );
    expect(cancelled.code).toBe(0);
    expect(String(vi.mocked(fetchImpl).mock.calls[1]?.[0])).toContain("/v1/thread/watch/cancel");
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[1]?.[1]?.body))).toEqual({
      threadId: "t",
      notifyThreadId: "parent",
      hostId: "mac",
    });
  });

  it.each([
    ["thread send", ["thread", "send", "t", "--message", "go", "--host", "unknown"]],
    ["thread cancel", ["thread", "cancel", "t", "--host", "unknown"]],
    ["thread wait", ["thread", "wait", "t", "--host", "unknown"]],
    ["thread watch", ["thread", "watch", "t", "--host", "unknown", "--notify", "parent"]],
    ["thread watches", ["thread", "watches", "--host", "mac"]],
  ])("rejects %s without a configured peer", async (_name, arguments_) => {
    const env = await environment();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { spawnImpl, inputs } = peerSpawn([{}]);
    const result = await run(arguments_, { environment: env, spawnImpl, fetchImpl });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.diagnostics)).toMatchObject({
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(inputs).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
