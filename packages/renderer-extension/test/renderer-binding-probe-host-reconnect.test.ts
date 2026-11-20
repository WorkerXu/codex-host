// @vitest-environment jsdom
import { assert, expect, it, vi } from "vitest";

import { installRendererBindingProbe } from "../src/renderer-binding-probe.js";
import {
  createRendererModelClient,
  HARNESS_INSPECT_METHOD,
  HARNESS_PLUGIN_LIST_METHOD,
} from "../src/renderer-model-client.js";

function hostClient(isReady: () => boolean) {
  const client = createRendererModelClient([
    {
      async sendRequest(method: string) {
        if (method === HARNESS_PLUGIN_LIST_METHOD) {
          if (!isReady()) throw new Error("Host is loading its plugins");
          return { plugins: [{ id: "pi", name: "Pi", version: "1" }] };
        }
        if (method === HARNESS_INSPECT_METHOD) {
          return {
            status: "ready",
            catalog: { models: [], thinkingOptions: [] },
            capabilities: {
              configuration: {
                selectModel: false,
                selectThinkingOption: false,
                selectPermissionMode: false,
                permissionModeScope: "live",
              },
              history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
            },
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    },
  ]);
  assert(client);
  return client;
}

it("recovers an active Host after both the short retries and a reconnected directory probe fail", async () => {
  const hostId = "remote-ssh-discovered:linux";
  let connected = false;
  let ready = false;
  const local = hostClient(() => true);
  const remote = hostClient(() => ready);
  vi.useFakeTimers();
  const probe = installRendererBindingProbe({ enabledAgents: ["codex", "pi"] });
  try {
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      {
        ...local,
        currentHostId: () => hostId,
        clientForHost: (id) => (id === "local" ? local : connected ? remote : null),
      },
    );
    await probe.refreshHarnessDirectory(hostId);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(probe.harnessDirectory(hostId)).toMatchObject({
      error: expect.stringContaining("unavailable"),
    });
    connected = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe.harnessDirectory(hostId)).toMatchObject({
      error: "Host is loading its plugins",
    });
    ready = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(probe.harnessDirectory(hostId)).toMatchObject({
      error: null,
      availability: { pi: "ready" },
    });
  } finally {
    probe.dispose();
    vi.useRealTimers();
  }
});
