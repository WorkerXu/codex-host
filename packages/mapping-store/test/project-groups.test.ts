import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProjectGroup } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectGroupRevisionConflictError,
  ProjectGroupStore,
  projectGroupsFilePath,
} from "../src/project-groups.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-project-groups-"));
  temporaryDirectories.push(directory);
  return directory;
}

function group(name = "Cross-host"): ProjectGroup {
  return {
    id: "5e5f0a4d-24bd-4af8-9e8e-2e7f2f8d4a1b",
    name,
    order: 0,
    collapsed: false,
    members: [
      {
        projectKind: "local",
        projectId: "local-alpha",
        rootPaths: ["/Users/test/alpha"],
        label: "alpha",
      },
    ],
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
  };
}

describe("Project group store", () => {
  it("starts empty and persists a revisioned file", async () => {
    const directory = await temporaryDirectory();
    const store = new ProjectGroupStore({ directory });
    await expect(store.list()).resolves.toEqual({
      formatVersion: 1,
      revision: 0,
      groups: [],
    });

    const written = await store.replace(0, [group()]);
    expect(written).toMatchObject({ revision: 1, groups: [{ name: "Cross-host" }] });
    await expect(store.list()).resolves.toEqual(written);

    const file = JSON.parse(await readFile(projectGroupsFilePath(directory), "utf8"));
    expect(file).toEqual(written);
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("rejects a stale revision instead of overwriting another window", async () => {
    const directory = await temporaryDirectory();
    const store = new ProjectGroupStore({ directory });
    await store.replace(0, [group()]);
    await expect(store.replace(0, [group("New name")])).rejects.toBeInstanceOf(
      ProjectGroupRevisionConflictError,
    );
    await expect(store.list()).resolves.toMatchObject({
      revision: 1,
      groups: [{ name: "Cross-host" }],
    });
  });

  it("quarantines an invalid file and starts from an empty configuration", async () => {
    const directory = await temporaryDirectory();
    await writeFile(projectGroupsFilePath(directory), "{not json", "utf8");
    const store = new ProjectGroupStore({
      directory,
      now: () => new Date("2026-11-11T10:00:00.000Z"),
    });
    await expect(store.list()).resolves.toEqual({
      formatVersion: 1,
      revision: 0,
      groups: [],
    });
    expect(await readdir(directory)).toContain("groups.json.1794391200000.invalid");
  });

  it("rejects duplicate membership before writing", async () => {
    const directory = await temporaryDirectory();
    const store = new ProjectGroupStore({ directory });
    const duplicate = {
      ...group("Second"),
      id: "7f2e0d9b-1f20-4d4c-9d1f-8e6a4c3b2a10",
      order: 1,
    };
    await expect(store.replace(0, [group(), duplicate])).rejects.toThrow(/only one group/);
    await expect(store.list()).resolves.toMatchObject({ revision: 0, groups: [] });
  });
});
