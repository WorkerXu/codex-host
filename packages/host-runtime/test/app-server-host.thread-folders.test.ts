import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  closeFixture,
  completePiTurn,
  startExternalThread,
  createFixture,
  JsonLineCollector,
  requestId,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("working folders through the app-server Host path", () => {
  it("loads installed Harness capabilities before answering a first folder request", async () => {
    const fixture = createFixture();
    await closeFixture(fixture);
    const pluginDirectory = path.join(fixture.mappingStoreDirectory, "plugins");
    const directory = path.join(pluginDirectory, "claude-code");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(pluginDirectory, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["claude-code"] }),
    );
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "claude-code",
        name: "Claude Code",
        version: "1.0.0",
        adapterApiVersion: 1,
        entry: "index.mjs",
      }),
    );
    await writeFile(
      path.join(directory, "index.mjs"),
      `
      import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
      export async function createHarnessAdapter() {
        await new Promise(resolve => setTimeout(resolve, 30));
        return Object.assign(new FakeHarnessAdapter("claude-code"), { additionalDirectories: true });
      }
    `,
    );
    const loaded = createFixture({
      pluginDirectory,
      mappingStoreDirectory: fixture.mappingStoreDirectory,
    });
    try {
      writeRequest(loaded.desktopInput, {
        id: 99,
        method: "codexhost/thread-folders/get",
        params: { harnessId: "claude-code" },
      });
      expect(await loaded.collector.waitFor((m) => requestId(m, 99))).toMatchObject({
        result: { additionalDirectories: true },
      });
    } finally {
      await closeFixture(loaded);
    }
  });
  it("forwards native starts and turn environments while leaving projectId untouched", async () => {
    const fixture = createFixture();
    await fixture.ready;
    const official = new JsonLineCollector(fixture.official.stdin);
    fixture.official.stdin.on("data", () => {
      for (const message of official.messages.splice(0)) {
        const thread = {
          id: "native-thread",
          cwd: "/main",
          environments: [{ environmentId: "env", cwd: "/main", runtimeWorkspaceRoots: ["/main"] }],
        };
        fixture.official.stdout.write(
          `${JSON.stringify({ id: message.id, result: message.method === "turn/start" ? { turn: { id: "turn" } } : { thread } })}\n`,
        );
      }
    });
    try {
      const captured: JsonObject[] = [];
      fixture.official.stdin.on("data", (data: Buffer) =>
        captured.push(
          ...data
            .toString()
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as JsonObject),
        ),
      );
      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "thread/start",
        params: {
          cwd: "/project",
          projectId: "project",
          codexhostWorkingFolders: ["/main", "/extra"],
        },
      });
      await fixture.collector.waitFor((m) => requestId(m, 10));
      expect(captured.find((m) => m.id === 10)?.params).toEqual({
        cwd: "/main",
        projectId: "project",
        runtimeWorkspaceRoots: ["/main", "/extra"],
      });
      writeRequest(fixture.desktopInput, {
        id: 11,
        method: "codexhost/thread-folders/set",
        params: { threadId: "native-thread", folders: ["/new", "/extra"] },
      });
      await fixture.collector.waitFor((m) => requestId(m, 11));
      writeRequest(fixture.desktopInput, {
        id: 12,
        method: "turn/start",
        params: { threadId: "native-thread", input: [{ type: "text", text: "hi" }] },
      });
      const response = await fixture.collector.waitFor((m) => requestId(m, 12));
      expect(response.error).toBeUndefined();
      expect(captured.find((m) => m.id === 12)?.params).toMatchObject({
        cwd: "/new",
        environments: [
          { environmentId: "env", cwd: "/new", runtimeWorkspaceRoots: ["/new", "/extra"] },
        ],
        input: [{ text: "hi" }, { text: expect.stringContaining("工作文件夹已改为") }],
      });
      writeRequest(fixture.desktopInput, {
        id: 13,
        method: "codexhost/thread-folders/get",
        params: { threadId: "native-thread" },
      });
      const saved = await fixture.collector.waitFor((m) => requestId(m, 13));
      expect(saved.result).toMatchObject({ selection: { appliedFolders: ["/new", "/extra"] } });
    } finally {
      await closeFixture(fixture);
    }
  });
});

