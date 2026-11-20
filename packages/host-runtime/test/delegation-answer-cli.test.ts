import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runDelegationCli } from "../src/delegation-cli.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { QuestionInteractions } from "../src/question-interactions.js";

it("reads and answers the owning request through the real CLI, registry and HTTP service", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-answers-"));
  const respond = vi.fn(async () => undefined);
  const questions = new QuestionInteractions({
    run: async (_id, run) => run(),
    resolved: vi.fn(async () => undefined),
    diagnose: vi.fn(),
  });
  questions.register({
    requestId: -1,
    threadId: "thread",
    turnId: "turn",
    harnessId: "pi",
    request: { questions: [{ id: "choice", question: "Continue?" }] },
    respond,
  });
  const registry = new DelegationControlRegistry();
  registry.register({
    listHarnesses: vi.fn(),
    inspect: vi.fn(),
    start: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
    wait: vi.fn(),
    list: vi.fn(),
    answer: (input) => questions.answer(input),
    canHandleStart: () => false,
    ownsThread: (id) => id === "thread",
    read: async () => ({
      threadId: "thread",
      harnessId: "pi",
      status: "running",
      turn: { turnId: "turn", status: "running" },
      progress: [],
      result: { availability: "pending" },
      nextCursor: null,
      pendingQuestions: questions.read("thread"),
    }),
  });
  const server = await startDelegationControlServer({ token: "synthetic-token", api: registry });
  const environment = {
    CODEXHOST_USER_DIR: directory,
    CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
    CODEXHOST_RUNTIME_TOKEN: "synthetic-token",
  };
  try {
    const readOutput = new PassThrough();
    expect(
      await runDelegationCli({
        arguments: ["thread", "read", "thread", "--format", "compact"],
        environment,
        output: readOutput,
      }),
    ).toBe(0);
    const interactionId = JSON.parse(readOutput.read().toString()).pendingQuestions[0]
      .interactionId as string;
    const file = path.join(directory, "reply.json");
    const result = {
      answers: { choice: { answers: ["Continue"] } },
      nativeExtension: { unchanged: true },
    };
    await writeFile(file, JSON.stringify(result));
    const arguments_ = [
      "thread",
      "answer",
      "codex://threads/thread",
      "--interaction",
      interactionId,
      "--answers-file",
      file,
      "--format",
      "compact",
    ];
    const output = new PassThrough();
    expect(await runDelegationCli({ arguments: arguments_, environment, output })).toBe(0);
    expect(JSON.parse(output.read().toString())).toMatchObject({
      thread: "codex://threads/thread",
      interaction: interactionId,
      turn: "turn",
      status: "running",
    });
    expect(respond).toHaveBeenCalledExactlyOnceWith({ result });
    const errorOutput = new PassThrough();
    expect(
      await runDelegationCli({ arguments: arguments_, environment, diagnosticOutput: errorOutput }),
    ).toBe(1);
    expect(JSON.parse(errorOutput.read().toString())).toMatchObject({
      error: { code: "QUESTION_NOT_PENDING" },
    });
    expect(respond).toHaveBeenCalledOnce();
  } finally {
    await server.close();
    registry.close();
    await questions.closeWhere(() => true);
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects an unreadable or malformed answer file before sending any request", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-answers-"));
  const file = path.join(directory, "reply.json");
  const fetchImpl = vi.fn<typeof fetch>();
  try {
    for (const content of [undefined, "not JSON"]) {
      if (content !== undefined) await writeFile(file, content);
      const errorOutput = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: [
            "thread",
            "answer",
            "thread",
            "--interaction",
            "opaque",
            "--answers-file",
            file,
          ],
          environment: { CODEXHOST_USER_DIR: directory },
          fetchImpl,
          diagnosticOutput: errorOutput,
        }),
      ).toBe(1);
      expect(JSON.parse(errorOutput.read().toString())).toMatchObject({
        error: { code: "INVALID_ARGUMENT" },
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
