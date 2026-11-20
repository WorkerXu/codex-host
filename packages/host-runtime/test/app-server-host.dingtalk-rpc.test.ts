import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DINGTALK_CONVERSATIONS_METHOD,
  DINGTALK_DISPATCH_RUN_METHOD,
  DINGTALK_MESSAGES_METHOD,
  jsonValueSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { expect, it } from "vitest";

import { CodexAgentStore } from "../src/codex-agents.js";
import { createDingTalkCli } from "../src/dingtalk-cli.js";
import { DingTalkDispatchSettingsStore } from "../src/dingtalk-dispatch-settings.js";
import { DingTalkService } from "../src/dingtalk-service.js";
import {
  createFixture,
  initializeDingTalkFixture,
  JsonLineCollector,
  requestId,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

it("validates DingTalk unread, messages and native dispatch at the Desktop Host boundary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codexhost-dingtalk-rpc-"));
  const environment = { HOME: directory, CODEX_HOME: directory, CODEXHOST_USER_DIR: directory };
  const now = Date.now();
  const conversationId = "cid-example";
  const messageId = "msg-example";
  const row = {
    title: "示例群",
    openConversationId: conversationId,
    singleChat: false,
    unreadPoint: 1,
    lastMsgCreateAt: now,
  };
  const cli = createDingTalkCli({
    environment,
    async runImpl(args) {
      let value: Record<string, unknown> = {};
      switch (args.slice(0, 3).join(" ")) {
        case "chat message list-unread-conversations":
          value = { result: { conversations: [row] } };
          break;
        case "chat message list":
          value = {
            messages: [
              {
                messageId,
                conversationId,
                createTime: now,
                content: "请整理值班安排",
                sender: "示例成员",
                senderId: "open-member",
              },
            ],
          };
          break;
        case "chat message send-a2ui-card":
          value = { bizId: "card-example" };
          break;
      }
      return {
        value,
        exitCode: 0,
        stdout: JSON.stringify(value),
        stderr: "",
        timedOut: false,
        truncated: false,
        errorCode: null,
        errorMessage: null,
      };
    },
  });
  // CLI adapters can supply optional metadata as explicit undefined.
  cli.conversationInfo = async () => ({
    conversationId,
    title: row.title,
    singleChat: false,
    lastMessageAt: now,
    unreadCount: 1,
    muted: false,
    preview: undefined,
  });
  const dingtalk = new DingTalkService({ environment, cli, isLocalHost: true, now: () => now });
  let fixture: ReturnType<typeof createFixture> | undefined;
  try {
    const agent = await new CodexAgentStore({ environment }).save({
      fileName: null,
      expectedRevision: null,
      name: "值班助手",
      description: "整理值班安排",
      developerInstructions: "阅读会话并汇总。",
      model: null,
      reasoningEffort: null,
    });
    await new DingTalkDispatchSettingsStore({ environment }).write({
      agents: {
        [agent.fileName]: {
          enabled: true,
          replyScope: "group",
          sectionId: "section-example",
          projectId: "legacy-project",
          projectPath: directory,
          projectRoots: [directory],
        },
      },
    });
    await writeFile(
      path.join(directory, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {
          "legacy-project": { id: "legacy-project", name: "工作项目", rootPaths: [directory] },
        },
        "app-server-project-id-by-legacy-project-id-by-host": {
          [`local:${directory}`]: { "legacy-project": "native-project" },
        },
      }),
    );
    const active = (fixture = createFixture({ environment, dingtalk, ownDingTalkDispatch: true }));
    await initializeDingTalkFixture(active);
    const nativeRequests = new JsonLineCollector(active.official.stdin);
    function respond(input: JsonObject, result: JsonObject) {
      active.official.stdout.write(JSON.stringify({ id: input.id, result }) + "\n");
    }
    async function resultFor(id: number) {
      const reply = await active.collector.waitFor((message) => requestId(message, id));
      expect(reply.error).toBeUndefined();
      return jsonValueSchema.parse(reply.result);
    }

    writeRequest(active.desktopInput, { id: 1, method: DINGTALK_CONVERSATIONS_METHOD, params: {} });
    expect(await resultFor(1)).toMatchObject({
      available: true,
      conversations: [{ conversationId }],
    });
    writeRequest(active.desktopInput, {
      id: 2,
      method: DINGTALK_MESSAGES_METHOD,
      params: { conversationId },
    });
    expect(await resultFor(2)).toMatchObject({
      conversation: { conversationId },
      messages: [{ messageId, text: "请整理值班安排" }],
    });
    writeRequest(active.desktopInput, {
      id: 3,
      method: DINGTALK_DISPATCH_RUN_METHOD,
      params: { conversationId, messageId, agents: [agent.fileName] },
    });
    const read = await nativeRequests.waitFor(({ method }) => method === "project/read");
    expect(read.params).toEqual({ projectId: "native-project" });
    respond(read, { project: { id: "native-project", roots: [{ path: directory }] } });
    const thread = await nativeRequests.waitFor(({ method }) => method === "thread/start");
    expect(thread.params).toMatchObject({
      cwd: directory,
      projectId: "native-project",
      runtimeWorkspaceRoots: [directory],
      sandbox: "read-only",
    });
    respond(thread, { thread: { id: "thread-example", projectId: "native-project" } });
    respond(await nativeRequests.waitFor(({ method }) => method === "thread/name/set"), {});
    respond(await nativeRequests.waitFor(({ method }) => method === "turn/start"), {
      turn: { id: "turn-example" },
    });
    expect(await resultFor(3)).toEqual({
      results: [
        {
          fileName: agent.fileName,
          name: agent.name,
          threadId: "thread-example",
          error: null,
        },
      ],
    });
  } finally {
    if (fixture) await stopFixture(fixture);
    await dingtalk.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
