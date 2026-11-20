import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpHubConnectionStore } from "../src/mcphub-connection.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HUB_ADMIN_METHOD, SKILLS_HUB_METHOD } from "@codexhost/shared-contracts";
import { HubAdminService } from "../src/hub-admin-service.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

let configDirectory: string;
beforeEach(async () => {
  configDirectory = await mkdtemp(join(tmpdir(), "desktop-hub-admin-"));
});
afterEach(async () => {
  await rm(configDirectory, { recursive: true, force: true });
});

it("serves Hub RPCs without forwarding them and suppresses secret-bearing failures", async () => {
  const connection = new McpHubConnectionStore({ configDirectory });
  await connection.write("fake-key-not-real");
  const hubAdmin = new HubAdminService({
    mcpConnection: connection,
    mcpHeaderName: async () => "Authorization",
    fetch: async () => Response.json({ success: true, data: [] }),
    remote: {
      endpoints: async () => ({
        memhub: "http://127.0.0.1:8765",
        mcphub: "http://127.0.0.1:3000",
      }),
      token: async () => "",
      forgetToken: async () => {},
      mcphubHeaderName: async () => "Authorization",
      stop: async () => {},
    },
  });
  const fixture = createFixture({ desktopHubs: { admin: hubAdmin } });
  try {
    await fixture.ready;
    await expect(
      fixture.host.handleClientRequest(HUB_ADMIN_METHOD, { op: "servers" }),
    ).resolves.toMatchObject({ error: { code: -32601 } });
    await expect(
      fixture.host.handleClientRequest(SKILLS_HUB_METHOD, { op: "hosts" }),
    ).resolves.toMatchObject({ error: { code: -32601 } });
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
  const connection = new McpHubConnectionStore({ configDirectory });
  await connection.write(key);
  const hubAdmin = new HubAdminService({
    mcpConnection: connection,
    mcpHeaderName: async () => "Authorization",
    fetch: async () => {
      throw new Error(key);
    },
    remote: {
      endpoints: async () => ({
        memhub: "http://127.0.0.1:8765",
        mcphub: "http://127.0.0.1:3000",
      }),
      token: async () => "",
      forgetToken: async () => {},
      mcphubHeaderName: async () => "Authorization",
      stop: async () => {},
    },
  });
  const fixture = createFixture({ desktopHubs: { admin: hubAdmin } });
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
      error: { message: "connection" },
    });
    expect(JSON.stringify(fixture.collector.messages)).not.toContain(key);
    expect(diagnostics).not.toContain(key);
    expect(officialInput).not.toContain(key);
  } finally {
    await stopFixture(fixture);
  }
});
