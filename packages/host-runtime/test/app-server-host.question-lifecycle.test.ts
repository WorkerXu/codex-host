import { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";
import type { DelegationControlApi } from "../src/delegation-types.js";
import {
  createFixture,
  method,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("Question and native Turn lifecycle boundaries", () => {
  it("rejects a stale answer after a Thread releases and resumes its Session", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (value) => {
        api = value;
        return undefined;
      },
    });
    try {
      const threadId = await startPiThread(fixture);
      const firstTurn = await startPiTurn(fixture, threadId);
      const first = fixture.adapter.sessions[0];
      if (!first || !api) throw new Error("Missing delegation fixture");
      const question = {
        id: "value",
        type: "text" as const,
        prompt: "Value?",
        multiline: false,
        optional: false,
        secret: false,
      };
      const nativeId = first.askQuestion(question);
      await fixture.collector.waitFor((m) => method(m, "item/tool/requestUserInput"));
      const oldId = (await api.read({ threadId, view: "result" })).pendingQuestions?.[0]
        ?.interactionId;
      if (!oldId) throw new Error("Missing original Question");
      await api.answer({
        threadId,
        interactionId: oldId,
        result: { answers: { value: { answers: ["first answer"] } } },
      });
      first.succeedTurn();
      await fixture.collector.waitFor((m) => turnEvent(m, "turn/completed", firstTurn));
      const snapshot = await first.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const close = vi.spyOn(first, "close");
      const open = fixture.adapter.open.bind(fixture.adapter);
      let resumed: FakeHarnessSession | undefined;
      vi.spyOn(fixture.adapter, "open").mockImplementation(async (input) => {
        if (input.kind !== "resume") return open(input);
        resumed = new FakeHarnessSession(
          fixture.adapter.harnessId,
          fixture.adapter.catalog,
          undefined,
          input.nativeRef,
          snapshot.value,
        );
        return { ok: true, value: resumed };
      });
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((m) => requestId(m, 900));
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      const secondTurn = await startPiTurn(fixture, threadId, 902);
      if (!resumed) throw new Error("Session was not resumed");
      expect(resumed.askQuestion(question)).toBe(nativeId);
      await fixture.collector.waitFor(
        (m) =>
          method(m, "item/tool/requestUserInput") && (m.params as JsonObject).turnId === secondTurn,
      );
      await expect(
        api.answer({
          threadId,
          interactionId: oldId,
          result: { answers: { value: { answers: ["stale first answer"] } } },
        }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
      expect(resumed.interactionResponses).toEqual([]);
      const newId = (await api.read({ threadId, view: "result" })).pendingQuestions?.[0]
        ?.interactionId;
      if (!newId) throw new Error("Missing resumed Question");
      expect(newId).not.toBe(oldId);
      await expect(
        api.answer({
          threadId,
          interactionId: newId,
          result: { answers: { value: { answers: ["new answer"] } } },
        }),
      ).resolves.toMatchObject({ turnId: secondTurn });
      expect(resumed.interactionResponses).toMatchObject([
        { interactionId: nativeId, response: { answers: { value: ["new answer"] } } },
      ]);
    } finally {
      await stopFixture(fixture);
      vi.useRealTimers();
    }
  });
});
