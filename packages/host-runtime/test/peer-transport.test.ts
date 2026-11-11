import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedPeer } from "../src/peer-config.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
} from "../src/delegation-types.js";
import {
  peerSshArguments,
  requestPeerRoute,
  type PeerProcess,
  type PeerSpawn,
} from "../src/peer-transport.js";

const roots: string[] = [];

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cx-peer-transport-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeProcess implements PeerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    this.emit("close", null, signal ?? null);
    return true;
  });
  readonly #listeners = new Map<string, ((...arguments_: never[]) => void)[]>();

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

function peer(overrides: Partial<ResolvedPeer> = {}): ResolvedPeer {
  return {
    name: "mac",
    ssh: "mac",
    hostIds: ["remote-ssh-discovered:mac"],
    linkHostId: "remote-ssh-discovered:mac",
    ...overrides,
  };
}

function fakeSpawn(
  behavior: (input: string) => { code: number | null; stdout?: string; stderr?: string },
): {
  spawnImpl: PeerSpawn;
  calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[];
  processes: FakeProcess[];
} {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const processes: FakeProcess[] = [];
  const spawnImpl: PeerSpawn = (command, args, options) => {
    const child = new FakeProcess();
    calls.push({ command, args: [...args], env: options.env });
    processes.push(child);
    let input = "";
    child.stdin.on("data", (chunk) => {
      input += chunk.toString();
    });
    child.stdin.on("end", () => {
      const result = behavior(input);
      setImmediate(() => {
        if (result.stdout !== undefined) child.stdout.write(result.stdout);
        if (result.stderr !== undefined) child.stderr.write(result.stderr);
        child.emit("close", result.code, null);
      });
    });
    return child;
  };
  return { spawnImpl, calls, processes };
}

function request(input: {
  root: string;
  spawnImpl: PeerSpawn;
  peer?: ResolvedPeer;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>> {
  return requestPeerRoute({
    environment: input.environment ?? { CODEXHOST_USER_DIR: input.root },
    peer: input.peer ?? peer(),
    route: "/v1/harness/list",
    body: {},
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    spawnImpl: input.spawnImpl,
  });
}

describe("peer SSH transport", () => {
  it("passes the SSH options and remote command as an argument array", async () => {
    const root = await dataDirectory();
    expect(
      peerSshArguments({
        environment: { CODEXHOST_DATA_DIR: "/synthetic/data", CODEXHOST_USER_DIR: root },
        peer: peer(),
      }),
    ).toEqual({
      command: "ssh",
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ControlMaster=auto",
        "-o",
        `ControlPath=${path.join(root, "ssh", "%C")}`,
        "-o",
        "ControlPersist=60",
        "mac",
        "codexhost",
        "peer-exec",
      ],
    });
    expect(
      peerSshArguments({
        environment: { CODEXHOST_USER_DIR: root },
        peer: peer({ command: "/opt/codexhost/bin/codexhost" }),
      }).args.slice(-2),
    ).toEqual(["/opt/codexhost/bin/codexhost", "peer-exec"]);
  });

  it("writes the route envelope to stdin and parses the response", async () => {
    const root = await dataDirectory();
    let received = "";
    const { spawnImpl, calls } = fakeSpawn((input) => {
      received = input;
      return { code: 0, stdout: '{"harnesses":["codex","pi"]}' };
    });
    const environment = {
      CODEXHOST_USER_DIR: root,
      [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
      [DELEGATION_RUNTIME_TOKEN_ENV]: "secret",
    };
    await expect(request({ root, spawnImpl, environment })).resolves.toEqual({
      harnesses: ["codex", "pi"],
    });
    expect(JSON.parse(received)).toEqual({ route: "/v1/harness/list", body: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("peer-exec");
    expect(calls[0]?.args).toContain("mac");
    // A SendEnv rule must not be able to forward the local Runtime token.
    expect(calls[0]?.env[DELEGATION_RUNTIME_TOKEN_ENV]).toBeUndefined();
    expect(calls[0]?.env[DELEGATION_RUNTIME_ENDPOINT_ENV]).toBeUndefined();
  });

  it("preserves a structured error returned by the peer", async () => {
    const root = await dataDirectory();
    const { spawnImpl } = fakeSpawn(() => ({
      code: 1,
      stdout: JSON.stringify({
        error: { code: "THREAD_BUSY", message: "Thread is busy", details: { threadId: "t" } },
      }),
    }));
    await expect(request({ root, spawnImpl })).rejects.toMatchObject({
      code: "THREAD_BUSY",
      message: "Thread is busy",
      details: { threadId: "t" },
    });
  });

  it("reports a failed SSH command with its exit code and bounded stderr", async () => {
    const root = await dataDirectory();
    const { spawnImpl } = fakeSpawn(() => ({ code: 255, stderr: "Permission denied" }));
    await expect(request({ root, spawnImpl })).rejects.toMatchObject({
      code: "RUNTIME_UNREACHABLE",
      details: { peer: "mac", reason: "peer_command_failed", exitCode: 255 },
    });
  });

  it("reports unreadable, oversized, and failed-to-start peers", async () => {
    const root = await dataDirectory();
    const invalid = fakeSpawn(() => ({ code: 0, stdout: "not json" }));
    await expect(request({ root, spawnImpl: invalid.spawnImpl })).rejects.toMatchObject({
      code: "RUNTIME_UNREACHABLE",
      details: { reason: "invalid_peer_response" },
    });

    const oversized = fakeSpawn(() => ({ code: 0, stdout: "x".repeat(8 * 1024 * 1024 + 1) }));
    await expect(request({ root, spawnImpl: oversized.spawnImpl })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(oversized.processes[0]?.kill).toHaveBeenCalled();

    const failed: PeerSpawn = () => {
      throw new Error("ssh is missing");
    };
    await expect(request({ root, spawnImpl: failed })).rejects.toMatchObject({
      code: "RUNTIME_UNREACHABLE",
      details: { reason: "peer_spawn_failed" },
    });

    const spawnError = new FakeProcess();
    const emitError: PeerSpawn = () => {
      setImmediate(() => spawnError.emit("error", new Error("ENOENT")));
      return spawnError;
    };
    await expect(request({ root, spawnImpl: emitError })).rejects.toMatchObject({
      code: "RUNTIME_UNREACHABLE",
      details: { reason: "peer_spawn_failed" },
    });
  });

  it("kills the peer command after the timeout", async () => {
    const root = await dataDirectory();
    const child = new FakeProcess();
    const silent: PeerSpawn = () => child;
    await expect(request({ root, spawnImpl: silent, timeoutMs: 50 })).rejects.toMatchObject({
      code: "RUNTIME_UNREACHABLE",
      details: { peer: "mac", reason: "peer_timeout", timeoutMs: 50 },
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
