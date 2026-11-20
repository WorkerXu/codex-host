import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { NativeAsyncQuestions, type NativeQuestionReply } from "../src/native-async-questions.js";

const item: JsonObject = {
  type: "agentMessage",
  delivery: "async",
  id: "question",
  questions: [{ title: "Direction?", options: ["Keep", "Replace"] }],
};
const turns: JsonObject[] = [{ id: "turn", status: "inProgress", items: [item] }];

it("shares one async claim across native clients with different public identities", async () => {
  const owner = new NativeAsyncQuestions();
  owner.observeTurns("thread", turns);
  const request = vi.fn(async (method: string): Promise<NativeQuestionReply> =>
    method === "thread/turns/list" ? { result: { data: turns } } : { result: { turnId: "turn" } },
  );
  const replies = ["left:", "right:"].map((prefix) => {
    const pending = owner.pending("thread", prefix)[0];
    if (!pending) throw new Error("Missing question");
    return owner.respond(
      pending.requestId,
      "thread",
      { answers: { [pending.question.id]: { answers: ["Keep"] } } },
      prefix,
      request,
    );
  });
  expect((await Promise.all(replies)).sort()).toEqual([false, true]);
  expect(request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);
  expect(owner.pending("thread", "left:")).toEqual([]);
});

it("drops retired generation identities and reconstructs only from native history", () => {
  const owner = new NativeAsyncQuestions();
  owner.observeTurns("thread", turns);
  const previous = owner.pending("thread", "generation-1:")[0];
  if (!previous) throw new Error("Missing question");
  owner.clear();
  expect(owner.pending("thread", "generation-1:")).toEqual([]);
  owner.observeTurns("thread", turns);
  expect(owner.find(previous.requestId, "generation-2:")).toBeUndefined();
  expect(owner.pending("thread", "generation-2:")).toHaveLength(1);
});
