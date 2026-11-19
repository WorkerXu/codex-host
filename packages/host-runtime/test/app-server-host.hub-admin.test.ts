import { expect, it } from "vitest";
import { HUB_ADMIN_METHOD } from "@codexhost/shared-contracts";
import { HubAdminService } from "../src/hub-admin-service.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

it("serves Hub RPCs without forwarding them and suppresses secret-bearing failures", async () => {
  const hubAdmin = new HubAdminService({
    mcpConnection: { read: async () => "fake-key-not-real", write: async () => {} },
    mcpHeaderName: async () => "Authorization",
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

it("keeps administrator keys out of RPC replies, diagnostics and the official process", async () => {
  const key = "mcphub_fake_admin_credential_1234";
  const hubAdmin = new HubAdminService({
    mcpConnection: {
      read: async () => key,
      write: async () => {
        throw new Error(key);
      },
    },
    mcpHeaderName: async () => "Authorization",
    fetch: async () => Response.json({ success: true, data: [] }),
  });
  const fixture = createFixture({ hubAdmin });
  let diagnostics = "";
  let officialInput = "";
  fixture.diagnosticOutput.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  fixture.official.stdin.on("data", (chunk) => {
    officialInput += String(chunk);
  });
  try {
    await fixture.ready;
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: HUB_ADMIN_METHOD,
      params: { op: "mcpConnection" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 10))).toMatchObject({
      result: { configured: true, last4: "1234" },
    });
    writeRequest(fixture.desktopInput, {
      id: 11,
      method: HUB_ADMIN_METHOD,
      params: { op: "mcpConnect", key },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 11))).toMatchObject({
      error: { message: "failed" },
    });
    expect(JSON.stringify(fixture.collector.messages)).not.toContain(key);
    expect(diagnostics).not.toContain(key);
    expect(officialInput).not.toContain(key);
  } finally {
    await stopFixture(fixture);
  }
});
