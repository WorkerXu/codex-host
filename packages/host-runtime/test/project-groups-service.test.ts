import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProjectGroup } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopProjectCatalogError,
  DesktopProjectCatalogReader,
} from "../src/desktop-project-catalog.js";
import {
  ProjectGroupsService,
  ProjectGroupRevisionConflictError,
} from "../src/project-groups-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-project-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
}

function stateFile(): Record<string, unknown> {
  return {
    "local-projects": {
      "local-alpha": {
        id: "local-alpha",
        name: "alpha",
        rootPaths: ["/Users/test/alpha"],
        createdAt: 1,
        updatedAt: 2,
      },
    },
    "remote-projects": [
      {
        id: "project-beta",
        hostId: "remote-ssh-discovered:beta",
        remotePath: "/srv/beta",
        label: "beta",
      },
    ],
    "thread-project-assignments": {
      "thread-1": { projectKind: "remote", projectId: "project-beta" },
    },
    "codex-managed-remote-connections": [
      {
        hostId: "remote-ssh-discovered:beta",
        displayName: "beta",
        alias: "beta",
        hostname: null,
        source: "discovered",
        identity: "/secret/key",
      },
    ],
    "project-order": ["local-alpha", "project-beta"],
  };
}

function group(): ProjectGroup {
  return {
    id: "5e5f0a4d-24bd-4af8-9e8e-2e7f2f8d4a1b",
    name: "Cross-host",
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

describe("Desktop project catalog reader", () => {
  it("projects the four target keys and drops connection identity", async () => {
    const codexHome = await temporaryDirectory();
    await writeFile(
      path.join(codexHome, ".codex-global-state.json"),
      JSON.stringify(stateFile()),
      "utf8",
    );
    const catalog = await new DesktopProjectCatalogReader({
      codexHome,
      cacheTtlMs: 0,
      now: () => new Date("2026-11-11T10:00:00.000Z"),
    }).read();
    expect(catalog.localProjects["local-alpha"]).toMatchObject({ name: "alpha" });
    expect(catalog.remoteProjects[0]).toMatchObject({ hostId: "remote-ssh-discovered:beta" });
    expect(catalog.threadProjectAssignments["thread-1"]).toEqual({
      projectKind: "remote",
      projectId: "project-beta",
    });
    expect(catalog.codexManagedRemoteConnections[0]).toEqual({
      hostId: "remote-ssh-discovered:beta",
      displayName: "beta",
      alias: "beta",
      hostname: null,
      source: "discovered",
    });
    expect(catalog.projectOrder).toEqual(["local-alpha", "project-beta"]);
  });

  it("falls back to the persisted atom bucket", async () => {
    const codexHome = await temporaryDirectory();
    await writeFile(
      path.join(codexHome, ".codex-global-state.json"),
      JSON.stringify({ "electron-persisted-atom-state": stateFile() }),
      "utf8",
    );
    const catalog = await new DesktopProjectCatalogReader({
      codexHome,
      cacheTtlMs: 0,
      now: () => new Date("2026-11-11T10:00:00.000Z"),
    }).read();
    expect(catalog.localProjects["local-alpha"]).toBeDefined();
  });

  it("reports invalid state without exposing file contents", async () => {
    const codexHome = await temporaryDirectory();
    await writeFile(path.join(codexHome, ".codex-global-state.json"), "{broken", "utf8");
    await expect(
      new DesktopProjectCatalogReader({ codexHome, retryDelayMs: 0 }).read(),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("reports a missing file as unavailable", async () => {
    const codexHome = await temporaryDirectory();
    await expect(new DesktopProjectCatalogReader({ codexHome }).read()).rejects.toBeInstanceOf(
      DesktopProjectCatalogError,
    );
  });
});

describe("Project groups service", () => {
  it("reports a quarantined config once", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "groups.json"), "{broken", "utf8");
    const service = new ProjectGroupsService({
      directory,
      now: () => new Date("2026-11-11T11:00:00.000Z"),
    });
    await expect(service.list()).resolves.toMatchObject({
      revision: 0,
      groups: [],
      warning: { kind: "quarantined", backupName: "groups.json.1794394800000.invalid" },
    });
    await expect(service.list()).resolves.toEqual({ revision: 0, groups: [] });
  });

  it("persists revisions and refreshes updatedAt", async () => {
    const directory = await temporaryDirectory();
    const codexHome = await temporaryDirectory();
    await writeFile(
      path.join(codexHome, ".codex-global-state.json"),
      JSON.stringify(stateFile()),
      "utf8",
    );
    const service = new ProjectGroupsService({
      directory,
      codexHome,
      now: () => new Date("2026-11-11T11:00:00.000Z"),
      catalogCacheTtlMs: 0,
    });
    const written = await service.replace({ revision: 0, groups: [group()] });
    expect(written).toMatchObject({
      revision: 1,
      groups: [{ updatedAt: "2026-11-11T11:00:00.000Z" }],
    });
    await expect(service.list()).resolves.toEqual(written);
    await expect(service.replace({ revision: 0, groups: [group()] })).rejects.toBeInstanceOf(
      ProjectGroupRevisionConflictError,
    );
    await expect(service.readDesktopCatalog()).resolves.toMatchObject({
      projectOrder: ["local-alpha", "project-beta"],
    });
  });
});
