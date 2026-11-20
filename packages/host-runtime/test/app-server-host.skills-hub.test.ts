import { describe, expect, it, vi } from "vitest";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

describe("skills settings RPC", () => {
  it("serves skills locally without forwarding requests to official Codex", async () => {
    const request = vi.fn(async (params: unknown) => {
      if ((params as { op: string }).op === "status") return { machines: [] };
      throw new Error("stale_plan");
    });
    const fixture = createFixture({ skillsHub: { request } });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/skills/request",
        params: { op: "status" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        result: { machines: [] },
      });
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/skills/request",
        params: { op: "link-apply" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        error: { code: -32096, message: "stale_plan" },
      });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await stopFixture(fixture);
    }
  });
});
