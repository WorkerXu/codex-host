import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { ExternalHarnessId, JsonObject } from "@codexhost/protocol-core";
import { harnessIdSchema } from "@codexhost/shared-contracts";

import type { DelegationControlRegistration } from "../src/delegation-types.js";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import type { SharedThreadPeer } from "../src/shared-thread-peer.js";
import {
  completePiTurn,
  createFixture,
  messageParams,
  method,
  readJsonLine,
  requestId,
  requiredMessageId,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

function fixtureWith(home: string) {
  const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const grok = new FakeHarnessAdapter(harnessIdSchema.parse("grok"));
  let api: DelegationControlRegistration | undefined;
  const fixture = createFixture({
    environment: { HOME: home },
    onDelegationApi: (registration) => {
      api = registration;
      return undefined;
    },
    externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
      ["pi" as ExternalHarnessId, pi],
      ["grok" as ExternalHarnessId, grok],
    ]),
  });
  return { fixture, pi, grok, delegationApi: () => api };
}

async function initialize(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await fixture.ready;
  writeRequest(fixture.desktopInput, {
    id: 100,
    method: "initialize",
    params: { clientInfo: { name: "switch-test", version: "1" }, capabilities: {} },
  });
  const initializeRequest = await readJsonLine(fixture.official.stdin);
  writeRequest(fixture.official.stdout, {
    id: requiredMessageId(initializeRequest),
    result: { userAgent: "official" },
  });
  await fixture.collector.waitFor((message) => requestId(message, 100));
  await readJsonLine(fixture.official.stdin);
}

/** The next Host-originated official request, answered with `result`. */
async function answerOfficial(
  fixture: ReturnType<typeof createFixture>,
  expectedMethod: string,
  result: JsonObject,
): Promise<JsonObject> {
  const request = await readJsonLine(fixture.official.stdin, 5_000);
  expect(request.method).toBe(expectedMethod);
  writeRequest(fixture.official.stdout, { id: requiredMessageId(request), result });
  return request;
}

function userTexts(turns: JsonObject[]): string[] {
  return turns.flatMap((turn) =>
    (turn.items as JsonObject[])
      .filter((item) => item.type === "userMessage")
      .map((item) => ((item.content as JsonObject[])[0] as JsonObject).text as string),
  );
}

async function readTurns(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
  id: number,
): Promise<JsonObject[]> {
  // Switched-to Threads page their history, as Desktop reads them.
  writeRequest(fixture.desktopInput, {
    id,
    method: "thread/turns/list",
    params: { threadId, sortDirection: "asc", limit: 100, itemsView: "full" },
  });
  const read = await fixture.collector.waitFor((message) => requestId(message, id));
  expect(read.error).toBeUndefined();
  return (read.result as JsonObject).data as JsonObject[];
}

