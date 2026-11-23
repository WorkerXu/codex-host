import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { writePeerConfig } from "../src/peer-config.js";
import type { PeerSpawn } from "../src/peer-transport.js";

let directory: string;
let environment: NodeJS.ProcessEnv;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-peer-cli-"));
  environment = {
    CODEXHOST_USER_DIR: directory,
    CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:9091",
    CODEXHOST_RUNTIME_TOKEN: "test-only",
    CODEXHOST_THREAD_ID: "caller",
  };
  await writePeerConfig(environment, {
    formatVersion: 1,
    peers: { mac: { ssh: "mac", hostIds: ["remote-ssh-discovered:mac"] } },
    self: { hostIds: ["here"] },
  });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function cli(args: string[]) {
  const output = new PassThrough();
  const diagnosticOutput = new PassThrough();
  const requests: { transport: "ssh" | "runtime"; route: string; body: Record<string, unknown> }[] =
    [];
  const spawnImpl: PeerSpawn = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
    const chunks: string[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    stdin.on("finish", () => {
      const { route, body } = JSON.parse(chunks.join(""));
      requests.push({ transport: "ssh", route, body });
      stdout.end(
        JSON.stringify(
          route === "/v1/harness/inspect"
            ? { harnessId: body.harnessId, inspection: { status: "notInstalled" } }
            : {
                threadId: "child",
                status: "running",
                timedOut: false,
                next: { read: "codexhost thread read child" },
              },
        ),
      );
      child.emit("close", 0, null);
    });
    return child;
  };
  const code = await runDelegationCli({
    arguments: args,
    environment,
    output,
    diagnosticOutput,
    spawnImpl,
    fetchImpl: async (url, options) => {
      const request = {
        transport: "runtime" as const,
        route: new URL(String(url)).pathname,
        body: JSON.parse(String(options?.body)),
      };
      requests.push(request);
      return Response.json({
        threadId: request.body.threadId,
        notifyThreadId: "caller",
        state: "watching",
        hostId: request.body.hostId,
        timeoutMs: request.body.timeoutMs,
      });
    },
  });
  expect(code, diagnosticOutput.read()?.toString()).toBe(0);
  return { requests, output: JSON.parse(output.read()?.toString() ?? "") };
}

it.each([
  { args: ["harness", "list", "--host", "mac"], route: "/v1/harness/list", body: {} },
  {
    args: ["harness", "inspect", "pi", "--host", "mac", "--cwd", "/remote"],
    route: "/v1/harness/inspect",
    body: { harnessId: "pi", cwd: "/remote" },
  },
  {
    args: ["thread", "read", "child", "--host", "mac"],
    route: "/v1/thread/read",
    body: { threadId: "child", view: "result" },
  },
  {
    args: ["thread", "wait", "child", "--host", "mac", "--timeout-ms", "1000"],
    route: "/v1/thread/wait",
    body: { threadId: "child", view: "result", timeoutMs: expect.any(Number) },
  },
  {
    args: ["thread", "cancel", "child", "--host", "mac"],
    route: "/v1/thread/cancel",
    body: { threadId: "child" },
  },
  {
    args: ["thread", "send", "child", "--host", "mac", "--message", "hello"],
    route: "/v1/thread/send",
    body: { threadId: "child", message: "hello" },
  },
])("routes $route to the peer with target-machine arguments", async ({ args, route, body }) => {
  expect((await cli(args)).requests).toEqual([{ transport: "ssh", route, body }]);
});

it("uses the Desktop path for an unknown peer and uses local routing for a self alias", async () => {
  const fallback = await cli(["thread", "read", "child", "--host", "desktop-only"]);
  expect(fallback.requests[0]).toMatchObject({
    transport: "runtime",
    body: { hostId: "desktop-only", callerThreadId: "caller" },
  });
  const self = await cli(["thread", "read", "child", "--host", "here"]);
  expect(self.requests[0]).toMatchObject({ transport: "runtime", body: { threadId: "child" } });
  expect(self.requests[0]?.body).not.toHaveProperty("hostId");
});

it("starts on the peer and registers its watch on the calling Host", async () => {
  const { requests, output } = await cli([
    "delegate",
    "start",
    "--host",
    "mac",
    "--harness",
    "pi",
    "--cwd",
    "/remote/work",
    "--worktree",
    "job-1",
    "--task",
    "Implement",
    "--watch",
    "true",
    "--format",
    "compact",
  ]);
  expect(requests).toEqual([
    {
      transport: "ssh",
      route: "/v1/delegate/start",
      body: {
        cwd: "/remote/work",
        worktree: "job-1",
        harnessId: "pi",
        task: "Implement",
        origin: { kind: "peer", hostId: "here", threadId: "caller" },
      },
    },
    {
      transport: "runtime",
      route: "/v1/thread/watch",
      body: {
        threadId: "child",
        hostId: "mac",
        notifyThreadId: "caller",
        timeoutMs: 1_740_000,
      },
    },
  ]);
  expect(output).toMatchObject({
    thread: "thread://child?hostId=remote-ssh-discovered%3Amac",
    watch: { state: "watching" },
  });
});

it("registers a watch from a host-qualified Thread reference", async () => {
  expect(
    (await cli(["thread", "watch", "thread://child?hostId=remote-ssh-discovered%3Amac"])).requests,
  ).toEqual([
    {
      transport: "runtime",
      route: "/v1/thread/watch",
      body: {
        hostId: "remote-ssh-discovered:mac",
        threadId: "child",
        notifyThreadId: "caller",
        timeoutMs: 1_740_000,
      },
    },
  ]);
});
