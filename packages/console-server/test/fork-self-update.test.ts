import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FORK_SELF_UPDATE_DISABLED_MESSAGE,
  FORK_SELF_UPDATE_ENABLED,
} from "@codexhost/shared-contracts/fork-self-update";
import { expect, it, vi } from "vitest";
import { consolePaths } from "../src/paths.js";
import { startConsoleServer } from "../src/server.js";
import { updateFromCommand } from "../src/update-cli.js";

it.skipIf(FORK_SELF_UPDATE_ENABLED)(
  "refuses Console HTTP updates before contacting an older Host or the local updater",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexhost-console-self-update-"));
    const host = { available: vi.fn(async () => true), request: vi.fn() };
    const updates = { check: vi.fn(), status: vi.fn(), start: vi.fn() };
    const announcement = { title: "Release notice", type: "info" as const, body: "Fixture notice" };
    const server = await startConsoleServer({
      port: 0,
      version: "0.25.1",
      installation: { appDirectory: directory, distribution: null, launcherExecutable: null },
      paths: consolePaths({ CODEXHOST_DATA_DIR: directory }),
      updates,
      host,
      announcement: async () => announcement,
      harnesses: { list: vi.fn(), setLaunchPath: vi.fn() },
      pageScript: "",
      onExit() {},
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const post = (path: string, body = {}) =>
        fetch(url + path, {
          method: "POST",
          headers: { "x-codexhost-console": "1", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const start = await post("/api/update/start");
      expect(start.status).toBe(403);
      expect(await start.json()).toEqual({ error: FORK_SELF_UPDATE_DISABLED_MESSAGE });
      const forwarded = await post("/api/host/request", {
        method: "codexhost/update/start",
        params: {},
      });
      expect(forwarded.status).toBe(403);
      expect(host.request).not.toHaveBeenCalled();
      expect(updates.start).not.toHaveBeenCalled();
      expect(await (await fetch(url + "/api/announcement")).json()).toEqual(announcement);
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(FORK_SELF_UPDATE_ENABLED)(
  "rejects the Console update command before resolving an installation",
  async () => {
    await expect(updateFromCommand("/no-installation", [])).rejects.toThrow(
      FORK_SELF_UPDATE_DISABLED_MESSAGE,
    );
  },
);
