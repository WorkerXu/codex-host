import { McpHubConnectionStore } from "../src/mcphub-connection.js";
import { describe, expect, it, vi } from "vitest";
import { HubAdminService } from "../src/hub-admin-service.js";
import { HubAdminError, hubJson } from "../src/hub-admin-http.js";

const secret = "test-secret-that-must-not-leak";
const success = (data?: unknown) => Response.json({ success: true, data });
function service(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  saved: string | null = secret,
) {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init),
  );
  const connection = new McpHubConnectionStore();
  connection.write(saved);
  return {
    fetcher,
    connection,
    service: new HubAdminService({
      fetch: fetcher as typeof fetch,
      mcpConnection: connection,
      mcpHeaderName: async () => "X-Test-Key",
      memoryToken: async () => secret,
      forgetMemoryToken: async () => {},
      remote: {
        endpoints: async () => ({
          memhub: "http://127.0.0.1:8765",
          mcphub: "http://127.0.0.1:3000",
        }),
        token: async () => secret,
        forgetToken: async () => {},
        mcphubHeaderName: async () => "Authorization",
        stop: async () => {},
      },
    }),
  };
}
describe("Hub admin boundary", () => {
  it.each([
    { op: "serverDelete", name: "..", confirmed: true },
    { op: "keyDelete", id: ".", confirmed: true },
    { op: "proxy", url: "http://evil.test" },
    { op: "servers", url: "http://evil.test" },
    { op: "serverDelete", name: "x" },
    { op: "keyDelete", id: "x", confirmed: false },
    { op: "keyRegenerate", id: "x" },
    { op: "serverToggle", name: "x", enabled: false, confirmed: false },
    { op: "authSave", enabled: false, headerName: "Authorization", confirmed: false },
    { op: "memory", id: "x", kind: "chat", variant: null, method: "DELETE" },
    { op: "search", query: "x", source: "", offset: -1 },
  ])("rejects operations outside the allowlist before HTTP: %j", async (input) => {
    const fixture = service(() => success());
    await expect(fixture.service.request(input)).rejects.toMatchObject({ code: "invalid" });
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });
  it("projects servers and keys without secret fields", async () => {
    const fixture = service((url) =>
      url.endsWith("/servers")
        ? success([
            {
              name: "a",
              status: "connected",
              enabled: false,
              version: "1",
              config: { type: "sse", url: secret, env: { TOKEN: secret } },
              tools: [{ name: "t" }],
              prompts: [],
              resources: [],
              error: secret,
            },
          ])
        : url.endsWith("/auth/keys")
          ? success([
              {
                id: "1",
                name: "key",
                enabled: true,
                accessType: "all",
                token: secret,
                tokenHash: secret,
              },
            ])
          : success({
              systemConfig: {
                routing: {
                  enableBearerAuth: false,
                  bearerAuthHeaderName: "X-Key",
                  bearerAuthKey: secret,
                },
                smartRouting: { llmProviderApiKey: secret },
              },
              users: [{ password: secret }],
            }),
    );
    expect(await fixture.service.request({ op: "servers" })).toMatchObject({
      servers: [{ status: "disabled", tools: 1, calls: null }],
    });
    const keys = await fixture.service.request({ op: "keys" });
    expect(keys).toMatchObject({ enabled: false, keys: [{ masked: "••••••••" }] });
    expect(JSON.stringify(keys)).not.toContain(secret);
    for (const [url, init] of fixture.fetcher.mock.calls) {
      expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:3000\/api\//u);
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ "X-Test-Key": `Bearer ${secret}` });
    }
  });
  it("preserves native config and secrets during edits and percent-encodes names", async () => {
    const fixture = service((_url, init) =>
      init?.method === "GET"
        ? success({
            config: {
              type: "sse",
              url: "http://local.test",
              headers: { Token: secret },
              options: { timeout: 1000 },
              owner: "admin",
            },
          })
        : success(),
    );
    await fixture.service.request({
      op: "serverSave",
      originalName: "a/b",
      input: { name: "a/b", type: "sse" },
    });
    expect(fixture.fetcher.mock.calls[1]?.[0]).toBe("http://127.0.0.1:3000/api/servers/a%2Fb");
    expect(JSON.parse(fixture.fetcher.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      config: { headers: { Token: secret }, options: { timeout: 1000 }, owner: "admin" },
    });
  });
  it("sends only routing auth fields and returns a newly issued token once", async () => {
    const fixture = service(() => success({ token: secret, tokenHash: "hash" }));
    expect(
      await fixture.service.request({ op: "keyRegenerate", id: "a", confirmed: true }),
    ).toEqual({ ok: true, token: secret });
    await fixture.service.request({
      op: "authSave",
      enabled: false,
      headerName: "X-Key",
      confirmed: true,
    });
    expect(JSON.parse(fixture.fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({
      routing: { enableBearerAuth: false, bearerAuthHeaderName: "X-Key" },
    });
  });
  it("refuses to rewrite scopes the editor cannot represent", async () => {
    const fixture = service(() =>
      success([
        { id: "1", name: "group", enabled: true, accessType: "exclude", excludedGroups: ["g"] },
      ]),
    );
    await expect(
      fixture.service.request({
        op: "keySave",
        id: "1",
        input: { name: "x", enabled: true, accessType: "all", servers: [] },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fixture.fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps MemHub reads on localhost and preserves search window and namespace", async () => {
    const memory = {
      memory_id: "a/b",
      content: "记忆正文",
      source: "codex",
      updated_at: 42,
      session_id: "conversation",
      kind: "experience",
      variant: "coding",
    };
    const fixture = service((url) =>
      url.includes("memory-library")
        ? Response.json({ total: 20, offset: 10, window_id: "window", memories: [memory] })
        : Response.json(memory),
    );
    expect(
      await fixture.service.request({
        op: "search",
        query: "x&user_id=other",
        source: "codex",
        offset: 10,
        windowId: "window",
      }),
    ).toMatchObject({
      total: 20,
      offset: 10,
      windowId: "window",
      memories: [{ conversation: "conversation" }],
    });
    await fixture.service.request({
      op: "memory",
      id: "a/b",
      kind: "experience",
      variant: "coding",
    });
    expect(String(fixture.fetcher.mock.calls[0]?.[0])).toContain("query=x%26user_id%3Dother");
    expect(fixture.fetcher.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:8765/api/v2/memories/a%2Fb?kind=experience&variant=coding",
    );
    for (const [, init] of fixture.fetcher.mock.calls) expect(init?.method).toBe("GET");
  });
  it("never reflects upstream error bodies or schema error values", async () => {
    for (const response of [
      Response.json({ error: secret }, { status: 500 }),
      success({ token: secret }),
    ]) {
      const fixture = service(() => response);
      const error = await fixture.service
        .request({ op: "servers" })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(HubAdminError);
      expect(String(error)).not.toContain(secret);
    }
  });
  it.each([
    [401, "mcp-auth"],
    [403, "mcp-auth"],
    [404, "missing"],
    [409, "conflict"],
  ])("maps HTTP %s", async (status, code) => {
    const fixture = service(() => new Response(secret, { status: Number(status) }));
    await expect(fixture.service.request({ op: "servers" })).rejects.toMatchObject({ code });
  });
  it.each([
    [new DOMException(secret, "TimeoutError"), "连接超时"],
    [new TypeError(secret, { cause: { code: "ECONNREFUSED" } }), "服务未运行"],
    [new Error(secret), "连接失败"],
  ])("maps network errors without details", async (error, message) => {
    await expect(
      hubJson(
        vi.fn(async () => {
          throw error;
        }) as typeof fetch,
        "http://127.0.0.1:3000",
        "/api/servers",
        {},
      ),
    ).rejects.toThrow(String(message));
  });
});

describe("MemHub token rotation", () => {
  function rotated() {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValue(Response.json({ memories: [], total: 0, offset: 0, window_id: null }));
    const memoryToken = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    const forgetMemoryToken = vi.fn(async () => {});
    const service = new HubAdminService({
      fetch: fetcher as typeof fetch,
      memoryToken,
      forgetMemoryToken,
      remote: {
        endpoints: async () => ({
          memhub: "http://127.0.0.1:8765",
          mcphub: "http://127.0.0.1:3000",
        }),
        token: memoryToken,
        forgetToken: forgetMemoryToken,
        mcphubHeaderName: async () => "Authorization",
        stop: async () => {},
      },
    });
    return { service, fetcher, memoryToken, forgetMemoryToken };
  }
  it("re-reads the token once after a 401 and retries", async () => {
    const fixture = rotated();
    await expect(
      fixture.service.request({ op: "search", query: "", source: "", offset: 0 }),
    ).resolves.toEqual({ memories: [], total: 0, offset: 0, windowId: null });
    expect(fixture.memoryToken).toHaveBeenCalledTimes(2);
    expect(fixture.forgetMemoryToken).toHaveBeenCalledTimes(1);
    const headers = fixture.fetcher.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>).Authorization,
    );
    expect(headers).toEqual(["Bearer old", "Bearer new"]);
  });
});

describe("MCP page overview", () => {
  it("returns the connection, servers and keys in one request", async () => {
    const f = service((url) =>
      url.endsWith("/servers") || url.endsWith("/auth/keys")
        ? success([])
        : success({ systemConfig: { routing: {} } }),
    );
    await expect(f.service.request({ op: "mcpOverview" })).resolves.toMatchObject({
      configured: true,
      last4: secret.slice(-4),
      servers: [],
      keys: { headerName: "Authorization", keys: [] },
    });
    expect(f.fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("MCP connection state", () => {
  it("reports a never-connected Host without contacting MCPHub", async () => {
    const f = service(() => success(), null);
    await expect(f.service.request({ op: "mcpOverview" })).resolves.toEqual({
      configured: false,
      last4: null,
      servers: null,
      keys: null,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("rejects a 401 key as incorrect and does not store it", async () => {
    const f = service(() => new Response("", { status: 401 }), null);
    await expect(
      f.service.request({ op: "mcpConnect", key: "mcphub_fake_candidate_1234" }),
    ).rejects.toMatchObject({ code: "mcp-key-invalid" });
    expect(f.connection.read()).toBeNull();
  });

  it("rejects a scoped key with the all-access message", async () => {
    const f = service(
      () => new Response("this is not a system-level all-access key", { status: 403 }),
      null,
    );
    await expect(
      f.service.request({ op: "mcpConnect", key: "mcphub_fake_candidate_1234" }),
    ).rejects.toMatchObject({ code: "mcp-key-scoped" });
    expect(f.connection.read()).toBeNull();
  });

  it("keeps the stored-key failure path distinct from a new connection", async () => {
    const f = service(() => new Response("", { status: 401 }));
    await expect(f.service.request({ op: "servers" })).rejects.toMatchObject({
      code: "mcp-auth",
    });
  });
});
