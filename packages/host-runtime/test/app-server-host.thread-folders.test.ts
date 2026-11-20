import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
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
    const incoming = new JsonLineCollector(fixture.official.stdin);
    const captured: JsonObject[] = [];
    fixture.official.stdin.on("data", () => {
      for (const message of incoming.messages.splice(0)) {
        if (typeof message.id !== "string" && typeof message.id !== "number") continue;
        captured.push(message);
        const thread = {
          id: "native-thread",
          cwd: "/main",
          environments: [{ environmentId: "env", cwd: "/main", runtimeWorkspaceRoots: ["/main"] }],
        };
        const result =
          message.method === "initialize"
            ? { userAgent: "fixture" }
            : message.method === "turn/start"
              ? { turn: { id: "turn", status: "completed" } }
              : { thread };
        writeRequest(fixture.official.stdout, { id: message.id, result });
      }
    });
    try {
      await fixture.ready;
      const call = async (id: number, method: string, params: JsonObject) => {
        writeRequest(fixture.desktopInput, { id, method, params });
        const response = await fixture.collector.waitFor((m) => requestId(m, id));
        expect(response.error).toBeUndefined();
        return response.result;
      };
      await call(10, "thread/start", {
        cwd: "/project",
        projectId: "project",
        codexhostWorkingFolders: ["/main", "/extra"],
      });
      expect(captured.find((m) => m.method === "thread/start")?.params).toEqual({
        cwd: "/main",
        projectId: "project",
        runtimeWorkspaceRoots: ["/main", "/extra"],
      });
      expect(
        await fixture.host.handleClientRequest("codexhost/thread-folders/set", {
          threadId: "native-thread",
          folders: ["/new", "/extra"],
        }),
      ).toMatchObject({ result: { folders: ["/new", "/extra"] } });
      await call(12, "turn/start", {
        threadId: "native-thread",
        input: [{ type: "text", text: "hi" }],
      });
      expect(captured.find((m) => m.method === "turn/start")?.params).toMatchObject({
        cwd: "/new",
        environments: [
          { environmentId: "env", cwd: "/new", runtimeWorkspaceRoots: ["/new", "/extra"] },
        ],
        input: [{ text: "hi" }, { text: expect.stringContaining("工作文件夹已改为") }],
      });
      expect(
        await call(13, "codexhost/thread-folders/get", { threadId: "native-thread" }),
      ).toMatchObject({ selection: { appliedFolders: ["/new", "/extra"] } });
    } finally {
      await closeFixture(fixture);
    }
  });
});

it.each([true, false])(
  "changes an external Session's native cwd and respects extra-directory capability (%s)",
  async (additionalDirectories) => {
    const fixture = createFixture();
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
        previousCwd: "/first",
        ...(additionalDirectories ? { additionalDirectories: ["/extra-two"] } : {}),
      });
      if (!additionalDirectories)
        expect(opened.mock.calls.at(-1)?.[0]).not.toHaveProperty("additionalDirectories");
      expect(
        await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
      ).toMatchObject({
        projectId: "project-a",
      });
    } finally {
      await closeFixture(fixture);
    }
  },
);