describe("switching a conversation to another Agent", () => {
  it("continues an external conversation in another Harness with its history", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "codexhost-switch-home-"));
    const { fixture, grok, delegationApi } = fixtureWith(home);
    try {
      const source = await startPiThread(fixture);
      await completePiTurn(fixture, source, 2);

      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "codexhost/thread/agent/switch",
        params: {
          threadId: source,
          agent: "grok",
          input: [{ type: "text", text: "继续第三版", text_elements: [] }],
        },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 10));
      expect(response).not.toHaveProperty("error");
      const target = (response.result as JsonObject).threadId as string;
      expect(target).not.toBe(source);
      await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/started") &&
          (messageParams(message).thread as JsonObject).id === target,
      );
      await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/archived") && messageParams(message).threadId === source,
      );

      const session = grok.sessions[0];
      if (!session) throw new Error("The target Harness was not opened");
      session.appendText("第三版好了");
      session.succeedTurn();
      await fixture.collector.waitFor(
        (message) =>
          method(message, "turn/completed") && messageParams(message).threadId === target,
      );

      const sent = (session.persistedSnapshot().turns[0]?.input ?? [])
        .map(({ text }) => text)
        .join("\n");
      expect(sent).toMatch(
        new RegExp(
          `^<codexhost_handoff from="pi" thread="${target}" source="${source}" items="2" omitted="0">`,
        ),
      );
      expect(sent).toContain("synthetic");
      expect(sent).toContain("answer 2");
      expect(sent.endsWith("</codexhost_handoff>\n\n继续第三版")).toBe(true);

      const turns = await readTurns(fixture, target, 11);
      expect(String(turns[0]?.id)).toMatch(/^handoff-/);
      // The earlier conversation first, then the new request without the block.
      expect(userTexts(turns)).toEqual(["synthetic", "继续第三版"]);

      // The receiving Agent can read the whole source history back, from either end.
      const api = delegationApi();
      if (!api?.readHandoff) throw new Error("Handoff reading is not registered");
      const listed = await api.readHandoff({ threadId: source });
      expect(listed).toMatchObject({ threadId: target, sourceThreadId: source, total: 2 });
      const answer = await api.readHandoff({ threadId: target, item: "h1.2" });
      expect(answer).toMatchObject({ text: "answer 2", nextOffset: null });
      await expect(api.readHandoff({ threadId: "unknown-thread" })).rejects.toMatchObject({
        code: "THREAD_NOT_FOUND",
      });
    } finally {
      await stopFixture(fixture);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("imports an external conversation into Codex and archives the source", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "codexhost-switch-home-"));
    const { fixture } = fixtureWith(home);
    try {
      await initialize(fixture);
      const source = await startPiThread(fixture);
      await completePiTurn(fixture, source, 2);

      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "codexhost/thread/agent/switch",
        params: { threadId: source, agent: "codex" },
      });
      const importRequest = await answerOfficial(fixture, "externalAgentConfig/import", {
        importId: "import-1",
      });
      const session = (
        ((importRequest.params as JsonObject).migrationItems as JsonObject[])[0]
          ?.details as JsonObject
      ).sessions as JsonObject[];
      const file = session[0]?.path as string;
      expect(file).toBe(
        path.join(home, ".claude", "projects", "codexhost-handoff", path.basename(file)),
      );
      const written = readFileSync(file, "utf8");
      expect(written).toContain('"content":"synthetic"');
      expect(written).toContain("answer 2");
      writeRequest(fixture.official.stdout, {
        method: "externalAgentConfig/import/progress",
        params: {
          importId: "import-1",
          itemTypeResults: [
            {
              itemType: "SESSIONS",
              successes: [{ itemType: "SESSIONS", source: file, target: "codex-thread-1" }],
              failures: [],
            },
          ],
        },
      });
      await answerOfficial(fixture, "thread/read", {
        thread: { id: "codex-thread-1", cwd: "/synthetic", name: null },
      });

      const response = await fixture.collector.waitFor((message) => requestId(message, 10));
      expect(response).toMatchObject({ result: { threadId: "codex-thread-1" } });
      await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/started") &&
          (messageParams(message).thread as JsonObject).id === "codex-thread-1",
      );
      await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/archived") && messageParams(message).threadId === source,
      );
      expect(existsSync(file)).toBe(false);
    } finally {
      await stopFixture(fixture);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("moves a Codex conversation to an external Harness", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "codexhost-switch-home-"));
    const { fixture, grok } = fixtureWith(home);
    try {
      await initialize(fixture);
      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "codexhost/thread/agent/switch",
        params: {
          threadId: "official-thread",
          agent: "grok",
          input: [{ type: "text", text: "接着做", text_elements: [] }],
        },
      });
      await answerOfficial(fixture, "thread/read", {
        thread: {
          id: "official-thread",
          cwd: "/synthetic",
          name: "原生对话",
          projectId: "project-1",
          status: { type: "idle" },
        },
      });
      const list = await answerOfficial(fixture, "thread/turns/list", {
        data: [
          {
            id: "turn-a",
            status: "completed",
            items: [
              { id: "u", type: "userMessage", content: [{ type: "text", text: "原生的问题" }] },
              { id: "c", type: "commandExecution", command: "ls", aggregatedOutput: "x" },
              { id: "a", type: "agentMessage", text: "原生的回答" },
            ],
            startedAt: 100,
            completedAt: 120,
          },
        ],
        nextCursor: null,
      });
      expect(list.params).toMatchObject({
        threadId: "official-thread",
        sortDirection: "asc",
        itemsView: "full",
      });
      await answerOfficial(fixture, "thread/archive", {});

      const response = await fixture.collector.waitFor((message) => requestId(message, 10));
      expect(response).not.toHaveProperty("error");
      const target = (response.result as JsonObject).threadId as string;
      const started = await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/started") &&
          (messageParams(message).thread as JsonObject).id === target,
      );
      expect((messageParams(started).thread as JsonObject).name).toBe("原生对话");
      const session = grok.sessions[0];
      if (!session) throw new Error("The target Harness was not opened");
      session.appendText("好");
      session.succeedTurn();
      await fixture.collector.waitFor(
        (message) =>
          method(message, "turn/completed") && messageParams(message).threadId === target,
      );
      const sent = (session.persistedSnapshot().turns[0]?.input ?? [])
        .map(({ text }) => text)
        .join("\n");
      expect(sent).toContain('from="codex"');
      expect(sent).toContain("原生的问题");
      expect(sent).toContain("原生的回答");
      expect(sent).not.toContain("aggregatedOutput");
      // The activity travels too, not only the messages.
      expect(sent).toContain("$ ls\n退出码：未知\nx");
      expect(sent.endsWith("\n\n接着做")).toBe(true);
    } finally {
      await stopFixture(fixture);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs a remote GUI session's switch on the shared Host that owns external Sessions", async () => {
    const requests: { method: string; params: JsonObject }[] = [];
    const closed = Promise.withResolvers<undefined>();
    const peer: SharedThreadPeer = {
      async request(requestMethod, params) {
        requests.push({ method: requestMethod, params });
        if (requestMethod === "thread/list") return { result: { data: [], nextCursor: null } };
        if (requestMethod === "codexhost/thread/ownership/list") {
          return {
            result: {
              threads: (params.threadIds as string[]).map((threadId) => ({
                threadId,
                owner: "codex",
              })),
            },
          };
        }
        if (requestMethod === "codexhost/thread/agent/switch") {
          return { result: { threadId: "shared-new-thread" } };
        }
        return { error: { code: -32601, message: `Unexpected ${requestMethod}` } };
      },
      async respond() {},
      subscribe: () => () => undefined,
      closed: closed.promise,
      close: () => closed.resolve(undefined),
    };
    const grok = new FakeHarnessAdapter(harnessIdSchema.parse("grok"));
    const fixture = createFixture({
      sharedThreads: new SharedThreadBridge({
        connect: async () => peer,
        delegateCreates: true,
        diagnose: () => undefined,
      }),
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["grok" as ExternalHarnessId, grok],
      ]),
    });
    try {
      await fixture.ready;
      const params = {
        threadId: "official-thread",
        agent: "grok",
        input: [{ type: "text", text: "接着做", text_elements: [] }],
      };
      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "codexhost/thread/agent/switch",
        params,
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 10));
      expect(response).toMatchObject({ result: { threadId: "shared-new-thread" } });
      expect(requests).toContainEqual({ method: "codexhost/thread/agent/switch", params });
      // Nothing of the switch ran in the GUI session itself.
      expect(grok.sessions).toHaveLength(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("refuses a busy conversation and leaves it where it is", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "codexhost-switch-home-"));
    const { fixture, grok } = fixtureWith(home);
    try {
      const source = await startPiThread(fixture);
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId: source, input: [{ type: "text", text: "还在跑" }] },
      });
      await fixture.collector.waitFor((message) => requestId(message, 2));
      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "codexhost/thread/agent/switch",
        params: { threadId: source, agent: "grok", input: [{ type: "text", text: "x" }] },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 10));
      expect(response).toMatchObject({ error: { code: -32072 } });
      expect(grok.sessions).toHaveLength(0);
    } finally {
      await stopFixture(fixture);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
