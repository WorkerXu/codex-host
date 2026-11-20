import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDingTalkCli } from "../src/dingtalk-cli.js";
import { createDingTalkService } from "../src/dingtalk-service.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

const directories: string[] = [];

function fixtureWithAgents(home: string) {
  const dingtalk = createDingTalkService({
    environment: { HOME: home, CODEX_HOME: home, CODEXHOST_USER_DIR: home },
    isLocalHost: true,
    cli: createDingTalkCli({
      runImpl: async () => ({
        value: null,
        stdout: "",
        stderr: "",
        exitCode: 1,
        timedOut: false,
        truncated: false,
        errorCode: "not_logged_in",
        errorMessage: null,
      }),
    }),
  });
  const fixture = createFixture({
    environment: { HOME: home, CODEX_HOME: home },
    dingtalk,
    ownDingTalkDispatch: true,
  });
  disposers.push(() => dingtalk.dispose());
  return fixture;
}

const disposers: (() => Promise<void>)[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-codex-agents-rpc-"));
  directories.push(directory);
  await mkdir(path.join(directory, "agents"), { recursive: true });
  return directory;
}

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Host Codex agent and DingTalk RPC", () => {
  it("creates, lists, reads and deletes an agent and saves dispatch settings", async () => {
    const home = await temporaryDirectory();
    const fixture = fixtureWithAgents(home);
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/codex-agents/save",
        params: {
          fileName: null,
          expectedRevision: null,
          name: "terra_worker",
          description: "Bounded worker.",
          model: "gpt-5.6-terra",
          reasoningEffort: "xhigh",
          developerInstructions: "Do the work and verify it.",
        },
      });
      const saved = await fixture.collector.waitFor((message) => requestId(message, 1));
      expect(saved).toMatchObject({
        result: {
          name: "terra_worker",
          model: "gpt-5.6-terra",
          reasoningEffort: "xhigh",
        },
      });
      const savedRecord = saved.result as { fileName: string; revision: string };
      expect(savedRecord.fileName).toMatch(/^agent-[0-9a-f]{12}\.toml$/u);
      const revision = savedRecord.revision;

      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/codex-agents/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        result: { agents: [{ name: "terra_worker" }], issues: [] },
      });

      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/codex-agents/read",
        params: { fileName: savedRecord.fileName },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        result: { developerInstructions: "Do the work and verify it." },
      });

      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "codexhost/dingtalk-dispatch/get",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 4))).toMatchObject({
        result: { agents: {} },
      });

      writeRequest(fixture.desktopInput, {
        id: 5,
        method: "codexhost/dingtalk-dispatch/set",
        params: {
          agents: {
            [savedRecord.fileName]: {
              enabled: true,
              replyScope: "direct",
              sectionId: "section-1",
              projectId: "project-1",
              projectPath: "/Users/me/project",
            },
          },
        },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 5))).toMatchObject({
        result: {
          agents: {
            [savedRecord.fileName]: {
              enabled: true,
              replyScope: "direct",
              projectId: "project-1",
            },
          },
        },
      });

      writeRequest(fixture.desktopInput, {
        id: 6,
        method: "codexhost/codex-agents/delete",
        params: { fileName: savedRecord.fileName, expectedRevision: revision },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 6))).toMatchObject({
        result: { fileName: savedRecord.fileName },
      });

      // Deleting an agent also removes it from DingTalk participation.
      writeRequest(fixture.desktopInput, {
        id: 7,
        method: "codexhost/dingtalk-dispatch/get",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 7))).toMatchObject({
        result: { agents: {} },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("accepts Chinese, spaced and long names through the RPC contract", async () => {
    const home = await temporaryDirectory();
    const fixture = fixtureWithAgents(home);
    try {
      await fixture.ready;
      const name = `  发布 与 值守 助手（华东区，夜间值守） ${"很长的名字".repeat(40)}  `;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/codex-agents/save",
        params: {
          fileName: null,
          expectedRevision: null,
          name,
          description: "中文描述。",
          model: null,
          reasoningEffort: null,
          developerInstructions: "处理发布检查。",
        },
      });
      const saved = await fixture.collector.waitFor((message) => requestId(message, 1));
      expect(saved).toMatchObject({ result: { name: name.trim() } });
      expect((saved.result as { fileName: string }).fileName).toMatch(
        /^agent-[0-9a-f]{12}\.toml$/u,
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it("rejects traversal and stale revisions with stable error codes", async () => {
    const home = await temporaryDirectory();
    const fixture = fixtureWithAgents(home);
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/codex-agents/read",
        params: { fileName: "../escape.toml" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        error: { code: -32095, message: "invalid_file_name" },
      });
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/codex-agents/save",
        params: {
          fileName: null,
          expectedRevision: null,
          name: "   ",
          description: "Description.",
          model: null,
          reasoningEffort: null,
          developerInstructions: "Instructions.",
        },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        error: { code: -32095, message: "invalid_name" },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("reports the methods as local-only when the Host has no stores", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/codex-agents/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        error: { code: -32601 },
      });
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/dingtalk-dispatch/get",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        error: { code: -32601 },
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
