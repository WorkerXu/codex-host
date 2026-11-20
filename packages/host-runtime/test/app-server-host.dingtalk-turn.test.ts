import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import {
  answerOfficialParentCwd,
  createFixture,
  initializeDingTalkFixture,
  readJsonLine,
  requestId,
  requiredMessageId,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const CARRIER = "[@示例成员](dingtalk://conversation/cid-test%2Bexample%3D) 最新的一条消息是什么";

function fakeDingTalk() {
  const expandMentions = vi.fn(async (text: string) => {
    if (!text.includes("dingtalk://")) return text;
    return `${text.replace(/\[@示例成员\]\s*\([^)]*\)/u, "@示例成员")}\n\n[codexhost DingTalk]\n单聊「示例成员」`;
  });
  return {
    service: {
      expandMentions,
      addNotifier: () => () => undefined,
      dispose: () => undefined,
    } as never,
    expandMentions,
  };
}

function answerTurn(fixture: ReturnType<typeof createFixture>, request: JsonObject): void {
  const id = requiredMessageId(request);
  fixture.official.stdout.write(
    `${JSON.stringify({ id, result: { turn: { id: `turn-${id}` } } })}\n`,
  );
}

/**
 * The remote Unix listener session owns native Codex Threads. Its options match
 * the AppServerHost created in run-host-runtime's remote branch: a shared
 * Thread bridge and the same DingTalk service as the external host.
 */
function remoteListenerSession(options: { dingtalk: unknown }) {
  const bridge = new SharedThreadBridge({
    connect: async () => null,
    delegateCreates: true,
    diagnose: () => undefined,
  });
  return createFixture({
    dingtalk: options.dingtalk as never,
    sharedThreads: bridge,
  });
}

describe("DingTalk expansion on the remote listener session", () => {
  it("expands a native turn/start before it reaches official Codex", async () => {
    const fake = fakeDingTalk();
    const fixture = remoteListenerSession({ dingtalk: fake.service });
    try {
      await initializeDingTalkFixture(fixture);
      writeRequest(fixture.desktopInput, {
        id: 30,
        method: "turn/start",
        params: {
          threadId: "official-thread",
          input: [{ type: "text", text: CARRIER }],
        },
      });
      await answerOfficialParentCwd(fixture, "official-thread");
      const forwarded = await readJsonLine(fixture.official.stdin);
      answerTurn(fixture, forwarded);
      expect(forwarded.method).toBe("turn/start");
      const text = (forwarded.params as JsonObject).input as JsonObject[];
      expect(text[0]?.text).toContain("[codexhost DingTalk]");
      expect(text[0]?.text).not.toContain("dingtalk://");
      expect(fake.expandMentions).toHaveBeenCalledOnce();
      await fixture.collector.waitFor((message) => requestId(message, 30));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("tells the agent to use the routed CLI when reading fails", async () => {
    const expandMentions = vi.fn(async () => {
      throw new Error("DingTalk Host unreachable");
    });
    const fixture = remoteListenerSession({
      dingtalk: { expandMentions, addNotifier: () => () => undefined, dispose: () => undefined },
    });
    try {
      await initializeDingTalkFixture(fixture);
      writeRequest(fixture.desktopInput, {
        id: 32,
        method: "turn/start",
        params: {
          threadId: "official-thread",
          input: [
            {
              type: "text",
              text: "[@【线上群】]\\(dingtalk://conversation/cid-fake-group%3D%3D) 最近5条消息",
            },
          ],
        },
      });
      await answerOfficialParentCwd(fixture, "official-thread");
      const forwarded = await readJsonLine(fixture.official.stdin);
      answerTurn(fixture, forwarded);
      expect(forwarded.method).toBe("turn/start");
      const text = String(((forwarded.params as JsonObject).input as JsonObject[])[0]?.text);
      expect(text).toContain("@【线上群】 最近5条消息");
      expect(text).toContain("conversationId=cid-fake-group==");
      expect(text).toContain("codexhost dingtalk dws --");
      expect(text).not.toContain("dingtalk://");
      await fixture.collector.waitFor((message) => requestId(message, 32));
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([
    {
      name: "a newline between the label and target",
      input: [`[@示例成员]\n(dingtalk://conversation/cidWithNewline%3D%3D) 最新的一条消息是什么`],
    },
    {
      name: "adjacent text items split after the label",
      input: ["[@示例成员]", "(dingtalk://conversation/cidSplit%3D%3D) 最新的一条消息是什么"],
    },
  ])("expands $name", async ({ input }) => {
    const fake = fakeDingTalk();
    const fixture = remoteListenerSession({ dingtalk: fake.service });
    try {
      await initializeDingTalkFixture(fixture);
      writeRequest(fixture.desktopInput, {
        id: 31,
        method: "turn/start",
        params: {
          threadId: "official-thread",
          input: input.map((text) => ({ type: "text", text })),
        },
      });
      await answerOfficialParentCwd(fixture, "official-thread");
      const forwarded = await readJsonLine(fixture.official.stdin);
      answerTurn(fixture, forwarded);
      expect(forwarded.method).toBe("turn/start");
      const items = (forwarded.params as JsonObject).input as JsonObject[];
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toContain("[codexhost DingTalk]");
      expect(items[0]?.text).not.toContain("dingtalk://");
      await fixture.collector.waitFor((message) => requestId(message, 31));
    } finally {
      await stopFixture(fixture);
    }
  });
});
