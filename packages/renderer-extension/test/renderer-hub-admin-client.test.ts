import { expect, it, vi } from "vitest";
import { HUB_ADMIN_METHOD } from "@codexhost/shared-contracts";
import { createRendererHubAdminClient, hubErrorText } from "../src/renderer-hub-admin-client.js";
it("routes each call through the selected host and never falls back to local", async () => {
  const sendRequest = vi.fn(async () => ({ servers: [] }));
  const forHost = vi.fn((id: string) => (id === "ssh:india" ? { manager: { sendRequest } } : null));
  const client = createRendererHubAdminClient({
    forHost,
    listHosts: async () => [{ hostId: "ssh:india", displayName: "india" }],
  });
  await expect(client.request("ssh:india", { op: "servers" })).resolves.toEqual({ servers: [] });
  expect(sendRequest).toHaveBeenCalledWith(
    HUB_ADMIN_METHOD,
    { op: "servers" },
    { priority: "interactive", timeoutMs: 20000 },
  );
  await expect(client.request("oracle-main", { op: "overview" })).rejects.toThrow("connection");
  expect(sendRequest).toHaveBeenCalledTimes(1);
  expect(forHost.mock.calls.map(([id]) => id)).toEqual(["ssh:india", "oracle-main"]);
});
it("localizes stable codes and hides raw errors", () => {
  expect(hubErrorText(new Error("forbidden"))).toBe("无权限");
  expect(hubErrorText(new Error("timeout"))).toBe("连接超时");
  expect(hubErrorText(new Error("secret in upstream error"))).toBe("连接失败");
});
