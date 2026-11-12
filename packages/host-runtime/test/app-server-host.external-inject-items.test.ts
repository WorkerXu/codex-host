import { describe, expect, it, vi } from "vitest";

import {
  createFixture,
  requestId,
  startPiThread,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

const BOUNDARY = "Side conversation boundary.\n\nInherited history is reference only.";

describe("External Thread thread/inject_items", () => {
  it("accepts injected items and prefixes them to the next Harness Turn only", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, {
      id: 30,
      method: "thread/inject_items",
      params: {
        threadId,
        items: [
          { type: "message", role: "user", content: [{ type: "input_text", text: BOUNDARY }] },
        ],
      },
    });
    const injected = await fixture.collector.waitFor((message) => requestId(message, 30));
    expect(injected.error).toBeUndefined();
    expect(injected.result).toEqual({});

    const sendTurn = async (id: number, text: string): Promise<string> => {
      writeRequest(fixture.desktopInput, {
        id,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text }] },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, id));
      const turnId = (response.result as { turn: { id: string } }).turn.id;
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      return turnId;
    };

    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const execute = vi.spyOn(session, "execute");

    const first = await sendTurn(31, "question one");
    session.appendText("a");
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", first));
    await sendTurn(32, "question two");

    const texts = execute.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === "turn.start")
      .map((command) => (command.type === "turn.start" ? command.input[0]?.text : undefined));
    expect(texts[0]).toBe(`${BOUNDARY}\n\n---\n\nquestion one`);
    expect(texts[1]).toBe("question two");
    await stopFixture(fixture);
  });

  it("rejects malformed items", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, {
      id: 40,
      method: "thread/inject_items",
      params: { threadId, items: "nope" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 40)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    await stopFixture(fixture);
  });
});
