import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

const CARRIER =
  "[@罗浩](dingtalk://conversation/cidMEIJUjvADnZ1q2%2Bb0sYR4IrcWmDHAZ0entfYBmblz5A%3D) 最新的一条消息是什么";

function fakeDingTalk() {
  const expandMentions = vi.fn(async (text: string) => {
    if (!text.includes("dingtalk://")) return text;
    return `${text.replace(/\[@罗浩\]\s*\([^)]*\)/u, "@罗浩")}\n\n[codexhost DingTalk]\n单聊「罗浩」`;
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

async function forwardedRequest(fixture: ReturnType<typeof createFixture>): Promise<JsonObject> {
  return await new Promise<JsonObject>((resolve) => {
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.once("data", (chunk: string) => {
      resolve(JSON.parse(chunk.trim()) as JsonObject);
    });
  });
}

function answerTurn(fixture: ReturnType<typeof createFixture>, id: number): void {
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
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 30,
        method: "turn/start",
        params: {
          threadId: "official-thread",
          input: [{ type: "text", text: CARRIER }],
        },
      });
      const forwarded = await forwardedRequest(fixture);
      const text = (forwarded.params as JsonObject).input as JsonObject[];
      expect(text[0]?.text).toContain("[codexhost DingTalk]");
      expect(text[0]?.text).not.toContain("dingtalk://");
      expect(fake.expandMentions).toHaveBeenCalledOnce();
      answerTurn(fixture, 30);
      await fixture.collector.waitFor((message) => requestId(message, 30));
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([
    {
      name: "a newline between the label and target",
      input: [`[@罗浩]\n(dingtalk://conversation/cidWithNewline%3D%3D) 最新的一条消息是什么`],
    },
    {
      name: "adjacent text items split after the label",
      input: ["[@罗浩]", "(dingtalk://conversation/cidSplit%3D%3D) 最新的一条消息是什么"],
    },
  ])("expands $name", async ({ input }) => {
    const fake = fakeDingTalk();
    const fixture = remoteListenerSession({ dingtalk: fake.service });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 31,
        method: "turn/start",
        params: {
          threadId: "official-thread",
          input: input.map((text) => ({ type: "text", text })),
        },
      });
      const forwarded = await forwardedRequest(fixture);
      const items = (forwarded.params as JsonObject).input as JsonObject[];
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toContain("[codexhost DingTalk]");
      expect(items[0]?.text).not.toContain("dingtalk://");
      answerTurn(fixture, 31);
      await fixture.collector.waitFor((message) => requestId(message, 31));
    } finally {
      await stopFixture(fixture);
    }
  });
});
