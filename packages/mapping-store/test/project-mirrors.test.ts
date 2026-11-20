import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProjectMirrorRecord } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectMirrorRevisionConflictError,
  ProjectMirrorStore,
  projectMirrorsFilePath,
} from "../src/project-mirrors.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-project-mirrors-"));
  temporaryDirectories.push(directory);
  return directory;
}

function mirror(label = "demo"): ProjectMirrorRecord {
  return {
    hostId: "remote-ssh-discovered:colab",
    remoteProjectId: "0b0d55f6-9b60-4a5b-8ac8-86d3f0bd1a8c",
    remotePath: `/root/Documents/ChatGPT/${label}`,
    label,
    createdAt: "2026-11-12T03:00:00.000Z",
    updatedAt: "2026-11-12T03:00:00.000Z",
  };
}

describe("Project mirror store", () => {
  it("starts empty and persists mirrors", async () => {
    const directory = await temporaryDirectory();
    const store = new ProjectMirrorStore({ directory });
    await expect(store.list()).resolves.toEqual({
      formatVersion: 1,
      revision: 0,
      projects: {},
    });

    const written = await store.upsert(0, "local-alpha", { record: mirror() });
    expect(written.projects["local-alpha"]).toMatchObject({ label: "demo" });
    await expect(store.list()).resolves.toEqual(written);

    const file = JSON.parse(await readFile(projectMirrorsFilePath(directory), "utf8"));
    expect(file).toEqual(written);
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("updates and removes a mirror", async () => {
    const directory = await temporaryDirectory();
    const store = new ProjectMirrorStore({ directory });
    await store.upsert(0, "local-alpha", { record: mirror() });

    const updated = await store.upsert(1, "local-alpha", { record: mirror("demo 2") });
    expect(updated.projects["local-alpha"]?.label).toBe("demo 2");

    const removed = await store.upsert(2, "local-alpha", { record: null });
    expect(removed.projects).toEqual({});
  });

  it("rejects a stale revision instead of overwriting another window", async () => {
    const directory = await temporaryDirectory();
    const store = new ProjectMirrorStore({ directory });
    await store.upsert(0, "local-alpha", { record: mirror() });

    await expect(store.upsert(0, "local-alpha", { record: mirror() })).rejects.toBeInstanceOf(
      ProjectMirrorRevisionConflictError,
    );
  });

  it("still reads a registry written by the confirmed-mirror version", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      projectMirrorsFilePath(directory),
      JSON.stringify({
        formatVersion: 1,
        revision: 4,
        projects: { "local-alpha": mirror() },
        acknowledged: { "local-alpha": true },
      }),
      "utf8",
    );
    const store = new ProjectMirrorStore({ directory });

    await expect(store.list()).resolves.toMatchObject({
      revision: 4,
      projects: { "local-alpha": { label: "demo" } },
    });
    const written = await store.upsert(4, "local-alpha", { record: mirror("demo 2") });
    expect(written).toEqual({
      formatVersion: 1,
      revision: 5,
      projects: { "local-alpha": mirror("demo 2") },
    });
  });

  it("quarantines an invalid file and continues with an empty registry", async () => {
    const directory = await temporaryDirectory();
    await writeFile(projectMirrorsFilePath(directory), "{not json", "utf8");
    const store = new ProjectMirrorStore({ directory, now: () => new Date(1_800_000_000_000) });

    await expect(store.list()).resolves.toEqual({
      formatVersion: 1,
      revision: 0,
      projects: {},
    });
    expect(store.takeQuarantine()).toBe("mirrors.json.1800000000000.invalid");
  });
});
