import {
  FORK_SELF_UPDATE_DISABLED_MESSAGE,
  FORK_SELF_UPDATE_ENABLED,
} from "@codexhost/shared-contracts/fork-self-update";
import { expect, it, vi } from "vitest";
import { RuntimeMaintenance } from "../src/runtime-maintenance.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

it.skipIf(FORK_SELF_UPDATE_ENABLED)(
  "rejects Host install and upgrade RPCs before handing work to an updater",
  async () => {
    const updateCoordinator = { check: vi.fn(), start: vi.fn(), status: vi.fn() };
    const runtimeMaintenance = new RuntimeMaintenance({
      runtimePath: "/missing/runtime.mjs",
      remote: false,
      environment: {},
    });
    const fixture = createFixture({ updateCoordinator, runtimeMaintenance });
    try {
      await fixture.ready;
      const calls = [
        { method: "codexhost/update/check", params: {} },
        { method: "codexhost/update/start", params: {} },
        { method: "codexhost/remote/update", params: { version: "0.25.2" } },
        ...["update", "install"].map((action) => ({
          method: "codexhost/remote/ssh-setup",
          params: { hostname: "fixture", port: null, identity: null, action, version: "0.25.2" },
        })),
      ];
      for (const [id, request] of calls.entries()) {
        writeRequest(fixture.desktopInput, { id, ...request });
        expect(await fixture.collector.waitFor((message) => requestId(message, id))).toMatchObject({
          error: { code: -32090, message: FORK_SELF_UPDATE_DISABLED_MESSAGE },
        });
      }
      expect(updateCoordinator.check).not.toHaveBeenCalled();
      expect(updateCoordinator.start).not.toHaveBeenCalled();
      expect(runtimeMaintenance.blocked).toBe(false);
    } finally {
      await stopFixture(fixture);
    }
  },
);
