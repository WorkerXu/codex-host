import { expect, it, vi } from "vitest";
import { HUB_ADMIN_METHOD } from "@codexhost/shared-contracts";
import { createRendererHubAdminClient, hubErrorText } from "../src/renderer-hub-admin-client.js";
it("routes each call through the selected host and never falls back to local", async () => {
  const sendRequest = vi.fn(async () => ({ servers: [] }));
  const forHost = vi.fn((id: string) =>
    id === "ssh:oracle-main" ? { manager: { sendRequest } } : null,
  );
  const client = createRendererHubAdminClient({
    forHost,
    listHosts: async () => [{ hostId: "ssh:oracle-main", displayName: "oracle-main" }],
  });
  await expect(client.request("ssh:oracle-main", { op: "servers" })).resolves.toEqual({
    servers: [],
  });
  expect(sendRequest).toHaveBeenCalledWith(
    HUB_ADMIN_METHOD,
    { op: "servers" },
    { priority: "interactive", timeoutMs: 30000 },
  );
  await expect(client.request("oracle-main", { op: "overview" })).rejects.toThrow("connection");
  expect(sendRequest).toHaveBeenCalledTimes(1);
  expect(forHost.mock.calls.map(([id]) => id)).toEqual(["ssh:oracle-main", "oracle-main"]);
});
it("localizes stable codes and hides raw errors", () => {
  expect(hubErrorText(new Error("forbidden"))).toBe("无权限");
  expect(hubErrorText(new Error("timeout"))).toBe("连接超时");
  expect(hubErrorText(new Error("secret in upstream error"))).toBe("连接失败");
});
it("sends a candidate only to the selected Host and rejects credential-bearing responses", async () => {
  const key = "mcphub_fake_candidate_1234";
  const sendRequest = vi.fn(async () => ({ configured: true, last4: "1234" }));
  const forHost = vi.fn(() => ({ manager: { sendRequest } }));
  const client = createRendererHubAdminClient({ forHost, listHosts: async () => [] });
  expect(await client.request("oracle-main", { op: "mcpConnect", key })).toEqual({
    configured: true,
    last4: "1234",
  });
  expect(forHost).toHaveBeenCalledWith("oracle-main");
  expect(sendRequest).toHaveBeenCalledWith(
    HUB_ADMIN_METHOD,
    { op: "mcpConnect", key },
    expect.anything(),
  );
  sendRequest.mockResolvedValueOnce({ configured: true, last4: "1234", key } as {
    configured: boolean;
    last4: string;
  });
  await expect(client.request("oracle-main", { op: "mcpConnection" })).rejects.toThrow();
  expect(hubErrorText(new Error("mcp-auth"))).toBe("密钥无效或权限不足");
});
