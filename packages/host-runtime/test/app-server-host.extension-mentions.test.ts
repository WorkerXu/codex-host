import { formatHostExtensionMentionToken } from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";
import type { HostExtensionManager } from "../src/host-extension-manager.js";
import {
  createFixture,
  readJsonLine,
  requestId,
  requiredMessageId,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const carrier = formatHostExtensionMentionToken({
  extensionId: "mention-sample",
  sourceId: "demo",
  itemId: "alpha",
  label: "Alpha",
});
const input = (text: string) => [{ type: "text", text }];

function manager(expandMentionTexts: (texts: readonly string[]) => Promise<string[]>) {
  return { expandMentionTexts } as unknown as HostExtensionManager;
}

async function initialize(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await fixture.ready;
  writeRequest(fixture.desktopInput, {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "extension-mention-test", version: "1" },
      capabilities: { experimentalApi: true },
    },
  });
  const initializeRequest = await readJsonLine(fixture.official.stdin);
  writeRequest(fixture.official.stdout, {
    id: requiredMessageId(initializeRequest),
    result: { userAgent: "official" },
  });
  await fixture.collector.waitFor((message) => requestId(message, 1));
  expect(await readJsonLine(fixture.official.stdin)).toMatchObject({ method: "initialized" });
}

it("expands mention carriers before forwarding a native Codex Turn", async () => {
  const expandMentionTexts = vi.fn(async (texts: readonly string[]) =>
    texts.map((text) => text.replace(carrier, "expanded alpha")),
  );
  const fixture = createFixture({ hostExtensions: manager(expandMentionTexts) });
  try {
    await initialize(fixture);
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId: "native-thread", input: input(`before ${carrier} after`) },
    });
    const forwarded = await readJsonLine(fixture.official.stdin);
    expect(forwarded).toMatchObject({
      method: "turn/start",
      params: { input: input("before expanded alpha after") },
    });
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(forwarded),
      result: { turn: { id: "native-turn" } },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
      result: { turn: { id: "native-turn" } },
    });
    expect(expandMentionTexts).toHaveBeenCalledWith([`before ${carrier} after`]);
  } finally {
    await stopFixture(fixture);
  }
});

it("rejects a native Turn when expansion fails and never forwards the raw carrier", async () => {
  const fixture = createFixture({
    hostExtensions: manager(async () => {
      throw new Error('extension "mention-sample" is disabled. The message was not sent.');
    }),
  });
  try {
    await initialize(fixture);
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId: "native-thread", input: input(carrier) },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
      error: { code: -32074, message: expect.stringContaining("message was not sent") },
    });
    expect(fixture.official.stdin.readableLength).toBe(0);
  } finally {
    await stopFixture(fixture);
  }
});

it("expands mention carriers for an External Harness Turn", async () => {
  const expandMentionTexts = vi.fn(async (texts: readonly string[]) =>
    texts.map((text) => text.replace(carrier, "expanded alpha")),
  );
  const fixture = createFixture({ hostExtensions: manager(expandMentionTexts) });
  try {
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Missing Fake Session");
    const execute = vi.spyOn(session, "execute");
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: input(`before ${carrier} after`) },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 2));
    expect(response).not.toHaveProperty("error");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn.start",
        input: input("before expanded alpha after"),
      }),
    );
    session.succeedTurn();
  } finally {
    await stopFixture(fixture);
  }
});
