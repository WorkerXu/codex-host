import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { McpHubConnectionStore, headerNameFromRouting } from "../src/mcphub-connection.js";
import { HubAdminService } from "../src/hub-admin-service.js";

const key = "mcphub_fake_admin_key_only_for_tests_1234";
const replacement = "mcphub_fake_replacement_key_only_5678";
function fixture(
  saved: string | null = key,
  response: () => Response | Promise<Response> = () => Response.json({ success: true, data: [] }),
  environment?: NodeJS.ProcessEnv,
) {
  const connection = new McpHubConnectionStore();
  connection.write(saved);
  const fetcher = vi.fn(async () => response());
  const header = vi.fn(async () => "X-Mcp-Key");
  const service = new HubAdminService({
    mcpConnection: connection,
    ...(environment ? { environment } : {}),
    mcpHeaderName: header,
    fetch: fetcher as typeof fetch,
    remote: {
      endpoints: async () => ({
        memhub: "http://127.0.0.1:8765",
        mcphub: "http://127.0.0.1:3000",
      }),
      token: async () => "",
      forgetToken: async () => {},
      mcphubHeaderName: async () => "X-Mcp-Key",
      stop: async () => {},
    },
  });
  return { connection, fetcher, header, service };
}
describe("Host-local MCPHub key", () => {
  it("uses a Host-local credential without writing it to the user directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcphub-connection-"));
    try {
      const environment = { HOME: home };
      const host = fixture(null, undefined, environment);
      await host.service.request({ op: "mcpConnect", key });
      expect(await readdir(home)).toEqual([]);
      const other = fixture(null, undefined, environment);
      expect(await other.service.request({ op: "mcpConnection" })).toEqual({
        configured: false,
        last4: null,
      });
      await host.service.stop();
      expect(host.connection.read()).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("rejects invalid input without including it in errors", async () => {
    const host = fixture();
    const invalid = `${key}\ninjected`;
    const error = await host.service
      .request({ op: "mcpConnect", key: invalid })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid" });
    expect(String(error)).not.toContain(key);
  });
  it("derives only the native header name and refuses anonymous or disabled Bearer policy", () => {
    expect(headerNameFromRouting({ bearerAuthHeaderName: "X-Mcp-Key" })).toBe("X-Mcp-Key");
    expect(headerNameFromRouting({})).toBe("Authorization");
    for (const routing of [
      { skipAuth: true },
      { enableBearerAuth: false },
      { bearerAuthHeaderName: "Bad\nName" },
    ]) {
      expect(() => headerNameFromRouting(routing)).toThrow();
    }
  });
});
describe("MCPHub connection RPCs", () => {
  it("reports only configured and the final four characters, without contacting MCPHub", async () => {
    const f = fixture();
    expect(await f.service.request({ op: "mcpConnection" })).toEqual({
      configured: true,
      last4: "1234",
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.header).not.toHaveBeenCalled();
    const empty = fixture(null);
    expect(await empty.service.request({ op: "mcpConnection" })).toEqual({
      configured: false,
      last4: null,
    });
    await expect(empty.service.request({ op: "servers" })).rejects.toMatchObject({
      code: "mcp-auth",
    });
    expect(empty.fetcher).not.toHaveBeenCalled();
  });
  it("tests a candidate with a read-only localhost request before accepting and never returns it", async () => {
    const f = fixture();
    expect(await f.service.request({ op: "mcpConnect", key: replacement })).toEqual({
      configured: true,
      last4: "5678",
    });
    expect(f.fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/auth/keys",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { "X-Mcp-Key": `Bearer ${replacement}`, "content-type": "application/json" },
      }),
    );
    expect(f.connection.read()).toBe(replacement);
    expect(JSON.stringify(await f.service.request({ op: "mcpConnection" }))).not.toContain(
      replacement,
    );
  });
  it.each([401, 403, 500, 200])(
    "keeps the old key after an invalid test response (%s) and redacts errors",
    async (status) => {
      const f = fixture(key, () =>
        Response.json({ token: replacement, error: replacement }, { status }),
      );
      const error = await f.service
        .request({ op: "mcpConnect", key: replacement })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: status === 401 ? "mcp-key-invalid" : status === 403 ? "mcp-key-scoped" : "failed",
      });
      expect(String(error)).not.toContain(replacement);
      expect(f.connection.read()).toBe(key);
    },
  );
  it("disconnects even if the service/key is unavailable, without contacting it", async () => {
    const f = fixture();
    await expect(f.service.request({ op: "mcpDisconnect" })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await f.service.request({ op: "mcpDisconnect", confirmed: true })).toEqual({
      configured: false,
      last4: null,
    });
    expect(f.connection.read()).toBeNull();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.header).not.toHaveBeenCalled();
  });
  it("never logs a credential-bearing upstream failure", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const f = fixture(key, () => {
        throw new Error(replacement);
      });
      await expect(f.service.request({ op: "mcpConnect", key: replacement })).rejects.toMatchObject(
        { code: "connection" },
      );
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

it("does not reconnect when candidate validation finishes after disconnect", async () => {
  const started = Promise.withResolvers<undefined>();
  const reply = Promise.withResolvers<Response>();
  const { service } = fixture(key, () => {
    started.resolve(undefined);
    return reply.promise;
  });
  const connect = service.request({ op: "mcpConnect", key: replacement });
  await started.promise;
  await service.request({ op: "mcpDisconnect", confirmed: true });
  reply.resolve(Response.json({ success: true, data: [] }));
  await expect(connect).rejects.toMatchObject({ code: "conflict" });
  await expect(service.request({ op: "mcpConnection" })).resolves.toMatchObject({
    configured: false,
  });
});
