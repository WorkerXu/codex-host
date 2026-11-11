import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { DelegationControlError } from "../src/delegation-types.js";
import { parsePeerExecRequest, readPeerExecRequest, runPeerExec } from "../src/peer-exec.js";
import { publishRuntimeControl } from "../src/runtime-control-file.js";

const token = "synthetic-peer-token";
const roots: string[] = [];

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cx-peer-exec-"));
  roots.push(root);
  return root;
}

function requestStream(value: unknown): PassThrough {
  const stream = new PassThrough();
  stream.end(JSON.stringify(value));
  return stream;
}

function outputText(stream: PassThrough): string {
  return stream.read()?.toString() ?? "";
}

function api(overrides: Partial<Parameters<typeof startDelegationControlServer>[0]["api"]> = {}) {
  return {
    listHarnesses: vi.fn(async () => ({ harnesses: ["codex" as const, "pi" as const] })),
    inspect: vi.fn(),
    start: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
    read: vi.fn(),
    wait: vi.fn(),
    list: vi.fn(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("peer-exec request validation", () => {
  it("accepts only the Runtime route whitelist and object bodies", () => {
    expect(parsePeerExecRequest({ route: "/v1/thread/read", body: { threadId: "t" } })).toEqual({
      route: "/v1/thread/read",
      body: { threadId: "t" },
    });
    expect(parsePeerExecRequest({ route: "/v1/harness/list" })).toEqual({
      route: "/v1/harness/list",
      body: {},
    });
    for (const value of [
      null,
      [],
      { route: "/v1/unknown", body: {} },
      { route: "/v1/harness/list", body: [] },
      { route: 7, body: {} },
    ]) {
      expect(() => parsePeerExecRequest(value)).toThrow(DelegationControlError);
    }
  });

  it("rejects input beyond the request size limit before reading a control file", async () => {
    const stream = new PassThrough();
    stream.end(
      JSON.stringify({ route: "/v1/harness/list", body: { text: "x".repeat(2_100_000) } }),
    );
    await expect(readPeerExecRequest(stream)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("peer-exec proxy", () => {
  it("posts a whitelisted route to the live local Runtime and passes the response through", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_USER_DIR: root };
    const server = await startDelegationControlServer({ token, api: api() });
    const control = await publishRuntimeControl({
      environment,
      endpoint: server.endpoint,
      token,
      pid: process.pid,
    });
    try {
      const output = new PassThrough();
      await expect(
        runPeerExec({
          stream: requestStream({ route: "/v1/harness/list", body: {} }),
          output,
          environment,
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(outputText(output))).toEqual({ harnesses: ["codex", "pi"] });
    } finally {
      await control.close();
      await server.close();
    }
  });

  it("passes a structured Runtime error through and exits nonzero", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_USER_DIR: root };
    const server = await startDelegationControlServer({
      token,
      api: api({
        start: vi.fn(async () => {
          throw new DelegationControlError("THREAD_BUSY", "Thread is busy", { threadId: "t" });
        }),
      }),
    });
    const control = await publishRuntimeControl({
      environment,
      endpoint: server.endpoint,
      token,
      pid: process.pid,
    });
    try {
      const output = new PassThrough();
      await expect(
        runPeerExec({
          stream: requestStream({ route: "/v1/delegate/start", body: { harnessId: "pi" } }),
          output,
          environment,
        }),
      ).resolves.toBe(1);
      expect(JSON.parse(outputText(output))).toEqual({
        error: { code: "THREAD_BUSY", message: "Thread is busy", details: { threadId: "t" } },
      });
    } finally {
      await control.close();
      await server.close();
    }
  });

  it("reports a missing local Runtime without contacting anything", async () => {
    const root = await dataDirectory();
    const output = new PassThrough();
    await expect(
      runPeerExec({
        stream: requestStream({ route: "/v1/harness/list", body: {} }),
        output,
        environment: { CODEXHOST_USER_DIR: root },
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(outputText(output))).toMatchObject({
      error: { code: "RUNTIME_UNREACHABLE" },
    });
  });

  it("rejects a route before reading a control file", async () => {
    const readControl = vi.fn(async () => undefined);
    const output = new PassThrough();
    await expect(
      runPeerExec({
        stream: requestStream({ route: "/v1/internal/secret", body: {} }),
        output,
        readControl,
      }),
    ).resolves.toBe(1);
    expect(readControl).not.toHaveBeenCalled();
    expect(JSON.parse(outputText(output))).toMatchObject({
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it.each([
    [
      "unreachable",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
      "RUNTIME_UNREACHABLE",
    ],
    [
      "unreadable",
      vi.fn(
        async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      ) as unknown as typeof fetch,
      "RUNTIME_UNREACHABLE",
    ],
  ])("reports an %s Runtime response", async (_name, fetchImpl, code) => {
    const output = new PassThrough();
    await expect(
      runPeerExec({
        stream: requestStream({ route: "/v1/harness/list", body: {} }),
        output,
        readControl: async () => ({
          filePath: "/synthetic/control.json",
          record: {
            formatVersion: 1,
            endpoint: "http://127.0.0.1:4321",
            token,
            pid: process.pid,
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        fetchImpl,
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(outputText(output))).toMatchObject({ error: { code } });
  });
});
