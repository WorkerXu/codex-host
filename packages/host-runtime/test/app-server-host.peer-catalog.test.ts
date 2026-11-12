import { expect, it, vi } from "vitest";

import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

it("serves the peer catalog to the Renderer", async () => {
  const listPeers = vi.fn(async () => ({
    peers: [
      {
        name: "oracle-sg",
        hostIds: ["remote-ssh-discovered:oracle"],
        state: "ready" as const,
        harnesses: ["codex", "grok"],
      },
    ],
    self: { hostIds: ["remote-ssh-discovered:self"] },
  }));
  const fixture = createFixture({ delegationPeers: { listPeers } });
  try {
    await fixture.ready;
    writeRequest(fixture.desktopInput, {
      id: 990,
      method: "codexhost/delegation/peers/list",
      params: { refresh: true },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 990))).toMatchObject({
      result: {
        peers: [{ name: "oracle-sg", state: "ready", harnesses: ["codex", "grok"] }],
        self: { hostIds: ["remote-ssh-discovered:self"] },
      },
    });
    expect(listPeers).toHaveBeenCalledWith({ refresh: true });
  } finally {
    await stopFixture(fixture);
  }
});