it.each([undefined, "/different"])(
  "inherits a native delegate's project with current environment or explicit cwd (%s)",
  async (cwd) => {
    let api: DelegationControlRegistration | undefined;
    const fixture = createFixture({
      onDelegationApi(value) {
        api = value;
      },
    });
    await fixture.ready;
    const requests: JsonObject[] = [];
    const incoming = new JsonLineCollector(fixture.official.stdin);
    fixture.official.stdin.on("data", () => {
      for (const message of incoming.messages.splice(0)) {
        requests.push(message);
        const result =
          message.method === "thread/read"
            ? {
                thread: {
                  id: "parent",
                  cwd: "/stale",
                  environments: [{ environmentId: "env", cwd: "/current" }],
                  projectId: "parent-project",
                },
              }
            : message.method === "thread/start"
              ? { thread: { id: "native-child" } }
              : message.method === "turn/start"
                ? { turn: { id: "native-turn" } }
                : {};
        fixture.official.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    });
    try {
      if (!api) throw new Error("No delegation API");
      await api.start({
        harnessId: "codex",
        task: "check",
        parentThreadId: "parent",
        ...(cwd ? { cwd } : {}),
      });
      expect(requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
        cwd: cwd ?? "/current",
        projectId: "parent-project",
      });
    } finally {
      await closeFixture(fixture);
    }
  },
);

it.each([true, false])(
  "changes an external Session's native cwd and respects extra-directory capability (%s)",
  async (additionalDirectories) => {
    let delegation: DelegationControlRegistration | undefined;
    const fixture = createFixture({
      onDelegationApi(value) {
        delegation = value;
      },
    });
    Object.assign(fixture.adapter, { additionalDirectories });
    const nativeOpen = fixture.adapter.open.bind(fixture.adapter);
    const opened = vi.spyOn(fixture.adapter, "open").mockImplementation(async (input) => {
      if (input.kind !== "resume") return nativeOpen(input);
      const previous = fixture.adapter.sessions.at(-1);
      if (!previous) throw new Error("No persisted Session");
      const session = new FakeHarnessSession(
        fixture.adapter.harnessId,
        fixture.adapter.catalog,
        undefined,
        input.nativeRef,
        previous.persistedSnapshot(),
        true,
        input.cwd,
      );
      fixture.adapter.sessions.push(session);
      return { ok: true, value: session };
    });
    try {
      const threadId = await startExternalThread(fixture, "codexhost/pi-native", 20, {
        projectId: "project-a",
        codexhostWorkingFolders: ["/first", "/extra-one"],
      });
      await completePiTurn(fixture, threadId, 21);
      writeRequest(fixture.desktopInput, {
        id: 22,
        method: "codexhost/thread-folders/set",
        params: { threadId, folders: ["/second", "/extra-two"] },
      });
      await fixture.collector.waitFor((message) => requestId(message, 22));
      await completePiTurn(fixture, threadId, 23, 1);
      expect(opened.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: "resume",
        cwd: "/second",
        ...(additionalDirectories ? { additionalDirectories: ["/extra-two"] } : {}),
      });
      if (!additionalDirectories)
        expect(opened.mock.calls.at(-1)?.[0]).not.toHaveProperty("additionalDirectories");
      expect(
        await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
      ).toMatchObject({
        projectId: "project-a",
      });
      if (!delegation) throw new Error("No delegation API");
      const child = await delegation.start({
        harnessId: "pi",
        task: "follow up",
        parentThreadId: threadId,
      });
      expect(child.cwd).toBe(path.resolve("/second"));
    } finally {
      await closeFixture(fixture);
    }
  },
);
