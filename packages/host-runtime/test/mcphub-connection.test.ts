import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpHubConnectionStore, headerNameFromRouting } from "../src/mcphub-connection.js";
import { HubAdminService } from "../src/hub-admin-service.js";

const key = "mcphub_fake_admin_key_only_for_tests_1234";
const replacement = "mcphub_fake_replacement_key_only_5678";
let home: string;
const configDirectory = () => join(home, ".config", "codexhost");
const keyFile = () => join(configDirectory(), "mcphub-admin-key");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mcphub-connection-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function createService(
  response: () => Response | Promise<Response> = () => Response.json({ success: true, data: [] }),
) {
  const fetcher = vi.fn(async () => response());
  const header = vi.fn(async () => "X-Mcp-Key");
  const service = new HubAdminService({
    environment: { HOME: home, CODEXHOST_DATA_DIR: join(home, "runtime-data") },
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
  return { fetcher, header, service };
}

async function fixture(saved: string | null = key, response?: () => Response | Promise<Response>) {
  const connection = new McpHubConnectionStore({ environment: { HOME: home } });
  await connection.write(saved);
  return { connection, ...createService(response) };
}
describe("Host-local MCPHub key", () => {
  it("uses the fork credential file across Host restarts", async () => {
    await mkdir(configDirectory(), { recursive: true });
    await writeFile(keyFile(), `${key}\n`, { mode: 0o600 });
    const first = createService();
    await expect(first.service.request({ op: "mcpConnection" })).resolves.toEqual({
      configured: true,
      last4: "1234",
    });
    await first.service.stop();

    const restarted = createService();
    await expect(restarted.service.request({ op: "servers" })).resolves.toEqual({ servers: [] });
    expect(restarted.fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/servers",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Mcp-Key": `Bearer ${key}` }),
      }),
    );
  });

  it.skipIf(process.platform === "win32")(
    "atomically replaces the credential with mode 0600",
    async () => {
      const { connection } = await fixture();
      await chmod(keyFile(), 0o644);
      const previous = await open(keyFile(), "r");
      try {
        await connection.write(replacement);
        expect(await previous.readFile("utf8")).toBe(`${key}\n`);
        expect(await connection.read()).toBe(replacement);
        expect((await lstat(keyFile())).mode & 0o777).toBe(0o600);
        expect(await readdir(configDirectory())).toEqual(["mcphub-admin-key"]);
      } finally {
        await previous.close();
      }
    },
  );

  it("redacts malformed keys from input and disk errors", async () => {
    const host = await fixture();
    const invalid = `${key}\ninjected`;
    const submitError = await host.service
      .request({ op: "mcpConnect", key: invalid })
      .catch((error: unknown) => error);
    expect(submitError).toMatchObject({ code: "invalid" });
    expect(String(submitError)).not.toContain(key);
    await writeFile(keyFile(), invalid);
    const readError = await host.service
      .request({ op: "mcpConnection" })
      .catch((error: unknown) => error);
    expect(readError).toMatchObject({ code: "failed" });
    expect(String(readError)).not.toContain(key);
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
it("clears the file when removal is requested during replacement", async () => {
  const { connection } = await fixture();
  await Promise.all([connection.write(replacement), connection.write(null)]);
  await expect(lstat(keyFile())).rejects.toMatchObject({ code: "ENOENT" });
});

describe("MCPHub connection RPCs", () => {
  it("reports only configured and the final four characters, without contacting MCPHub", async () => {
    const f = await fixture();
    expect(await f.service.request({ op: "mcpConnection" })).toEqual({
      configured: true,
      last4: "1234",
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.header).not.toHaveBeenCalled();
    const empty = await fixture(null);
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
    const started = Promise.withResolvers<undefined>();
    const reply = Promise.withResolvers<Response>();
    const f = await fixture(key, () => {
      started.resolve(undefined);
      return reply.promise;
    });
    const connect = f.service.request({ op: "mcpConnect", key: replacement });
    await started.promise;
    try {
      expect(await f.connection.read()).toBe(key);
    } finally {
      reply.resolve(Response.json({ success: true, data: [] }));
    }
    await expect(connect).resolves.toEqual({ configured: true, last4: "5678" });
    expect(f.fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/auth/keys",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { "X-Mcp-Key": `Bearer ${replacement}`, "content-type": "application/json" },
      }),
    );
    expect(await f.connection.read()).toBe(replacement);
    expect(JSON.stringify(await f.service.request({ op: "mcpConnection" }))).not.toContain(
      replacement,
    );
  });
  it.each([401, 403, 500, 200])(
    "keeps the old key after an invalid test response (%s) and redacts errors",
    async (status) => {
      const f = await fixture(key, () =>
        Response.json({ token: replacement, error: replacement }, { status }),
      );
      const error = await f.service
        .request({ op: "mcpConnect", key: replacement })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: status === 401 ? "mcp-key-invalid" : status === 403 ? "mcp-key-scoped" : "failed",
      });
      expect(String(error)).not.toContain(replacement);
      expect(await f.connection.read()).toBe(key);
    },
  );
  it("disconnects even if the service/key is unavailable, without contacting it", async () => {
    const f = await fixture();
    await expect(f.service.request({ op: "mcpDisconnect" })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await f.service.request({ op: "mcpDisconnect", confirmed: true })).toEqual({
      configured: false,
      last4: null,
    });
    await expect(lstat(keyFile())).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.header).not.toHaveBeenCalled();
  });
  it("never logs a credential-bearing upstream failure", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const f = await fixture(key, () => {
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
  const { service } = await fixture(key, () => {
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
