import { expect, it, vi } from "vitest";

const { requestDesktopRemoteConnections } = vi.hoisted(() => ({
  requestDesktopRemoteConnections: vi.fn(),
}));
vi.mock("@codexhost/desktop-control", () => ({ requestDesktopRemoteConnections }));
import { readRemoteDelegationThread } from "../src/remote-delegation-read.js";

it("preserves remote pending Questions and does not invent support for older Hosts", async () => {
  const snapshot = {
    threadId: "thread",
    harnessId: "codex",
    status: "running",
    turn: null,
    progress: [],
    result: { availability: "pending" },
    nextCursor: null,
  };
  const pendingQuestions = [
    {
      interactionId: "opaque",
      kind: "requestUserInputAsync",
      turnId: "turn",
      request: { title: "Direction?", options: ["Keep"], nativeExtension: true },
    },
  ];
  requestDesktopRemoteConnections.mockResolvedValueOnce({
    result: { ...snapshot, pendingQuestions },
  });
  const input = { hostId: "remote", threadId: "thread", view: "result" as const };
  expect(await readRemoteDelegationThread({}, input)).toMatchObject({
    hostId: "remote",
    pendingQuestions,
  });
  requestDesktopRemoteConnections.mockResolvedValueOnce({ result: snapshot });
  expect(await readRemoteDelegationThread({}, input)).not.toHaveProperty("pendingQuestions");
});
