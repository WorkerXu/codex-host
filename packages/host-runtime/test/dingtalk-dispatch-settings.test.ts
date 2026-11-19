import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultDingTalkDispatchSettings } from "@codexhost/shared-contracts";

import {
  DingTalkDispatchSettingsStore,
  type DingTalkDispatchAgent,
} from "../src/dingtalk-dispatch-settings.js";

const directories: string[] = [];

async function store(): Promise<DingTalkDispatchSettingsStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dingtalk-"));
  directories.push(directory);
  return new DingTalkDispatchSettingsStore({ homeDirectory: directory });
}

function agent(
  fileName: string,
  name: string,
  description = "Does the work.",
): DingTalkDispatchAgent {
  return { fileName, name, description };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DingTalkDispatchSettingsStore", () => {
  it("returns defaults with every agent off", async () => {
    const settings = await (await store()).read([agent("terra-worker.toml", "terra_worker")]);
    expect(settings).toEqual(defaultDingTalkDispatchSettings());
    expect(settings.agents).toEqual({});
  });

  it("writes 0600 JSON with only the manual settings", async () => {
    const settings = await store();
    const saved = await settings.write({
      agents: {
        "terra-worker.toml": {
          enabled: true,
          replyScope: "direct",
          sectionId: "section-1",
          projectId: "project-1",
          projectPath: "/Users/me/project",
        },
      },
    });
    expect(saved.agents["terra-worker.toml"]?.enabled).toBe(true);
    expect(await settings.read([agent("terra-worker.toml", "terra_worker")])).toEqual(saved);
    if (process.platform !== "win32") {
      expect((await stat(settings.filePath)).mode & 0o777).toBe(0o600);
    }
    const raw = JSON.parse(await readFile(settings.filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual(saved);
    expect(raw).not.toHaveProperty("threshold");
  });

  it("falls back to defaults for unreadable or invalid files", async () => {
    const settings = await store();
    await writeFile(settings.filePath, "{ not json");
    expect(await settings.read([agent("terra-worker.toml", "terra_worker")])).toEqual(
      defaultDingTalkDispatchSettings(),
    );
  });

  it("drops retired eventTypes/threshold from a current file and keeps enabled agents", async () => {
    const settings = await store();
    await writeFile(
      settings.filePath,
      JSON.stringify({
        threshold: 0.85,
        agents: {
          "reviewer.toml": {
            enabled: true,
            eventTypes: ["mention_me", "approval_pending"],
            replyScope: "direct",
          },
          "off.toml": {
            enabled: false,
            eventTypes: ["mention_all"],
            replyScope: "group",
          },
        },
      }),
    );
    const migrated = await settings.read([
      agent("reviewer.toml", "reviewer"),
      agent("off.toml", "off"),
    ]);
    expect(migrated).toEqual({
      agents: {
        "reviewer.toml": {
          enabled: true,
          replyScope: "direct",
          sectionId: null,
          projectId: null,
          projectPath: null,
        },
        "off.toml": {
          enabled: false,
          replyScope: "group",
          sectionId: null,
          projectId: null,
          projectPath: null,
        },
      },
    });
    const raw = JSON.parse(await readFile(settings.filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual(migrated);
  });

  it("migrates the old global switch into per-agent entries without event types", async () => {
    const settings = await store();
    await writeFile(
      settings.filePath,
      JSON.stringify({
        enabled: true,
        eventTypes: ["mention_me", "approval_pending"],
        matchThreshold: 0.9,
        replyScope: "direct",
        participatingAgents: ["reviewer"],
      }),
    );
    const migrated = await settings.read([
      agent("reviewer.toml", "reviewer"),
      agent("writer.toml", "writer"),
    ]);
    expect(migrated).toEqual({
      agents: {
        "reviewer.toml": {
          enabled: true,
          replyScope: "direct",
          sectionId: null,
          projectId: null,
          projectPath: null,
        },
      },
    });
    const raw = JSON.parse(await readFile(settings.filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual(migrated);
  });

  it("migrates an empty participant list into every agent with a description", async () => {
    const settings = await store();
    await writeFile(
      settings.filePath,
      JSON.stringify({
        enabled: true,
        eventTypes: ["mention_all"],
        matchThreshold: 0.8,
        replyScope: "group",
        participatingAgents: [],
      }),
    );
    const migrated = await settings.read([
      agent("reviewer.toml", "reviewer"),
      agent("bare.toml", "bare", "  "),
    ]);
    expect(Object.keys(migrated.agents)).toEqual(["reviewer.toml"]);
    expect(migrated.agents["reviewer.toml"]).toMatchObject({
      enabled: true,
      replyScope: "group",
    });
  });

  it("keeps every agent off when the old global switch was off", async () => {
    const settings = await store();
    await writeFile(
      settings.filePath,
      JSON.stringify({
        enabled: false,
        eventTypes: ["mention_me"],
        matchThreshold: 0.85,
        replyScope: "group",
        participatingAgents: ["reviewer"],
      }),
    );
    expect(await settings.read([agent("reviewer.toml", "reviewer")])).toEqual({
      agents: {},
    });
  });

  it("drops entries for agents that no longer exist and persists the prune", async () => {
    const settings = await store();
    await settings.write({
      agents: {
        "old.toml": {
          enabled: true,
          replyScope: "group",
          sectionId: "s",
          projectId: "p",
          projectPath: "/tmp/p",
        },
      },
    });
    const pruned = await settings.read([agent("new.toml", "new")]);
    expect(pruned.agents).toEqual({});
    const raw = JSON.parse(await readFile(settings.filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({ agents: {} });
  });

  it("keeps entries when the agent list could not be read", async () => {
    const settings = await store();
    const saved = await settings.write({
      agents: {
        "old.toml": {
          enabled: true,
          replyScope: "group",
          sectionId: null,
          projectId: null,
          projectPath: null,
        },
      },
    });
    expect(await settings.read(null)).toEqual(saved);
  });

  it("rejects settings the dispatch contract cannot represent", async () => {
    const settings = await store();
    await expect(
      settings.write({
        agents: {
          "bad.toml": {
            enabled: "yes" as unknown as boolean,
            replyScope: "group",
            sectionId: null,
            projectId: null,
            projectPath: null,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});
