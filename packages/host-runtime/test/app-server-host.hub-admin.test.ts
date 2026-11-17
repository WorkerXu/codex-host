import { expect, it } from "vitest";
import { HUB_ADMIN_METHOD } from "@codexhost/shared-contracts";
import { HubAdminService } from "../src/hub-admin-service.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

it("serves Hub RPCs without forwarding them and suppresses secret-bearing failures", async () => {
  const hubAdmin = new HubAdminService({
    mcpCredentials: async () => ({ Authorization: "secret" }),
    fetch: async () => Response.json({ success: true, data: [] }),
  });
  const fixture = createFixture({ hubAdmin });
  try {
    await fixture.ready;
    writeRequest(fixture.desktopInput, {
      id: 1,
      method: HUB_ADMIN_METHOD,
      params: { op: "servers" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
      result: { servers: [] },
    });
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: HUB_ADMIN_METHOD,
      params: { op: "proxy", url: "http://evil.test" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
      error: { message: "invalid" },
    });
    writeRequest(fixture.desktopInput, { id: 3, method: "codexhost/hub-admin/proxy", params: {} });
    expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
      error: { code: -32601 },
    });
  } finally {
    await stopFixture(fixture);
  }
});
