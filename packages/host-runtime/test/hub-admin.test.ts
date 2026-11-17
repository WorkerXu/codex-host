import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HubAdminService } from "../src/hub-admin-service.js";
import { mcphubCredentials, parseHubEnvironment } from "../src/hub-admin-credentials.js";
import { HubAdminError, hubJson } from "../src/hub-admin-http.js";

const secret = "test-secret-that-must-not-leak";
const success = (data?: unknown) => Response.json({ success: true, data });
function service(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init),
  );
  return {
    fetcher,
    service: new HubAdminService({
      fetch: fetcher as typeof fetch,
      mcpCredentials: async () => ({ "x-auth-token": secret }),
      memoryCredentials: async () => ({ Authorization: secret }),
    }),
  };
}
describe("Hub admin boundary", () => {
  it.each([
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
      expect(init?.headers).toMatchObject({ "x-auth-token": secret });
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
    [401, "forbidden"],
    [403, "forbidden"],
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
describe("Host-local credentials", () => {
  const settings = {
    users: [{ username: "admin", password: "hash", isAdmin: true }],
    bearerKeys: [],
  };
  it("signs short-lived JWTs with the native session version and keeps credentials local", async () => {
    const read = vi.fn(async (path: string) =>
      path === "/etc/mcphub.env"
        ? `JWT_SECRET='${secret}'\nMCPHUB_SETTING_PATH=/data/settings.json`
        : JSON.stringify(settings),
    );
    const headers = await mcphubCredentials(read);
    const token = headers["x-auth-token"]!;
    const [header, body, signature] = token.split(".");
    expect(signature).toBe(
      createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url"),
    );
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
    expect(payload.exp - payload.iat).toBe(60);
    expect(payload.user.sessionVersion).toMatch(/^[a-f0-9]{64}$/u);
    expect(token).not.toContain(secret);
    expect(read).toHaveBeenLastCalledWith("/data/settings.json");
  });
  it("stops at password hashes instead of inventing a JWT secret", async () => {
    await expect(
      mcphubCredentials(async (path) =>
        path === "/etc/mcphub.env" ? "PORT=3000" : JSON.stringify(settings),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("uses only plaintext system all-access keys when available", async () => {
    expect(
      await mcphubCredentials(async (path) =>
        path === "/etc/mcphub.env"
          ? "PORT=3000"
          : JSON.stringify({
              ...settings,
              bearerKeys: [{ enabled: true, accessType: "all", token: secret }],
            }),
      ),
    ).toEqual({ Authorization: `Bearer ${secret}` });
    expect(
      parseHubEnvironment('# x\nPORT=3000\nINVALID\nJWT_SECRET="literal $value"'),
    ).toMatchObject({ PORT: "3000", JWT_SECRET: "literal $value" });
  });
});
