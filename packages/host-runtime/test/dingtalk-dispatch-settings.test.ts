import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DINGTALK_DISPATCH_SETTINGS,
  defaultDingTalkDispatchSettings,
} from "@codexhost/shared-contracts";

import { DingTalkDispatchSettingsStore } from "../src/dingtalk-dispatch-settings.js";

const directories: string[] = [];

async function store(): Promise<DingTalkDispatchSettingsStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dingtalk-"));
  directories.push(directory);
  return new DingTalkDispatchSettingsStore({ homeDirectory: directory });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DingTalkDispatchSettingsStore", () => {
  it("returns defaults seeded with agents that have descriptions", async () => {
    const settings = await (await store()).read(["terra_worker", "reviewer"]);
    expect(settings).toEqual(defaultDingTalkDispatchSettings(["terra_worker", "reviewer"]));
    expect(settings.enabled).toBe(false);
    expect(settings.matchThreshold).toBe(0.85);
    expect(settings.replyScope).toBe("group");
    expect(settings.eventTypes).toEqual(DEFAULT_DINGTALK_DISPATCH_SETTINGS.eventTypes);
  });

  it("writes 0600 JSON and reads it back", async () => {
    const settings = await store();
    const saved = await settings.write({
      enabled: true,
      eventTypes: ["mention_me", "approval_pending"],
      matchThreshold: 0.9,
      replyScope: "direct",
      participatingAgents: ["terra_worker"],
    });
    expect(saved.enabled).toBe(true);
    expect(await settings.read(["ignored"])).toEqual(saved);
    if (process.platform !== "win32") {
      expect((await stat(settings.filePath)).mode & 0o777).toBe(0o600);
    }
    const raw = JSON.parse(await readFile(settings.filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({ enabled: true, matchThreshold: 0.9, replyScope: "direct" });
  });

  it("falls back to defaults for unreadable or invalid files", async () => {
    const settings = await store();
    await settings.write({
      enabled: true,
      eventTypes: ["mention_me"],
      matchThreshold: 0.7,
      replyScope: "group",
      participatingAgents: [],
    });
    await writeFile(settings.filePath, "{ not json");
    expect(await settings.read(["terra_worker"])).toEqual(
      defaultDingTalkDispatchSettings(["terra_worker"]),
    );
  });

  it("rejects settings the dispatch contract cannot represent", async () => {
    const settings = await store();
    await expect(
      settings.write({
        enabled: true,
        eventTypes: ["mention_me"],
        matchThreshold: 1.5,
        replyScope: "group",
        participatingAgents: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});
