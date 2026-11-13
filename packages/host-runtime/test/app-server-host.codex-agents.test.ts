import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexAgentStore } from "../src/codex-agents.js";
import { DingTalkDispatchSettingsStore } from "../src/dingtalk-dispatch-settings.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-codex-agents-rpc-"));
  directories.push(directory);
  await mkdir(path.join(directory, "agents"), { recursive: true });
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Host Codex agent and DingTalk RPC", () => {
  it("creates, lists, reads and deletes an agent and saves dispatch settings", async () => {
    const home = await temporaryDirectory();
    const codexAgents = new CodexAgentStore({ codexHome: home });
    const dingTalkDispatch = new DingTalkDispatchSettingsStore({
      homeDirectory: path.join(home, "codexhost"),
    });
    const fixture = createFixture({ codexAgents, dingTalkDispatch });
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
          fileName: "terra_worker.toml",
          name: "terra_worker",
          model: "gpt-5.6-terra",
          reasoningEffort: "xhigh",
        },
      });
      const revision = (saved.result as { revision: string }).revision;

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
        params: { fileName: "terra_worker.toml" },
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
        result: {
          enabled: false,
          matchThreshold: 0.85,
          replyScope: "group",
          participatingAgents: ["terra_worker"],
        },
      });

      writeRequest(fixture.desktopInput, {
        id: 5,
        method: "codexhost/dingtalk-dispatch/set",
        params: {
          enabled: true,
          eventTypes: ["mention_me", "approval_pending"],
          matchThreshold: 0.9,
          replyScope: "direct",
          participatingAgents: ["terra_worker"],
        },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 5))).toMatchObject({
        result: { enabled: true, replyScope: "direct", matchThreshold: 0.9 },
      });

      writeRequest(fixture.desktopInput, {
        id: 6,
        method: "codexhost/codex-agents/delete",
        params: { fileName: "terra_worker.toml", expectedRevision: revision },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 6))).toMatchObject({
        result: { fileName: "terra_worker.toml" },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("rejects traversal and stale revisions with stable error codes", async () => {
    const home = await temporaryDirectory();
    const fixture = createFixture({ codexAgents: new CodexAgentStore({ codexHome: home }) });
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
          name: "bad name",
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
