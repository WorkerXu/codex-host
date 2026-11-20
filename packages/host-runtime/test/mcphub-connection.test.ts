import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpHubConnectionStore,
  MCPHUB_KEY_FILE,
  headerNameFromRouting,
} from "../src/mcphub-connection.js";
import { HubAdminService } from "../src/hub-admin-service.js";

const key = "mcphub_fake_admin_key_only_for_tests_1234";
const replacement = "mcphub_fake_replacement_key_only_5678";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function store() {
  const directory = await mkdtemp(join(tmpdir(), "mcphub-connection-"));
  directories.push(directory);
  return { directory, store: new McpHubConnectionStore({ configDirectory: directory }) };
}
function fixture(
  saved: string | null = key,
  response: () => Response = () => Response.json({ success: true, data: [] }),
) {
  const connection = {
    read: vi.fn(async () => saved),
    write: vi.fn(async (value: string | null) => {
      saved = value;
    }),
  };
  const fetcher = vi.fn(async () => response());
  const header = vi.fn(async () => "X-Mcp-Key");
  const service = new HubAdminService({
    mcpConnection: connection,
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
  it("stores only on the owning Host, replaces atomically with mode 0600 and removes on disconnect", async () => {
    const host = await store();
    const other = await store();
    expect(await host.store.read()).toBeNull();
    await host.store.write(key);
    expect(await host.store.read()).toBe(key);
    expect(await other.store.read()).toBeNull();
    const file = join(host.directory, MCPHUB_KEY_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await chmod(file, 0o644);
    await host.store.write(replacement);
    expect(await readFile(file, "utf8")).toBe(`${replacement}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(host.directory)).toEqual([MCPHUB_KEY_FILE]);
    await host.store.write(null);
    expect(await host.store.read()).toBeNull();
    expect(await readdir(host.directory)).toEqual([]);
  });
  it("rejects invalid disk contents and input without including them in errors", async () => {
    const host = await store();
    const invalid = `${key}\ninjected`;
    await writeFile(join(host.directory, MCPHUB_KEY_FILE), invalid);
    for (const operation of [() => host.store.read(), () => host.store.write(invalid)]) {
      const error = await operation().catch((error: unknown) => error);
      expect(String(error)).not.toContain(key);
    }
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
  it("tests a candidate with a read-only localhost request before saving and never returns it", async () => {
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
    expect(f.connection.write).toHaveBeenCalledWith(replacement);
    expect(f.fetcher.mock.invocationCallOrder[0]).toBeLessThan(
      f.connection.write.mock.invocationCallOrder[0] ?? 0,
    );
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
      expect(f.connection.write).not.toHaveBeenCalled();
      expect(await f.connection.read()).toBe(key);
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
    expect(f.connection.write).toHaveBeenCalledWith(null);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.header).not.toHaveBeenCalled();
  });
  it("never logs a credential-bearing upstream or persistence failure", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const f = fixture();
      f.connection.write.mockRejectedValueOnce(new Error(replacement));
      await expect(f.service.request({ op: "mcpConnect", key: replacement })).rejects.toMatchObject(
        { code: "failed" },
      );
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
